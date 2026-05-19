"""Auto-draft proposed actions from un-actioned signals.

When the user lands on the dashboard, the action plan should already be
there — they shouldn't have to invoke the agent from the chat dock to get
a draft per signal. This module runs at the end of the drive pipeline,
scans `quadrant.quadrant_signals` for un-actioned rows, calls Gemini to
draft an action per signal, and inserts into `quadrant.proposed_actions`
with status='drafted'.

Two action types:

- **email_draft** — when the signal has an email contact in
  `participants[0]`. Drafts a reply / follow-up to that person.
- **calendar_event** — when the signal has no email contact (e.g., a saved
  article, a self-assigned task). Drafts a calendar block to engage with
  the thing so the drift doesn't continue.

Calendar-source signals (yoga, swim, etc.) are excluded — those are
already on the calendar, no second action needed.

Idempotent: skips signals already referenced by an action.

Run standalone:
    cd quadrant
    uv run python -m app.auto_draft_actions

Auto-invoked at the end of `app.classify_drive_documents`.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
import zoneinfo
from datetime import datetime, timedelta, timezone

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
_MODEL = "gemini-3-flash-preview"
_USER_ID = "demo_user"
_SIGNALS_TABLE = f"{_PROJECT_ID}.quadrant.quadrant_signals"
_ACTIONS_TABLE = f"{_PROJECT_ID}.quadrant.proposed_actions"
_DAILY_PLAN_TABLE = f"{_PROJECT_ID}.quadrant.daily_plan_v1"

# Draft for every un-actioned signal. The UI lets the user reject anything
# that doesn't feel right, so erring toward more drafts is preferable to
# leaving quadrants empty.
_WEIGHT_THRESHOLD = 0.0

# Calendar-source signals are already on the calendar; no need to draft a
# second action for them. We do auto-draft for Drive-derived signals.
_SOURCES = ("google_drive_doc", "google_drive_sheet")

# Demo defaults for the calendar_event branch — tomorrow morning in PT.
# The user can move the block in the UI when they approve.
_DEMO_TZ = zoneinfo.ZoneInfo("America/Los_Angeles")

log = logging.getLogger(__name__)


# ---------- Gemini extraction schemas ----------


class DraftedEmail(BaseModel):
    subject: str = Field(
        description=(
            "Email subject line. ~10 words. If the source signal is an "
            "email-style thread, mirror its subject with 'Re: ...'."
        )
    )
    body: str = Field(
        description=(
            "Email body. 2-4 sentences. Direct, warm, no corporate filler. "
            "Acknowledge any deadline the source signal mentions and make a "
            "concrete commitment when possible."
        )
    )
    reasoning: str = Field(
        description="One sentence on why drafting this helps the user."
    )


class Fragment(BaseModel):
    percent: int = Field(
        description=(
            "Percentage of the parent task this fragment represents (1-100). "
            "Sums across all fragments should equal 100. Use even splits "
            "when no content imbalance suggests otherwise (5 days = 5×20%, "
            "3 days = 33+33+34, etc.)."
        ),
        ge=1,
        le=100,
    )
    duration_min: int = Field(
        description=(
            "Length of THIS fragment's sitting in minutes (15-45 typical). "
            "Should be proportional to `percent`."
        ),
        ge=15,
        le=60,
    )
    day_offset: int = Field(
        description=(
            "0 = today, 1 = tomorrow, … . Spread fragments across the days "
            "between today and the parent task's deadline. The LAST "
            "fragment should land on or before that deadline."
        ),
        ge=0,
        le=14,
    )


class DraftedCalendarEvent(BaseModel):
    title: str = Field(
        description="Short calendar event title (~6 words). Action-oriented."
    )
    summary: str = Field(
        description="One sentence describing what to do during this time block."
    )
    duration_min: int = Field(
        description=(
            "Total time needed to FULLY finish this task. Use realistic "
            "increments: 15, 25, 30, 45, 60, 90, 120, or more for big tasks."
        ),
        ge=15,
        le=480,
    )
    is_big: bool = Field(
        description=(
            "True if this task is too large for one sitting and should be "
            "split into day-by-day fragments. Triggers when: "
            "(a) duration_min > 45, or "
            "(b) the source content has natural sub-parts (e.g., a book "
            "with chapters, a doc with multiple ask-blocks, a contract "
            "with several sections), or "
            "(c) the user has multiple distinct asks across days. "
            "If true, populate `fragments`."
        )
    )
    fragments: list[Fragment] = Field(
        default_factory=list,
        description=(
            "Day-by-day breakdown when is_big=true. Empty when is_big=false. "
            "Each fragment is one sitting; total fragment durations should "
            "roughly equal duration_min."
        ),
    )
    reasoning: str = Field(
        description=(
            "One sentence: why blocking time helps with this signal "
            "(e.g., article has been drifting for 3 months — read it)."
        )
    )


# ---------- Prompts ----------


_EMAIL_PROMPT = """\
You are drafting an outbound email on behalf of an ADHD-shaped productivity \
user. You are given ONE signal extracted from the user's data and must \
draft a reply or follow-up the user will review BEFORE sending.

