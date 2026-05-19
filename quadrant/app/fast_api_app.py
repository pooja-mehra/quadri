# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import json
import os
import re
import time
import urllib.parse as _urlparse
import urllib.request as _urlreq
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

# Load environment variables from a local .env file (if present) BEFORE
# any code that reads os.environ. The .env lives in the quadrant/ root
# and is gitignored; .env.example carries the variable names users
# should set. Without this, USER_NOTIFY_EMAIL and friends only resolve
# if set in the shell beforehand.
from dotenv import load_dotenv  # type: ignore[import-not-found]

_DOTENV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"
)
load_dotenv(_DOTENV_PATH, override=False)

import google.auth
from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app
from google.cloud import bigquery
from google.cloud import logging as google_cloud_logging
from pydantic import BaseModel

from app.app_utils.telemetry import setup_telemetry
from app.app_utils.typing import Feedback
from app.plan_today import (
    DailyPlan,
    generate_plan,
    rank_unplanned_for_today,
    read_today_plan,
)

setup_telemetry()
_, project_id = google.auth.default()
logging_client = google_cloud_logging.Client()
logger = logging_client.logger(__name__)
allow_origins = (
    os.getenv("ALLOW_ORIGINS", "").split(",") if os.getenv("ALLOW_ORIGINS") else None
)

# Artifact bucket for ADK (created by Terraform, passed via env var)
logs_bucket_name = os.environ.get("LOGS_BUCKET_NAME")

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Cloud SQL session configuration
db_user = os.environ.get("DB_USER", "postgres")
db_name = os.environ.get("DB_NAME", "postgres")
db_pass = os.environ.get("DB_PASS")
instance_connection_name = os.environ.get("INSTANCE_CONNECTION_NAME")

session_service_uri = None
if instance_connection_name and db_pass:
    # Use Unix socket for Cloud SQL
    # URL-encode username and password to handle special characters (e.g., '[', '?', '#', '$')
    # These characters can cause URL parsing errors, especially '[' which triggers IPv6 validation
    encoded_user = quote(db_user, safe="")
    encoded_pass = quote(db_pass, safe="")
    # URL-encode the connection name to prevent colons from being misinterpreted
    encoded_instance = instance_connection_name.replace(":", "%3A")

    session_service_uri = (
        f"postgresql+asyncpg://{encoded_user}:{encoded_pass}@"
        f"/{db_name}"
        f"?host=/cloudsql/{encoded_instance}"
    )

artifact_service_uri = f"gs://{logs_bucket_name}" if logs_bucket_name else None

# Clear ADK's local sqlite session store on every process start.
# uvicorn --reload restarts on file changes but preserves session.db,
# which causes UNIQUE constraint failures when the frontend reuses a
# session UUID across a backend restart. For a single-user dev/demo
# build conversation history is per-session anyway, so wiping is the
# pragmatic fix. If we ever need cross-restart memory, swap to the
# Cloud SQL session_service_uri path (already wired below).
def _wipe_session_db() -> None:
    adk_dir = os.path.join(AGENT_DIR, "app", ".adk")
    for name in ("session.db", "session.db-wal", "session.db-shm"):
        path = os.path.join(adk_dir, name)
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[startup] could not remove {path}: {e}")


if not session_service_uri:
    # Only wipe when we're on the local sqlite path. Cloud SQL has
    # its own lifecycle.
    _wipe_session_db()


app: FastAPI = get_fast_api_app(
    agents_dir=AGENT_DIR,
    web=True,
    artifact_service_uri=artifact_service_uri,
    allow_origins=allow_origins,
    session_service_uri=session_service_uri,
    otel_to_cloud=True,
)
app.title = "quadrant"
app.description = "API for interacting with the Agent quadrant"


@app.post("/feedback")
def collect_feedback(feedback: Feedback) -> dict[str, str]:
    """Collect and log feedback.

    Args:
        feedback: The feedback data to log

    Returns:
        Success message
    """
    logger.log_struct(feedback.model_dump(), severity="INFO")
    return {"status": "success"}


# ---------- Plan-today (in-app daily loop) ----------


class PlanTodayRequest(BaseModel):
    user_id: str = "demo_user"
    plan_date: str  # ISO date in user-local TZ (e.g., "2026-05-07")
    user_intentions: str = ""


class PlanTodayResponse(BaseModel):
    plan: DailyPlan | None


@app.post("/plan/today")
def post_plan_today(req: PlanTodayRequest) -> PlanTodayResponse:
    """Generate today's plan (top-3 + per-goal micro-steps) and persist it."""
    plan = generate_plan(req.user_id, req.plan_date, req.user_intentions)
    return PlanTodayResponse(plan=plan)


