-- daily_plan_v1 — sidecar table for the in-app "Plan today" loop.
--
-- One row per (user_id, plan_date). Holds the top-3 day items + a
-- per-goal micro-step generated alongside them, plus optional user
-- intentions and an opt-in mid-day nudge time.
--
-- Why a sidecar (not extending user_goals): keeps goal semantics stable,
-- gives clean longitudinal history for the EOD recap and analytics, and
-- lets us re-plan within a day without rewriting goal rows.
--
-- Idempotency: writers should MERGE on (user_id, plan_date) so a re-plan
-- replaces the day's plan rather than appending.

CREATE TABLE IF NOT EXISTS quadrant.daily_plan_v1 (
  plan_id          STRING NOT NULL,
  user_id          STRING NOT NULL,
  plan_date        DATE NOT NULL,                  -- user-local date the plan applies to
  generated_at     TIMESTAMP NOT NULL,
  user_intentions  STRING,                         -- free-text the user typed, may be empty

  -- Top-3 day items. `source` records where each item came from so the UI
  -- can show the chain (signals -> goal -> today's step) the user lost
  -- track of. `source_ref_id` is the action_id or goal_id when applicable.
  top_items        ARRAY<STRUCT<
    rank             INT64,
    text             STRING,
    source           STRING,                       -- 'pending_action' | 'goal' | 'user'
    source_ref_id    STRING,
    cited_signal_ids ARRAY<STRING>
  >>,

  -- One micro-step per active goal where the planner had something
  -- concrete to suggest for today. Decoupled from pending actions in v1
  -- (see project_plan_today_loop memory). Render nothing for goals with
  -- no micro-step.
  goal_micro_steps ARRAY<STRUCT<
    goal_id          STRING,
    text             STRING,
    cited_signal_ids ARRAY<STRING>
  >>,

  nudge_at         TIMESTAMP,                      -- opt-in mid-day check-in (in-app only in v1)
  metadata         JSON
)
PARTITION BY plan_date
CLUSTER BY user_id;
