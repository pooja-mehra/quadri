# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

"""Plan-today loop: generate top-3 day items + per-goal micro-steps.

In-app v1. The Next.js client triggers POST /plan/today (with the user-local
date and any free-text intentions). This module reads planning context from
BigQuery, calls Gemini with a tight structured-output schema, and persists
the result to `quadrant.daily_plan_v1`.

GET /plan/today returns the latest plan for that user-local date, or None.

See memory: project_plan_today_loop — sidecar table, decoupled from
pending actions in v1, in-app only (no email/text push).
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
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
_TABLE_ID = f"{_PROJECT_ID}.quadrant.daily_plan_v1"
_MODEL = "gemini-3-flash-preview"


# ---------- Wire types (request / response / persisted shape) ----------


class PlanItem(BaseModel):
    rank: int = Field(description="Priority order, starting at 1.")
    text: str = Field(
        description=(
            "One concrete thing, with the WHY baked in (deadline, who's waiting, "
            "or which goal it advances). ~12 words. "
            'Examples: "Reply to Priya — she asked Tuesday", '
            '"Confirm Dr Chen — appointment in 2 days".'
        )
    )
    source: Literal[
        "pending_action",
        "committed_action",
        "forgotten_commitment",
        "goal",
        "user",
    ] = Field(
        description=(
            "Where this item came from. 'pending_action' for an agent-drafted "
            "action awaiting approval; 'committed_action' for one already "
            "approved but not sent; 'forgotten_commitment' for a promise "
            "extracted from past signals; 'goal' to advance an active goal; "
            "'user' for free-text user intentions."
        )
    )
    source_ref_id: str | None = Field(
        default=None,
        description="action_id / commitment_id / goal_id, depending on source. Null if source='user'.",
    )
    cited_signal_ids: list[str] = Field(
        default_factory=list,
        description="signal_ids that motivate this item, when applicable.",
    )


class GoalMicroStep(BaseModel):
    goal_id: str
    text: str = Field(description="One small step today (~25 min or less). Concrete verb + object.")
    cited_signal_ids: list[str] = Field(default_factory=list)


class PlanGeneration(BaseModel):
    """The Gemini response schema."""

    top_items: list[PlanItem] = Field(
        description="Exactly 3 items, ranked. Top-3 cap is intentional — never more.",
    )
    goal_micro_steps: list[GoalMicroStep] = Field(
        description=(
            "Zero or more micro-steps, one per active goal where you have a "
            "concrete suggestion. Skip a goal entirely if nothing concrete "
            "fits today — silence beats filler."
        ),
    )


class DailyPlan(BaseModel):
    """The persisted + returned plan shape."""

    plan_id: str
    plan_date: str
    generated_at: str
    user_intentions: str | None
    top_items: list[PlanItem]
    goal_micro_steps: list[GoalMicroStep]
    nudge_at: str | None


# ---------- Context loaders (read-only) ----------


def _read_context(user_id: str) -> dict:
    """Read everything the planner needs. One round-trip is fine; volumes
    are small per user."""

    scores = list(
        _BQ.query("SELECT * FROM `quadrant.vw_quadrant_scores_current`").result(timeout=30)
    )

    goals = list(
        _BQ.query(
            """
            SELECT goal_id, quadrant, title, description, derived_from_signal_ids
            FROM quadrant.user_goals
            WHERE user_id = @uid AND status = 'active'
            ORDER BY quadrant, approved_at
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("uid", "STRING", user_id)]
            ),
        ).result(timeout=30)
    )

    # Excludes:
    #   1. Already-scheduled calendar_event actions (event_start IS NOT
    #      NULL). They're on the user's calendar; "plan today" is about
    #      unscheduled work that still needs a slot.
    #   2. Rejected actions. They're cancelled, off the plate.
    #   3. Anything with a done slot in the past 7 days — one-time events
    #      that the user already marked done shouldn't get re-proposed.
    # We still surface a separate "deferred_cancelled" bucket for
    # rejected actions whose cancel_reason hints at a future intent
    # ("later", "someday", "next week", etc.) — those represent items
    # the user explicitly said they'd come back to, and the planner can
    # re-surface them as gentle reminders.
    pending = list(
        _BQ.query(
            """
            SELECT action_id, action_type, to_recipient, subject, body,
                   reasoning, related_signal_ids, status,
                   TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), drafted_at, HOUR) AS hours_old
            FROM `quadrant.proposed_actions`
            WHERE user_id = @uid
              AND status IN ('drafted', 'approved')
              AND sent_at IS NULL
              AND event_start IS NULL
              AND action_id NOT IN (
                SELECT item_ref_id FROM `quadrant.daily_slots`
                WHERE done = TRUE
                  AND plan_date >= DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 7 DAY)
                  AND item_ref_id IS NOT NULL
              )
            ORDER BY drafted_at DESC
            LIMIT 20
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("uid", "STRING", user_id)]
            ),
        ).result(timeout=30)
    )

    # Deferred-cancelled candidates — rejected actions whose cancel_reason
    # implies the user wants to come back later. Filter out anything
    # still under an active snooze (user already said "not now").
    deferred = list(
        _BQ.query(
            """
            SELECT action_id, action_type, subject, body, reasoning,
                   related_signal_ids,
                   JSON_VALUE(metadata, '$.cancel_reason') AS cancel_reason,
                   JSON_VALUE(metadata, '$.snoozed_until') AS snoozed_until
            FROM quadrant.proposed_actions
            WHERE user_id = @uid
              AND status = 'rejected'
              AND JSON_VALUE(metadata, '$.cancel_reason') IS NOT NULL
              AND REGEXP_CONTAINS(
                LOWER(JSON_VALUE(metadata, '$.cancel_reason')),
                r'\\b(later|someday|some day|next (week|month|year)|tomorrow|remind me|come back|defer)\\b'
              )
              AND (
                JSON_VALUE(metadata, '$.snoozed_until') IS NULL
                OR SAFE.PARSE_TIMESTAMP(
                  '%Y-%m-%dT%H:%M:%E*S%Ez',
                  JSON_VALUE(metadata, '$.snoozed_until')
                ) IS NULL
                OR SAFE.PARSE_TIMESTAMP(
                  '%Y-%m-%dT%H:%M:%E*S%Ez',
                  JSON_VALUE(metadata, '$.snoozed_until')
                ) <= CURRENT_TIMESTAMP()
              )
            ORDER BY decided_at DESC
            LIMIT 10
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("uid", "STRING", user_id)]
            ),
        ).result(timeout=30)
    )

    # Recent influential signals (last 14 days). The scores view already
    # surfaces the top per quadrant, so just pull a handful per quadrant
    # from the underlying table for finer grounding.
    # Exclude signals whose slot was marked done in the past week —
    # done one-time events are terminal and shouldn't seed new plan items.
    signals = list(
        _BQ.query(
            """
            SELECT signal_id, quadrant, valence, weight, title, excerpt, occurred_at
            FROM `quadrant.quadrant_signals`
            WHERE user_id = @uid
              AND DATE(occurred_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
              AND quadrant IS NOT NULL
              AND signal_id NOT IN (
                SELECT item_ref_id FROM `quadrant.daily_slots`
                WHERE done = TRUE
                  AND plan_date >= DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 7 DAY)
                  AND item_ref_id IS NOT NULL
              )
            QUALIFY ROW_NUMBER() OVER (
              PARTITION BY quadrant ORDER BY weight DESC, occurred_at DESC
            ) <= 5
            ORDER BY quadrant, weight DESC
            """,
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("uid", "STRING", user_id)]
            ),
        ).result(timeout=30)
    )

    return {
        "scores": [_row_to_dict(r) for r in scores],
        "goals": [_row_to_dict(r) for r in goals],
        "pending_actions": [_row_to_dict(r) for r in pending],
        "deferred_cancelled": [_row_to_dict(r) for r in deferred],
        "recent_signals": [_row_to_dict(r) for r in signals],
    }


