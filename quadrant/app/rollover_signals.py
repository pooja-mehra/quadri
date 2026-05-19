"""Roll forward undone drive-derived signals each week.

The LLM classifies each document ONCE (in `classify_drive_documents`). After
that, we don't burn Gemini cycles re-thinking the same content — we just
bump dates of items the user hasn't acted on.

Done by checking related `proposed_actions`:
  - sent      → user did it.        don't touch.
  - rejected  → user dismissed it.  don't touch.
  - drafted / approved → still on plate. bump `occurred_at` to this Sunday.
  - no action exists   → orphan (rare). bump too.

Idempotent: re-running the same week is a no-op since signals already sit
at this Sunday.

Calendar-source signals are NOT rolled over — calendar events have fixed
times that happened or didn't. Done state for those is client-side
(slot.done in localStorage).

Run:
    cd quadrant
    uv run python -m app.rollover_signals

For automation: schedule via Cloud Scheduler → Cloud Run job, weekly
Monday 02:00 PT.
"""

from __future__ import annotations

import logging
import os

import google.auth
from google.cloud import bigquery

_, _PROJECT_ID = google.auth.default()
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", _PROJECT_ID)

_BQ = bigquery.Client(project=_PROJECT_ID)
_SIGNALS_TABLE = f"{_PROJECT_ID}.quadrant.quadrant_signals"
_ACTIONS_TABLE = f"{_PROJECT_ID}.quadrant.proposed_actions"
_TZ = "America/Los_Angeles"
# Default morning slot for items rolled forward — gives the user the first
# part of the day to address what they missed yesterday.
_ROLLOVER_START_HOUR = 9

# Sources eligible for rollover. Calendar events have fixed times — skipped.
# Projected (synthetic lifecycle) signals are score-only, not on the user's
# plate — also skipped.
_ROLLOVER_SOURCES = ("google_drive_doc", "google_drive_sheet")

log = logging.getLogger(__name__)


def run() -> int:
    """Bump occurred_at to this Sunday for undone drive-derived signals.

    Returns the count of rows updated.
    """
    sql = f"""
        UPDATE `{_SIGNALS_TABLE}` s
        SET
          occurred_at = TIMESTAMP(
            DATE_ADD(
              DATE_TRUNC(CURRENT_DATE(@tz), WEEK(MONDAY)),
              INTERVAL 6 DAY
            ),
            @tz
          ),
          ingested_at = CURRENT_TIMESTAMP()
        WHERE s.source IN UNNEST(@sources)
          AND DATE(s.occurred_at, @tz) <
              DATE_TRUNC(CURRENT_DATE(@tz), WEEK(MONDAY))
          AND NOT EXISTS (
            SELECT 1
            FROM `{_ACTIONS_TABLE}` pa,
                 UNNEST(pa.related_signal_ids) AS sid
            WHERE sid = s.signal_id
              AND pa.status IN ('sent', 'rejected')
          )
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("tz", "STRING", _TZ),
            bigquery.ArrayQueryParameter(
                "sources", "STRING", list(_ROLLOVER_SOURCES)
            ),
        ]
    )
    job = _BQ.query(sql, job_config=job_config)
    job.result()
    return job.num_dml_affected_rows or 0


def run_action_block_rollover() -> int:
    """Bump `event_start` to today (09:00 PT) for past, undone
    `calendar_event` actions — including fragments. Run daily so a Day 1
    fragment that didn't get done yesterday surfaces as 'today's task'.

    Idempotent: rows already dated today are not touched. Sent/rejected
    rows are left alone (terminal states). `event_end` is shifted by the
    same offset to preserve the original duration.
    """
    sql = f"""
        UPDATE `{_ACTIONS_TABLE}`
        SET
          event_start = TIMESTAMP_ADD(
            TIMESTAMP(CURRENT_DATE(@tz), @tz),
            INTERVAL {_ROLLOVER_START_HOUR} HOUR
          ),
          event_end = TIMESTAMP_ADD(
            TIMESTAMP_ADD(
              TIMESTAMP(CURRENT_DATE(@tz), @tz),
              INTERVAL {_ROLLOVER_START_HOUR} HOUR
            ),
            INTERVAL TIMESTAMP_DIFF(event_end, event_start, MINUTE) MINUTE
          )
        WHERE user_id = @uid
          AND action_type = 'calendar_event'
          AND status IN ('drafted', 'approved')
          AND sent_at IS NULL
          AND event_start IS NOT NULL
          AND DATE(event_start, @tz) < CURRENT_DATE(@tz)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("uid", "STRING", "demo_user"),
            bigquery.ScalarQueryParameter("tz", "STRING", _TZ),
        ]
    )
    job = _BQ.query(sql, job_config=job_config)
    job.result()
    return job.num_dml_affected_rows or 0


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    signals_rolled = run()
    log.info(
        "Rolled %d undone drive signals forward to this Sunday.", signals_rolled
    )
    actions_rolled = run_action_block_rollover()
    log.info(
        "Bumped %d past undone calendar_event actions to today 09:00 PT.",
        actions_rolled,
    )


if __name__ == "__main__":
    main()