Today's date: {today}

Signal:
  quadrant: {quadrant}
  title: {title}
  excerpt: {excerpt}
  recipient_email: {recipient_email}
  source: {source}
  metadata: {metadata}

Voice rules:
- 2-4 sentences. Skip "I hope this finds you well" and corporate openers.
- Mirror tone: warm for relationships, professional for career, brief for \
admin follow-ups.
- If there's a deadline, acknowledge it with a concrete commitment.
- For Form/feedback responses, thank them and respond to their SPECIFIC \
point from the excerpt.
- Don't fabricate details. If unknown, use [placeholder] for the user.
"""


_CAL_PROMPT = """\
You are drafting a CALENDAR BLOCK (time the user reserves for themselves) \
on behalf of an ADHD-shaped productivity user. The user has a signal in \
their system that doesn't have a recipient to email — it's something they \
need to engage with personally. Examples:

- An article they saved months ago and never read.
- A document they need to review or revise.
- A task they assigned themselves with a deadline.

Your job: propose a time block they should put on their calendar to deal \
with this. Suggest a title, duration, and one-line reason.

Today's date: {today}

Signal:
  quadrant: {quadrant}
  title: {title}
  excerpt: {excerpt}
  source: {source}
  metadata: {metadata}

Rules:
- Title is action-oriented and short ("Read planning habit article", \
"Review GK4I color tokens"). NOT "Spend time on..." or "Work on..."
- duration_min is the TOTAL time the task needs end-to-end.
- Reasoning explains WHY blocking time matters now (drift, deadline, etc.).

Big-task handling — IMPORTANT for tasks too large for one sitting:
- Set is_big=true and populate `fragments` when ANY of:
  * duration_min > 45 (won't fit in one sitting), OR
  * the source content has natural sub-parts (book chapters, multi-section \
contract, doc with several distinct asks), OR
  * the user has multiple distinct asks spanning days, OR
  * the title contains "and" joining distinct verbs/actions (e.g., \
"Review X AND confirm Y", "Draft A AND finalize B" → two distinct \
sub-tasks, treat as multi-day), OR
  * the source is a project-tracker sheet row describing review, draft, \
finalize, or implement work — these typically involve multiple sittings \
even when the title is brief. Lean toward is_big=true with 2-3 fragments \
for such rows.
- Fragments are PERCENTAGE-BASED, not distinct sub-tasks. You don't name \
them. Just provide:
  * `percent` — the slice of the total work (1-100). All fragments should \
sum to 100. Prefer even splits (5×20% or 3×33+33+34).
  * `duration_min` — how long that day's sitting takes (15-45 min, \
proportional to percent).
  * `day_offset` — 0 = today, 1 = tomorrow, etc.
- Pick the number of fragments based on TOTAL duration / per-sitting capacity:
  * 90 min total → 3 fragments of ~30 min each (33/33/34).
  * 60 min total → 2-3 fragments.
  * 120+ min → 4-5 fragments spread across the week.
- The LAST fragment must land on or before the parent task's deadline.
- For small tasks (one sitting), set is_big=false and leave fragments empty.

NOTE: fragment titles are auto-generated as `[parent title] · [percent]% · \
Day N`. You don't write fragment names — the user just sees "Day 1: 20%", \
"Day 2: 20%", etc.
"""


def _has_email_contact(signal: dict) -> bool:
    parts = signal.get("participants") or []
    return bool(parts) and parts[0] and "@" in parts[0]


def _draft_email(signal: dict) -> DraftedEmail:
    prompt = _EMAIL_PROMPT.format(
        today=datetime.now(timezone.utc).date().isoformat(),
        quadrant=signal["quadrant"],
        title=signal["title"],
        excerpt=signal["excerpt"] or "",
        recipient_email=signal["participants"][0],
        source=signal["source"],
        metadata=str(signal["metadata"])[:1500] if signal["metadata"] else "",
    )
    resp = _GENAI.models.generate_content(
        model=_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=DraftedEmail,
            temperature=0.3,
        ),
    )
    return DraftedEmail.model_validate_json(resp.text)


def _draft_calendar_event(signal: dict) -> DraftedCalendarEvent:
    prompt = _CAL_PROMPT.format(
        today=datetime.now(timezone.utc).date().isoformat(),
        quadrant=signal["quadrant"],
        title=signal["title"],
        excerpt=signal["excerpt"] or "",
        source=signal["source"],
        metadata=str(signal["metadata"])[:1500] if signal["metadata"] else "",
    )
    resp = _GENAI.models.generate_content(
        model=_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=DraftedCalendarEvent,
            temperature=0.3,
        ),
    )
    return DraftedCalendarEvent.model_validate_json(resp.text)


# ---------- BigQuery ----------


def _find_actionable_signals() -> list[dict]:
    """All Drive-derived signals above threshold, not yet actioned."""
    sql = f"""
        WITH actioned AS (
          SELECT DISTINCT sig_id
          FROM `{_ACTIONS_TABLE}`, UNNEST(related_signal_ids) AS sig_id
        )
        SELECT
          s.signal_id, s.title, s.excerpt, s.quadrant, s.weight, s.valence,
          s.participants, s.source, TO_JSON_STRING(s.metadata) AS metadata,
          s.occurred_at
        FROM `{_SIGNALS_TABLE}` s
        LEFT JOIN actioned a ON s.signal_id = a.sig_id
        WHERE a.sig_id IS NULL
          AND s.weight >= @threshold
          AND s.source IN UNNEST(@sources)
        ORDER BY s.weight DESC, s.occurred_at DESC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("threshold", "FLOAT64", _WEIGHT_THRESHOLD),
            bigquery.ArrayQueryParameter("sources", "STRING", list(_SOURCES)),
        ]
    )
    return [dict(r) for r in _BQ.query(sql, job_config=job_config).result()]