class PrioritiesTodayRequest(BaseModel):
    user_id: str = "demo_user"
    plan_date: str  # ISO date in user-local TZ


@app.post("/priorities/today")
def post_priorities_today(req: PrioritiesTodayRequest) -> PlanTodayResponse:
    """Rank today's unplanned items (pending + committed) and persist.
    Cached daily; the existing GET /plan/today reads it back."""
    plan = rank_unplanned_for_today(req.user_id, req.plan_date)
    return PlanTodayResponse(plan=plan)


@app.get("/plan/today")
def get_plan_today(plan_date: str, user_id: str = "demo_user") -> PlanTodayResponse:
    """Return the latest plan for the given user-local date, or null if none exists."""
    return PlanTodayResponse(plan=read_today_plan(user_id, plan_date))


# ---------- Timed/scheduled email sends ----------
#
# `schedule_send(action_id, send_at_iso)` (in agent.py) stores a target
# timestamp on `proposed_actions.metadata.send_at`. The loop below polls
# every 60s, finds rows whose send_at has passed, calls the Next.js
# /api/gmail/send route (which handles MIME + attachments + OAuth), and
# marks status='sent' on success. Without this poller, scheduled sends
# would never fire — no Cloud Scheduler, no cron.

_SENDS_BQ = bigquery.Client(project=project_id)
_UI_BASE_URL = os.environ.get("QUADRANT_UI_BASE_URL", "http://localhost:3000")
_POLL_INTERVAL_SEC = 60
_LOCAL_TZ = ZoneInfo("America/Los_Angeles")
# Preview emails go to whichever address is available, in this order:
#   1. user_credentials.email (captured at OAuth callback via
#      userinfo.email — the connected Google account itself).
#   2. USER_NOTIFY_EMAIL env var fallback for dev/CI scenarios
#      where the user wants previews to go somewhere other than
#      the connected account.
# Without either, preview is silently skipped — the real send still
# fires at slot time.
_USER_NOTIFY_EMAIL_ENV = os.environ.get("USER_NOTIFY_EMAIL")


def _resolve_user_notify_email() -> str | None:
    """Returns the address that lead-time draft previews should go to.
    Prefers the connected Google account email from user_credentials;
    falls back to the env var. Cheap query; runs once per poll tick."""
    try:
        rows = list(
            _SENDS_BQ.query(
                """
                SELECT email FROM `quadrant.user_credentials`
                WHERE user_id = 'demo_user' AND provider = 'google'
                LIMIT 1
                """
            ).result(timeout=10)
        )
        if rows and rows[0]["email"]:
            return str(rows[0]["email"])
    except Exception:
        pass
    return _USER_NOTIFY_EMAIL_ENV


def _ui_send_email(payload: dict) -> tuple[int, dict]:
    """POST to the Next.js /api/gmail/send route. Returns (status, body).
    Returns (0, {error}) on connection failure."""
    data = json.dumps(payload).encode("utf-8")
    req = _urlreq.Request(
        f"{_UI_BASE_URL}/api/gmail/send",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=data,
    )
    try:
        with _urlreq.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8")
            return r.status, json.loads(body) if body else {}
    except _urlreq.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": body}
    except Exception as e:
        return 0, {"error": str(e)}


def _slot_to_utc(plan_date_str: str, slot_start_min: int) -> datetime:
    """Translate (plan_date YYYY-MM-DD in PT, slot_start_min in PT) →
    aware UTC datetime. Slot times are stored as PT minutes-of-day."""
    y, m, d = map(int, plan_date_str.split("-"))
    hh = slot_start_min // 60
    mm = slot_start_min % 60
    local_dt = datetime(y, m, d, hh, mm, tzinfo=_LOCAL_TZ)
    return local_dt.astimezone(timezone.utc)


def _read_lead_time_minutes() -> int:
    """Look at the user's scheduling preferences for a 'lead time'
    rule ("send me the draft an hour before the scheduled time",
    "30 minutes before", etc.) and return the lead in minutes. Returns
    0 if no lead-time pref is set — no preview email is sent in that
    case.

    Best-effort regex parse on free-text prefs (the prefs are stored as
    user-written rules). Cheap; runs once per poll tick."""
    try:
        rows = list(
            _SENDS_BQ.query(
                """
                SELECT text FROM `quadrant.user_preferences`
                WHERE user_id = 'demo_user' AND category = 'scheduling'
                """
            ).result(timeout=10)
        )
    except Exception:
        return 0
    texts = [(r["text"] or "").lower() for r in rows]
    for t in texts:
        if "before" not in t:
            continue
        # "an hour", "1 hour", "2 hours"
        m = re.search(r"(?:an?|(\d+))\s*hour", t)
        if m:
            n = int(m.group(1)) if m.group(1) else 1
            return n * 60
        # "30 minutes", "15 min"
        m = re.search(r"(\d+)\s*min", t)
        if m:
            return int(m.group(1))
    return 0


