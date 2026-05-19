"""Classify Drive Docs / Slides / PDFs → `quadrant.quadrant_signals`.

Reads from `quadrant.drive_documents_raw` (populated by `app.drive_ingest`)
and calls Gemini Flash to extract structured signals from each document's
body_text. MERGE-upserts results into `quadrant.quadrant_signals`.

Counterpart to `sql/11_classifier_drive_sheets.sql`. Sheets classify via
deterministic SQL rules (their content is structured); Docs/PDFs need LLM
extraction because the signal is buried in prose.

Run:
    cd quadrant
    uv run python -m app.classify_drive_documents

Re-runnable. MERGE on `signal_id = drive_doc:<file_id>` makes it idempotent.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

import google.auth
from google import genai
from google.cloud import bigquery
from google.genai import types
from pydantic import BaseModel, Field

_, _PROJECT_ID = google.auth.default()
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", _PROJECT_ID)
os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "global")
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")

_BQ = bigquery.Client(project=_PROJECT_ID)
_GENAI = genai.Client()

_RAW_TABLE = f"{_PROJECT_ID}.quadrant.drive_documents_raw"
_SIGNALS_TABLE = f"{_PROJECT_ID}.quadrant.quadrant_signals"
_STAGE_TABLE = f"{_PROJECT_ID}.quadrant._drive_doc_signals_stage"
_MODEL = "gemini-3-flash-preview"
_USER_ID = "demo_user"

log = logging.getLogger(__name__)


# ---------- Extraction schema (what Gemini must return per doc) ----------


class DocSignal(BaseModel):
    title: str = Field(
        description="Short title summarizing the document or thread (5-12 words)."
    )
    excerpt: str = Field(
        description="One sentence capturing the core ask or content (<=200 chars)."
    )
    quadrant: Literal["health", "education", "career", "relationships"] = Field(
        description=(
            "Life quadrant. 'career' = work / project / business / admin. "
            "'relationships' = personal / social / family / friends. "
            "'health' = medical / fitness / sleep. "
            "'education' = learning / reading / courses. "
            "Default to 'career' when uncertain."
        )
    )
    deadline_date: str = Field(
        description=(
            "ISO date (YYYY-MM-DD) — the date the user should engage with "
            "this signal. NEVER null; every signal must have a date. "
            "Priority order: "
            "(1) If a deadline is LITERALLY stated in the document, use it. "
            "(2) If a casual/social date is proposed ('Saturday brunch', "
            "'next Tuesday'), resolve it to a concrete ISO date relative to "
            "today. "
            "(3) Otherwise INFER a reasonable engage-by date based on "
            "content type and urgency cues (see guidance)."
        ),
    )
    deadline_is_explicit: bool = Field(
        description=(
            "True if deadline_date was literally stated in the document. "
            "False if you inferred it from content type / urgency / proposed times."
        ),
    )
    urgency: Literal["high", "medium", "low"] = Field(
        description=(
            "Time-sensitivity. 'high' = deadline within 7 days OR multiple "
            "ignored follow-ups OR explicit URGENT framing. 'medium' = "
            "deadline within 30 days OR one follow-up. 'low' = no deadline, "
            "or article/reference content saved for later."
        )
    )
    importance: Literal["high", "medium", "low"] = Field(
        description=(
            "How much this matters to the user's actual goals/well-being, "
            "independent of urgency. 'high' = project-critical, job-critical, "
            "or health-critical. 'medium' = default. 'low' = admin chore or "
            "pure social/optional."
        )
    )
    valence: Literal["positive", "neutral", "negative"] = Field(
        description=(
            "Tone. 'positive' = warm/friendly. 'negative' = pressure / "
            "escalation / bad news. 'neutral' otherwise."
        )
    )
    contact_email: str | None = Field(
        default=None,
        description=(
            "Email of the OTHER party (not the user). Parse from From/To "
            "headers in email-style docs. Null if no contact identifiable."
        ),
    )
    contact_name: str | None = Field(
        default=None,
        description="Name of the other party from signature/header. Null if unknown.",
    )
    reasoning: str = Field(
        description="One short sentence: why this classification."
    )


_PROMPT_TEMPLATE = """\
You are classifying a Google Drive document for an ADHD-shaped productivity \
agent. The user offloads to-dos and follow-ups across Docs (email-style \
threads), PDFs (contracts, articles), and Slides. Your job is to read ONE \
document and extract a structured signal: what is this, when does it matter, \
who is involved, how urgent, how important.

Today's date is {today}. Use it to judge urgency relative to any deadlines.