def _event_window_for_day_offset(
    duration_min: int, day_offset: int
) -> tuple[datetime, datetime]:
    """9 AM PT on `today + day_offset`, lasting `duration_min` minutes.

    User can re-time in the UI on approval. day_offset=1 (tomorrow) is the
    default for non-fragmented tasks since today is usually already booked.
    """
    today_9 = datetime.now(_DEMO_TZ).replace(
        hour=9, minute=0, second=0, microsecond=0
    )
    base = today_9 + timedelta(days=day_offset)
    return base, base + timedelta(minutes=duration_min)


def _default_event_window(duration_min: int) -> tuple[datetime, datetime]:
    """Back-compat: non-fragmented tasks land tomorrow 9 AM."""
    return _event_window_for_day_offset(duration_min, day_offset=1)


def _insert_email_action(signal: dict, drafted: DraftedEmail) -> str:
    action_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    sql = f"""
    INSERT INTO `{_ACTIONS_TABLE}` (
      action_id, user_id, action_type, status, reasoning, related_signal_ids,
      to_recipient, subject, body, event_start, event_end, attendees,
      drafted_at, decided_at, sent_at, metadata
    )
    VALUES (
      @action_id, @user_id, 'email_draft', 'drafted', @reasoning, @related_signal_ids,
      @to_recipient, @subject, @body, NULL, NULL, [],
      @drafted_at, NULL, NULL, PARSE_JSON(@metadata)
    )
    """
    _BQ.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("action_id", "STRING", action_id),
                bigquery.ScalarQueryParameter("user_id", "STRING", _USER_ID),
                bigquery.ScalarQueryParameter("reasoning", "STRING", drafted.reasoning),
                bigquery.ArrayQueryParameter(
                    "related_signal_ids", "STRING", [signal["signal_id"]]
                ),
                bigquery.ScalarQueryParameter(
                    "to_recipient", "STRING", signal["participants"][0]
                ),
                bigquery.ScalarQueryParameter("subject", "STRING", drafted.subject),
                bigquery.ScalarQueryParameter("body", "STRING", drafted.body),
                bigquery.ScalarQueryParameter("drafted_at", "TIMESTAMP", now),
                bigquery.ScalarQueryParameter(
                    "metadata",
                    "STRING",
                    json.dumps(
                        {
                            "auto_drafted": True,
                            "model": _MODEL,
                            "signal_quadrant": signal["quadrant"],
                            "signal_weight": signal["weight"],
                        }
                    ),
                ),
            ]
        ),
    ).result(timeout=30)
    return action_id