def _mark_metadata_field(action_id: str, field: str, value_iso: str) -> None:
    """Set metadata.<field> = "<value_iso>" on a proposed_actions row."""
    _SENDS_BQ.query(
        f"""
        UPDATE `quadrant.proposed_actions`
        SET metadata = JSON_SET(
          COALESCE(metadata, JSON '{{}}'),
          '$.{field}', PARSE_JSON(TO_JSON_STRING(@val))
        )
        WHERE action_id = @id AND user_id = 'demo_user'
        """,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("id", "STRING", action_id),
                bigquery.ScalarQueryParameter("val", "STRING", value_iso),
            ]
        ),
    ).result(timeout=15)


def _fire_due_sends() -> dict:
    """Find due email sends and fire them. Two paths to "due":

      1. Slotted on the time bar — the slot's (plan_date, slot_start_min)
         IS the send time. No explicit schedule call needed.
      2. Explicit schedule via `schedule_send` — `metadata.send_at`
         carries an ISO timestamp.

    Lead-time previews: if a scheduling pref says "send me the draft
    an hour before", we email the draft to the user N minutes before
    the real send. Tracked via `metadata.preview_sent_at` so we only
    preview once per draft.

    Returns {"due", "sent", "previewed", "failed": [...]}.
    """
    select_sql = """
    SELECT
      a.action_id, a.to_recipient, a.subject, a.body,
      JSON_VALUE(a.metadata, '$.send_at') AS explicit_send_at,
      JSON_VALUE(a.metadata, '$.preview_sent_at') AS preview_sent_at,
      TO_JSON_STRING(JSON_QUERY(a.metadata, '$.attachments')) AS attachments_json,
      s.plan_date AS slot_plan_date,
      s.slot_start_min AS slot_start_min
    FROM `quadrant.proposed_actions` a
    LEFT JOIN `quadrant.daily_slots` s
      ON s.item_ref_id = a.action_id
      AND (s.done IS NULL OR s.done = FALSE)
    WHERE a.user_id = 'demo_user'
      AND a.action_type = 'email_draft'
      AND a.status IN ('approved', 'drafted')
      AND a.sent_at IS NULL
      AND (
        JSON_VALUE(a.metadata, '$.send_at') IS NOT NULL
        OR s.slot_id IS NOT NULL
      )
    """
    try:
        rows = list(_SENDS_BQ.query(select_sql).result(timeout=30))
    except Exception as e:
        return {
            "due": 0, "sent": 0, "previewed": 0,
            "failed": [{"action_id": None, "error": f"select: {e}"}],
        }

    now_utc = datetime.now(timezone.utc)
    lead_min = _read_lead_time_minutes()
    notify_email = _resolve_user_notify_email()
    sent = 0
    previewed = 0
    due_count = 0
    failed: list[dict] = []

    for r in rows:
        action_id = r["action_id"]
        # Compute send time. Slot wins over explicit schedule_send.
        send_at: datetime | None = None
        if r["slot_plan_date"] is not None and r["slot_start_min"] is not None:
            plan_date_str = (
                r["slot_plan_date"].isoformat()
                if hasattr(r["slot_plan_date"], "isoformat")
                else str(r["slot_plan_date"])
            )
            send_at = _slot_to_utc(plan_date_str, int(r["slot_start_min"]))
        elif r["explicit_send_at"]:
            try:
                send_at = datetime.fromisoformat(
                    r["explicit_send_at"].replace("Z", "+00:00")
                )
                if send_at.tzinfo is None:
                    send_at = send_at.replace(tzinfo=timezone.utc)
            except Exception:
                continue
        if send_at is None:
            continue

        # Attachments → file_ids.
        file_ids: list[str] = []
        if r["attachments_json"] and r["attachments_json"] != "null":
            try:
                attachments = json.loads(r["attachments_json"])
                for a in attachments or []:
                    fid = a.get("file_id") if isinstance(a, dict) else None
                    if fid:
                        file_ids.append(fid)
            except Exception:
                pass

        # 1. Real send: send_at <= now → fire.
        if send_at <= now_utc:
            due_count += 1
            payload = {
                "to": r["to_recipient"] or "",
                "subject": r["subject"] or "",
                "body": r["body"] or "",
            }
            if file_ids:
                payload["attachment_file_ids"] = file_ids
            status, resp = _ui_send_email(payload)
            if 200 <= status < 300 and resp.get("ok"):
                try:
                    _SENDS_BQ.query(
                        """
                        UPDATE `quadrant.proposed_actions`
                        SET status = 'sent', sent_at = CURRENT_TIMESTAMP()
                        WHERE action_id = @id AND user_id = 'demo_user'
                        """,
                        job_config=bigquery.QueryJobConfig(
                            query_parameters=[
                                bigquery.ScalarQueryParameter("id", "STRING", action_id)
                            ]
                        ),
                    ).result(timeout=15)
                    sent += 1
                except Exception as e:
                    failed.append({"action_id": action_id, "error": f"post-send mark: {e}"})
            else:
                failed.append(
                    {"action_id": action_id, "error": resp.get("error") or f"HTTP {status}"}
                )
            continue

        # 2. Lead-time preview: preview_at = send_at - lead_min.
        if lead_min > 0 and notify_email and not r["preview_sent_at"]:
            preview_at = send_at - timedelta(minutes=lead_min)
            if preview_at <= now_utc:
                local_send = send_at.astimezone(_LOCAL_TZ).strftime("%a %b %d %I:%M %p %Z")
                payload = {
                    "to": notify_email,
                    "subject": f"[Draft preview] Will send at {local_send}: {r['subject'] or ''}",
                    "body": (
                        f"Quadri will send this email at {local_send} ({lead_min} min from now):\n\n"
                        f"To: {r['to_recipient'] or '(no recipient)'}\n"
                        f"Subject: {r['subject'] or '(no subject)'}\n"
                        f"------\n\n"
                        f"{r['body'] or ''}\n\n"
                        f"------\n"
                        f"Reply 'cancel' in chat to hold the send, or edit the draft "
                        f"on the time bar before it fires."
                    ),
                }
                if file_ids:
                    payload["attachment_file_ids"] = file_ids
                status, resp = _ui_send_email(payload)
                if 200 <= status < 300 and resp.get("ok"):
                    try:
                        _mark_metadata_field(action_id, "preview_sent_at", now_utc.isoformat())
                        previewed += 1
                    except Exception as e:
                        failed.append({"action_id": action_id, "error": f"mark preview: {e}"})
                else:
                    failed.append(
                        {"action_id": action_id, "error": f"preview send: {resp.get('error') or status}"}
                    )

    return {"due": due_count, "sent": sent, "previewed": previewed, "failed": failed}