def _row_to_dict(r: bigquery.Row) -> dict:
    d = dict(r.items())
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
        elif hasattr(v, "items"):
            d[k] = _nested(v)
    return d


def _nested(v):
    if hasattr(v, "items"):
        return {k: _nested(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_nested(x) for x in v]
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


# ---------- Prompt ----------

_SYSTEM = """You are Quadri, planning today for an adult with ADHD.

Output a `top_items` list of EXACTLY 3 items and a `goal_micro_steps` list with
zero or more micro-steps (one per active goal where something concrete fits today).

Hard rules:
- Top-3 is a CAP. Three items, not four. Less than three only if the user genuinely
  has nothing to do today.
- Every item must be concrete: a verb + object the user could mark done in one sitting.
  Bad: "Make progress on Q3 plan." Good: "Draft Q3 scope outline — 25 min."
- Prefer items that map to an existing pending_action when one fits — set
  source='pending_action' and source_ref_id=<action_id>.
- Use source='goal' (with goal_id) when the item advances an active goal.
- Use source='user' for items derived from the user's stated intentions.
- Cite signal_ids in cited_signal_ids when an item is grounded in a specific signal.
- Micro-steps must be small (~25 min or less). Skip a goal entirely if nothing
  concrete fits today — silence beats filler. Do NOT pad.
- Match the user's voice: warm, terse, no corporate-speak, no emoji.
"""


def _build_prompt(context: dict, intentions: str, plan_date: str) -> str:
    return (
        f"Today's date (user-local): {plan_date}\n"
        f"\n"
        f"User intentions for today (free text, may be empty):\n"
        f"{intentions.strip() or '(none)'}\n"
        f"\n"
        f"Quadrant scores (0-10, with weights):\n"
        f"{json.dumps(context['scores'], indent=2)}\n"
        f"\n"
        f"Active goals:\n"
        f"{json.dumps(context['goals'], indent=2)}\n"
        f"\n"
        f"Pending + committed-but-unsent actions:\n"
        f"{json.dumps(context['pending_actions'], indent=2)}\n"
        f"\n"
        f"Recent influential signals (last 14 days, top per quadrant):\n"
        f"{json.dumps(context['recent_signals'], indent=2)}\n"
        f"\n"
        f"Now produce the plan."
    )


# ---------- Public API ----------


def generate_plan(user_id: str, plan_date: str, intentions: str = "") -> DailyPlan:
    """Generate a fresh plan for `plan_date` (user-local ISO date) and persist it."""
    context = _read_context(user_id)
    prompt = _build_prompt(context, intentions, plan_date)

    resp = _GENAI.models.generate_content(
        model=_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=_SYSTEM,
            response_mime_type="application/json",
            response_schema=PlanGeneration,
            temperature=0.4,
        ),
    )

    parsed: PlanGeneration | None = getattr(resp, "parsed", None)
    if parsed is None:
        # Fall back to manual JSON parse if the SDK didn't auto-parse.
        parsed = PlanGeneration.model_validate_json(resp.text or "{}")

    # Enforce the top-3 cap defensively.
    top = parsed.top_items[:3]
    for i, item in enumerate(top, start=1):
        item.rank = i

    plan = DailyPlan(
        plan_id=str(uuid.uuid4()),
        plan_date=plan_date,
        generated_at=datetime.now(timezone.utc).isoformat(),
        user_intentions=intentions or None,
        top_items=top,
        goal_micro_steps=parsed.goal_micro_steps,
        nudge_at=None,
    )
    _persist(user_id, plan)
    return plan