def _insert_one_calendar_row(
    signal: dict,
    *,
    title: str,
    summary: str,
    duration_min: int,
    day_offset: int,
    reasoning: str,
    extra_metadata: dict | None = None,
) -> str:
    action_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    event_start, event_end = _event_window_for_day_offset(duration_min, day_offset)

    metadata = {
        "auto_drafted": True,
        "model": _MODEL,
        "signal_quadrant": signal["quadrant"],
        "signal_weight": signal["weight"],
        "duration_min": duration_min,
        **(extra_metadata or {}),
    }

    sql = f"""
    INSERT INTO `{_ACTIONS_TABLE}` (
      action_id, user_id, action_type, status, reasoning, related_signal_ids,
      to_recipient, subject, body, event_start, event_end, attendees,
      drafted_at, decided_at, sent_at, metadata
    )
    VALUES (
      @action_id, @user_id, 'calendar_event', 'drafted', @reasoning, @related_signal_ids,
      NULL, @title, @summary, @event_start, @event_end, [],
      @drafted_at, NULL, NULL, PARSE_JSON(@metadata)
    )
    """
    _BQ.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("action_id", "STRING", action_id),
                bigquery.ScalarQueryParameter("user_id", "STRING", _USER_ID),
                bigquery.ScalarQueryParameter("reasoning", "STRING", reasoning),
                bigquery.ArrayQueryParameter(
                    "related_signal_ids", "STRING", [signal["signal_id"]]
                ),
                bigquery.ScalarQueryParameter("title", "STRING", title),
                bigquery.ScalarQueryParameter("summary", "STRING", summary),
                bigquery.ScalarQueryParameter(
                    "event_start", "TIMESTAMP", event_start.isoformat()
                ),
                bigquery.ScalarQueryParameter(
                    "event_end", "TIMESTAMP", event_end.isoformat()
                ),
                bigquery.ScalarQueryParameter("drafted_at", "TIMESTAMP", now),
                bigquery.ScalarQueryParameter(
                    "metadata", "STRING", json.dumps(metadata)
                ),
            ]
        ),
    ).result(timeout=30)
    return action_id


def _insert_calendar_action(
    signal: dict, drafted: DraftedCalendarEvent
) -> list[str]:
    """Insert one row per non-fragmented task, or N rows for a big task
    split into per-day fragments. Returns the list of action_ids inserted.
    """
    if drafted.is_big and drafted.fragments:
        ids: list[str] = []
        total_fragments = len(drafted.fragments)
        for idx, frag in enumerate(drafted.fragments):
            # Title is composed: "{parent} · {percent}% · Day N". The user
            # sees uniform per-day chunks, not distinct sub-task names.
            frag_title = (
                f"{drafted.title} · {frag.percent}% · Day {idx + 1}"
            )
            aid = _insert_one_calendar_row(
                signal,
                title=frag_title,
                summary=drafted.summary,
                duration_min=frag.duration_min,
                day_offset=frag.day_offset,
                reasoning=drafted.reasoning,
                extra_metadata={
                    "parent_signal_id": signal["signal_id"],
                    "parent_title": drafted.title,
                    "fragment_idx": idx,
                    "fragment_count": total_fragments,
                    "fragment_percent": frag.percent,
                    "is_fragment": True,
                },
            )
            ids.append(aid)
        return ids

    # Non-fragmented task: single row, tomorrow morning by default.
    aid = _insert_one_calendar_row(
        signal,
        title=drafted.title,
        summary=drafted.summary,
        duration_min=drafted.duration_min,
        day_offset=1,
        reasoning=drafted.reasoning,
    )
    return [aid]


def _purge_stale_drafts() -> int:
    """Delete drafted actions whose related signal has been re-classified
    since the action was drafted. This makes "edit the doc → re-run pipeline"
    trigger fresh drafts (potentially fragmented now that the content is
    bigger / different).

    BigQuery can't handle correlated EXISTS across tables, so we compute
    the stale action_ids in a non-correlated subquery and DELETE via IN.
    """
    sql = f"""
        DELETE FROM `{_ACTIONS_TABLE}`
        WHERE action_id IN (
          SELECT DISTINCT pa.action_id
          FROM `{_ACTIONS_TABLE}` pa
          CROSS JOIN UNNEST(pa.related_signal_ids) AS sid
          JOIN `{_SIGNALS_TABLE}` s ON s.signal_id = sid
          WHERE pa.user_id = @uid
            AND pa.status = 'drafted'
            AND s.ingested_at > pa.drafted_at
        )
    """
    job = _BQ.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("uid", "STRING", _USER_ID),
            ]
        ),
    )
    job.result()
    return job.num_dml_affected_rows or 0