async def _due_sends_loop() -> None:
    """Background loop: every POLL_INTERVAL_SEC, run _fire_due_sends in
    a thread so we don't block the event loop."""
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(_POLL_INTERVAL_SEC)
        try:
            result = await loop.run_in_executor(None, _fire_due_sends)
            if result.get("sent", 0) or result.get("failed"):
                print(f"[due_sends] {result}")
        except Exception as e:
            print(f"[due_sends_loop] tick error: {e}")


# Background poller — daemon thread, started at module import.
#
# We used to register this via `@app.on_event("startup")` but ADK's
# `get_fast_api_app()` installs its own FastAPI lifespan context
# manager, and FastAPI silently ignores `on_event` hooks when a
# lifespan is set. The result was that the poller never started and
# scheduled emails sat in `proposed_actions` forever without firing.
#
# A daemon thread sidesteps the lifecycle entirely. The Python BQ
# client is thread-safe; `_SENDS_BQ` is a dedicated client instance
# specifically for this loop. The daemon flag ensures the thread
# dies when uvicorn exits so reloads don't leak threads.
import threading as _threading

_poller_thread: _threading.Thread | None = None


def _sync_due_sends_loop() -> None:
    while True:
        time.sleep(_POLL_INTERVAL_SEC)
        try:
            result = _fire_due_sends()
            if result.get("sent", 0) or result.get("failed"):
                print(f"[due_sends] {result}", flush=True)
        except Exception as e:
            print(f"[due_sends_loop] tick error: {e}", flush=True)


def _ensure_poller_thread() -> None:
    global _poller_thread
    if _poller_thread is not None and _poller_thread.is_alive():
        return
    _poller_thread = _threading.Thread(
        target=_sync_due_sends_loop,
        name="quadri-due-sends",
        daemon=True,
    )
    _poller_thread.start()
    print(
        f"[due_sends] poller thread started (interval={_POLL_INTERVAL_SEC}s)",
        flush=True,
    )


_ensure_poller_thread()


@app.post("/sends/run-due")
def run_due_sends_now() -> dict:
    """Manual / on-demand trigger for the scheduled-send poller. Same
    logic as the background loop, but fires immediately. Useful for
    tests and for an external trigger (Cloud Scheduler) once we have
    one."""
    return _fire_due_sends()


# Main execution
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