def _persist(user_id: str, plan: DailyPlan) -> None:
    """Append-only insert. Reads always pick the most-recent row per
    (user, plan_date), so re-plans within a day just supersede."""
    row = {
        "plan_id": plan.plan_id,
        "user_id": user_id,
        "plan_date": plan.plan_date,
        "generated_at": plan.generated_at,
        "user_intentions": plan.user_intentions,
        "top_items": [item.model_dump() for item in plan.top_items],
        "goal_micro_steps": [step.model_dump() for step in plan.goal_micro_steps],
        "nudge_at": plan.nudge_at,
        "metadata": None,
    }
    errors = _BQ.insert_rows_json(_TABLE_ID, [row])
    if errors:
        raise RuntimeError(f"daily_plan_v1 insert failed: {errors}")


def read_today_plan(user_id: str, plan_date: str) -> DailyPlan | None:
    """Return the most-recent plan for the given user-local date, or None."""
    sql = """
    SELECT plan_id, plan_date, generated_at, user_intentions,
           top_items, goal_micro_steps, nudge_at
    FROM quadrant.daily_plan_v1
    WHERE user_id = @uid AND plan_date = @plan_date
    ORDER BY generated_at DESC
    LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("uid", "STRING", user_id),
            bigquery.ScalarQueryParameter("plan_date", "DATE", plan_date),
        ]
    )
    rows = list(_BQ.query(sql, job_config=job_config).result(timeout=30))
    if not rows:
        return None

    r = _row_to_dict(rows[0])
    return DailyPlan(
        plan_id=r["plan_id"],
        plan_date=r["plan_date"],
        generated_at=r["generated_at"],
        user_intentions=r.get("user_intentions"),
        top_items=[PlanItem(**i) for i in (r.get("top_items") or [])],
        goal_micro_steps=[GoalMicroStep(**s) for s in (r.get("goal_micro_steps") or [])],
        nudge_at=r.get("nudge_at"),
    )


# ---------- Today-priorities ranker (lightweight, in-app v1) ----------
#
# This is the *active* daily flow. It ranks unplanned items the user should
# slot into today — pending + committed actions, and (when the table is
# populated) forgotten_commitments. Calendar items are skipped: they're
# already on the user's clock. Output goes into daily_plan_v1.top_items so
# the existing GET /plan/today reads it for free.


class PrioritiesRanking(BaseModel):
    """Gemini response schema for the ranker."""

    items: list[PlanItem] = Field(
        description=(
            "3 to 5 ranked items. Cap at 5; ideally 3. Skip if nothing is "
            "actually pressing today — silence beats filler."
        )
    )


_PRIORITIES_SYSTEM = """You are Quadri, ranking unplanned items for today.