def _invalidate_today_panel_cache() -> None:
    """Drop today's cached daily plan so the UI regenerates with the new drafts.

    `daily_plan_v1` is cached per (user_id, plan_date) latest-row-wins. The
    TodayPanel auto-regens on cache miss (~10-20s on next dashboard load).

    Note: plan rows are written via streaming insert in plan_today.py, and
    BigQuery blocks DELETE on streaming-buffer rows for ~30 min. We
    therefore swallow the BadRequest — the draft work already succeeded;
    user just needs to refresh the dashboard, and the today panel will
    catch up on its next natural fetch (showing the new fragments in
    pending_actions even if the cached plan is stale).
    """
    sql = f"""
        DELETE FROM `{_DAILY_PLAN_TABLE}`
        WHERE user_id = @user_id
          AND plan_date = CURRENT_DATE(@tz)
    """
    try:
        _BQ.query(
            sql,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("user_id", "STRING", _USER_ID),
                    bigquery.ScalarQueryParameter("tz", "STRING", str(_DEMO_TZ)),
                ]
            ),
        ).result(timeout=30)
    except Exception as exc:
        log.warning(
            "Skipped daily_plan_v1 cache invalidation (%s). New drafts still "
            "show in quadrant cards; today panel will catch up after streaming "
            "buffer flushes (~30 min) or on manual refresh.",
            type(exc).__name__,
        )


# ---------- Entrypoints ----------


def run() -> int:
    """Find actionable signals, draft an action per signal, insert. Returns count drafted."""
    # Wipe drafts whose underlying signal has fresher content. The reclassified
    # signals will be picked up below and redrafted (with fragmentation if the
    # content has grown).
    purged = _purge_stale_drafts()
    if purged > 0:
        log.info("Auto-draft: purged %d stale drafted actions (signal content changed).", purged)

    signals = _find_actionable_signals()
    log.info("Auto-draft: %d actionable signals", len(signals))

    drafted = 0
    for s in signals:
        try:
            if _has_email_contact(s):
                email = _draft_email(s)
                action_id = _insert_email_action(s, email)
                log.info(
                    "  drafted EMAIL %s [%s w=%.2f] → action=%s subj=%r",
                    s["title"],
                    s["quadrant"],
                    s["weight"],
                    action_id[:8],
                    email.subject,
                )
                drafted += 1
            else:
                cal = _draft_calendar_event(s)
                action_ids = _insert_calendar_action(s, cal)
                if cal.is_big and cal.fragments:
                    log.info(
                        "  drafted BLOCK[BIG] %s [%s w=%.2f] → %d fragments title=%r total_dur=%d",
                        s["title"],
                        s["quadrant"],
                        s["weight"],
                        len(action_ids),
                        cal.title,
                        cal.duration_min,
                    )
                    for idx, (aid, frag) in enumerate(zip(action_ids, cal.fragments)):
                        log.info(
                            "    [%d/%d] day+%d %d%% (%dmin) → action=%s",
                            idx + 1,
                            len(cal.fragments),
                            frag.day_offset,
                            frag.percent,
                            frag.duration_min,
                            aid[:8],
                        )
                else:
                    log.info(
                        "  drafted BLOCK %s [%s w=%.2f] → action=%s title=%r dur=%d",
                        s["title"],
                        s["quadrant"],
                        s["weight"],
                        action_ids[0][:8],
                        cal.title,
                        cal.duration_min,
                    )
                drafted += len(action_ids)
        except Exception as exc:
            log.warning("  draft FAILED for %s: %s", s["title"], exc)

    if drafted > 0 or purged > 0:
        _invalidate_today_panel_cache()
        log.info("Invalidated today's daily_plan_v1 cache — UI will regen on refresh.")

    return drafted


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    n = run()
    log.info("Auto-draft complete: %d new actions inserted into %s", n, _ACTIONS_TABLE)


if __name__ == "__main__":
    main()