Document name: {name}
Mime type: {mime_type}
Last modified: {modified_time}

--- BODY ---
{body}
--- END BODY ---

Guidance:
- For email-style docs, the user is the recipient (appears repeatedly in To/From). \
The contact is the OTHER party — the one writing to the user.
- Multiple ignored messages, escalating tone, or "past due" framing → high urgency.
- Articles or reading material saved for later (no recipient, no deadline) → \
urgency='low', importance often='medium' (it's something the user cared about \
saving but didn't act on — drift signal).
- Contracts with signature deadlines → urgency tracks how close the deadline is.
- Casual invitations or social plans without an explicit RSVP-by date \
("no rush", "lmk whenever", "sometime", "if you want") are urgency='low' \
regardless of how soon the proposed time is. The 7-day rule applies to \
STATED deadlines, NOT proposed casual times.

Date inference rules (deadline_date is ALWAYS required):
- If a date is literally written ("by Friday May 15", "due 2026-06-12") → \
use it, set deadline_is_explicit=true.
- If a casual/social date is proposed ("brunch Saturday", "next Tuesday") → \
resolve to a concrete ISO date relative to today, set deadline_is_explicit=false.
- If multiple ignored follow-ups → engage_by = today + 1 day, \
deadline_is_explicit=false.
- If a one-time response is needed but tone is calm → today + 3 days, \
deadline_is_explicit=false.
- If saved article / reference / drift content with no deadline → use \
{this_week_end} (this Sunday, end of the current week — keeps the item in \
the user's current-week view), deadline_is_explicit=false.
- If a future event is being scheduled (RSVP, meeting prep) → use the event date \
itself as engage_by, deadline_is_explicit=false.
- NEVER return null for deadline_date. NEVER return today's date unless the \
deadline is literally today.
"""


# ---------- Pipeline ----------


def _classify_one(row: bigquery.Row) -> DocSignal:
    today_dt = datetime.now(timezone.utc).date()
    # End of this week = upcoming Sunday. weekday(): Mon=0, Sun=6.
    days_until_sunday = (6 - today_dt.weekday()) % 7
    if days_until_sunday == 0:
        days_until_sunday = 7  # today is Sunday — push to next Sunday
    this_week_end = (today_dt + timedelta(days=days_until_sunday)).isoformat()
    prompt = _PROMPT_TEMPLATE.format(
        today=today_dt.isoformat(),
        this_week_end=this_week_end,
        name=row["name"],
        mime_type=row["mime_type"],
        modified_time=row["modified_time"],
        body=(row["body_text"] or "(empty document)")[:12000],
    )
    resp = _GENAI.models.generate_content(
        model=_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=DocSignal,
            temperature=0.0,
        ),
    )
    return DocSignal.model_validate_json(resp.text)


_LEVEL_TO_WEIGHT = {"high": 0.9, "medium": 0.5, "low": 0.3}


def _weight_for(sig: DocSignal) -> float:
    return round((_LEVEL_TO_WEIGHT[sig.urgency] + _LEVEL_TO_WEIGHT[sig.importance]) / 2, 2)


def _occurred_at(sig: DocSignal, _raw: bigquery.Row) -> str:
    # LLM is required to always produce deadline_date — explicit when literal,
    # inferred otherwise. So this is unconditional; no modified_time fallback.
    return f"{sig.deadline_date}T00:00:00+00:00"


def _to_signal_row(raw: bigquery.Row, sig: DocSignal) -> dict:
    return {
        "signal_id": f"drive_doc:{raw['file_id']}",
        "user_id": _USER_ID,
        "source": "google_drive_doc",
        "source_record_id": raw["file_id"],
        "occurred_at": _occurred_at(sig, raw),
        "quadrant": sig.quadrant,
        "quadrant_secondary": None,
        "weight": _weight_for(sig),
        "valence": sig.valence,
        "title": sig.title,
        "excerpt": sig.excerpt[:200],
        "participants": [sig.contact_email] if sig.contact_email else None,
        "metadata": json.dumps(
            {
                "name": raw["name"],
                "mime_type": raw["mime_type"],
                "deadline_date": sig.deadline_date,
                "deadline_is_explicit": sig.deadline_is_explicit,
                "urgency": sig.urgency,
                "importance": sig.importance,
                "contact_name": sig.contact_name,
                "contact_email": sig.contact_email,
                "reasoning": sig.reasoning,
            }
        ),
        "classified_by": "llm",
        "classified_ref_id": f"{_MODEL}:drive_doc_v1",
        "ingested_at": datetime.now(timezone.utc).isoformat(),
    }


_SIGNALS_SCHEMA = [
    bigquery.SchemaField("signal_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("user_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("source", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("source_record_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("occurred_at", "TIMESTAMP", mode="REQUIRED"),
    bigquery.SchemaField("quadrant", "STRING"),
    bigquery.SchemaField("quadrant_secondary", "STRING"),
    bigquery.SchemaField("weight", "FLOAT64", mode="REQUIRED"),
    bigquery.SchemaField("valence", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("title", "STRING"),
    bigquery.SchemaField("excerpt", "STRING"),
    bigquery.SchemaField("participants", "STRING", mode="REPEATED"),
    bigquery.SchemaField("metadata", "JSON"),
    bigquery.SchemaField("classified_by", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("classified_ref_id", "STRING"),
    bigquery.SchemaField("ingested_at", "TIMESTAMP", mode="REQUIRED"),
]


def _upsert(rows: list[dict]) -> None:
    if not rows:
        return

    load_job = _BQ.load_table_from_json(
        rows,
        _STAGE_TABLE,
        job_config=bigquery.LoadJobConfig(
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            schema=_SIGNALS_SCHEMA,
        ),
    )
    load_job.result()

    _BQ.query(
        f"""
        MERGE `{_SIGNALS_TABLE}` T
        USING `{_STAGE_TABLE}` S
        ON T.signal_id = S.signal_id
        WHEN MATCHED THEN UPDATE SET
          occurred_at        = S.occurred_at,
          quadrant           = S.quadrant,
          quadrant_secondary = S.quadrant_secondary,
          weight             = S.weight,
          valence            = S.valence,
          title              = S.title,
          excerpt            = S.excerpt,
          participants       = S.participants,
          metadata           = S.metadata,
          classified_by      = S.classified_by,
          classified_ref_id  = S.classified_ref_id,
          ingested_at        = S.ingested_at
        WHEN NOT MATCHED THEN
          INSERT (signal_id, user_id, source, source_record_id, occurred_at,
                  quadrant, quadrant_secondary, weight, valence,
                  title, excerpt, participants, metadata,
                  classified_by, classified_ref_id, ingested_at)
          VALUES (S.signal_id, S.user_id, S.source, S.source_record_id, S.occurred_at,
                  S.quadrant, S.quadrant_secondary, S.weight, S.valence,
                  S.title, S.excerpt, S.participants, S.metadata,
                  S.classified_by, S.classified_ref_id, S.ingested_at)
        """
    ).result()

    _BQ.query(f"DROP TABLE `{_STAGE_TABLE}`").result()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )

    # Only classify NEW or CHANGED docs. Already-analyzed docs whose
    # modified_time hasn't moved forward keep their stored analysis —
    # rollover_signals handles date updates without burning Gemini cycles.
    raws = list(
        _BQ.query(
            f"""
            SELECT r.file_id, r.name, r.mime_type, r.modified_time, r.body_text
            FROM `{_RAW_TABLE}` r
            LEFT JOIN `{_SIGNALS_TABLE}` s
              ON s.signal_id = CONCAT('drive_doc:', r.file_id)
            WHERE r.body_text IS NOT NULL AND LENGTH(r.body_text) > 0
              AND (
                s.signal_id IS NULL
                OR r.modified_time > s.ingested_at
              )
            """
        ).result()
    )
    log.info("Classifying %d new/changed documents", len(raws))

    rows: list[dict] = []
    for r in raws:
        try:
            sig = _classify_one(r)
            rows.append(_to_signal_row(r, sig))
            log.info(
                "  %s → %s deadline=%s(%s) u=%s i=%s val=%s w=%.2f",
                r["name"],
                sig.quadrant,
                sig.deadline_date,
                "explicit" if sig.deadline_is_explicit else "inferred",
                sig.urgency,
                sig.importance,
                sig.valence,
                _weight_for(sig),
            )
        except Exception as exc:
            log.warning("  %s FAILED: %s", r["name"], exc)

    _upsert(rows)
    log.info("Upserted %d signals into %s", len(rows), _SIGNALS_TABLE)

    # Auto-draft proposed actions so the user lands on a populated plan, not
    # an empty dashboard. Skips signals already referenced by an action.
    from app.auto_draft_actions import run as auto_draft_run

    n_drafted = auto_draft_run()
    log.info("Auto-drafted %d actions into quadrant.proposed_actions", n_drafted)


if __name__ == "__main__":
    main()