Hard rules:
- Anything already on the user's calendar (event_start set) is filtered
  out upstream — only unscheduled work hits you. Don't second-guess.
- Rank by: deadline proximity > active-goal alignment > signal weight.
- Each `text` MUST include the WHY in one phrase (deadline, who's waiting,
  or which goal it serves). 12 words or fewer.
- 3-5 items max. Cap is intentional.
- source: 'pending_action' for status='drafted', 'committed_action' for
  status='approved'.
- source_ref_id MUST be the action_id of the underlying row.
- Match the user's voice: warm, terse, no corporate-speak, no emoji.
- DEFERRED-CANCELLED items: the user cancelled these but said
  something like "later", "someday", or "next week". They want a
  gentle nudge, not a wall. Surface AT MOST ONE in your 3-5, framed
  with their own words ("You said 'next week' on X — want to revisit?").
  Skip if pending/committed work is already heavy.
""".strip()


def _build_priorities_prompt(context: dict, plan_date: str) -> str:
    pending = [a for a in context["pending_actions"] if a.get("status") == "drafted"]
    committed = [
        a for a in context["pending_actions"] if a.get("status") == "approved"
    ]
    deferred = context.get("deferred_cancelled", [])
    return (
        f"Today's date (user-local): {plan_date}\n\n"
        f"Active goals (rank items higher when they advance these):\n"
        f"{json.dumps(context['goals'], indent=2)}\n\n"
        f"Pending actions (drafted, awaiting approval):\n"
        f"{json.dumps(pending, indent=2)}\n\n"
        f"Committed actions (approved, not yet done):\n"
        f"{json.dumps(committed, indent=2)}\n\n"
        f"Deferred-cancelled actions (cancelled with a 'later'-style reason —\n"
        f"surface at most one as a gentle nudge if today's plate is light):\n"
        f"{json.dumps(deferred, indent=2)}\n\n"
        f"Recent influential signals for context:\n"
        f"{json.dumps(context['recent_signals'], indent=2)}\n\n"
        f"Now produce the top 3-5 to slot today."
    )


def rank_unplanned_for_today(user_id: str, plan_date: str) -> DailyPlan:
    """Rank existing unplanned items for the user-local date and persist."""
    context = _read_context(user_id)

    # Nothing to rank — persist an empty plan so the cache is honored.
    if not context["pending_actions"]:
        plan = DailyPlan(
            plan_id=str(uuid.uuid4()),
            plan_date=plan_date,
            generated_at=datetime.now(timezone.utc).isoformat(),
            user_intentions=None,
            top_items=[],
            goal_micro_steps=[],
            nudge_at=None,
        )
        _persist(user_id, plan)
        return plan

    resp = _GENAI.models.generate_content(
        model=_MODEL,
        contents=_build_priorities_prompt(context, plan_date),
        config=types.GenerateContentConfig(
            system_instruction=_PRIORITIES_SYSTEM,
            response_mime_type="application/json",
            response_schema=PrioritiesRanking,
            temperature=0.3,
        ),
    )

    parsed: PrioritiesRanking | None = getattr(resp, "parsed", None)
    if parsed is None:
        parsed = PrioritiesRanking.model_validate_json(resp.text or "{}")

    items = parsed.items[:5]
    for i, item in enumerate(items, start=1):
        item.rank = i

    plan = DailyPlan(
        plan_id=str(uuid.uuid4()),
        plan_date=plan_date,
        generated_at=datetime.now(timezone.utc).isoformat(),
        user_intentions=None,
        top_items=items,
        goal_micro_steps=[],
        nudge_at=None,
    )
    _persist(user_id, plan)
    return plan
