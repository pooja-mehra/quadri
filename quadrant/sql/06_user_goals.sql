-- User goals with proposal/approval lifecycle.
--
-- Status flow:
--   user_set     → status='active' immediately
--   derived      → status='proposed' until user approves; then 'active'
--   any          → can be 'archived' (rejected or paused)
--
-- The agent reads only active goals when grounding its reasoning. Proposed
-- goals show up only when the user asks "what have you proposed?".

CREATE TABLE IF NOT EXISTS quadrant.user_goals (
  goal_id                 STRING NOT NULL,
  user_id                 STRING NOT NULL,
  quadrant                STRING NOT NULL,
  title                   STRING NOT NULL,
  description             STRING NOT NULL,
  source                  STRING NOT NULL,         -- 'user_set' | 'derived' | 'imported'
  status                  STRING NOT NULL,         -- 'proposed' | 'active' | 'archived'

  derived_from_signal_ids ARRAY<STRING>,
  derived_reasoning       STRING,
  derived_confidence      FLOAT64,

  proposed_at             TIMESTAMP NOT NULL,
  approved_at             TIMESTAMP,
  archived_at             TIMESTAMP,
  active_from             DATE,
  active_until            DATE,
  metadata                JSON
)
PARTITION BY DATE(proposed_at)
CLUSTER BY user_id, status, quadrant;

-- Seed 5 active goals for the demo persona. Idempotent via MERGE on goal_id.
MERGE quadrant.user_goals AS T
USING (
  SELECT
    "goal_001"  AS gid,
    "career"    AS q,
    "Ship investor update on schedule"           AS title,
    "Send the quarterly investor letter by the last business day of each quarter, with at least 24h buffer for review."  AS description
  UNION ALL
  SELECT "goal_002", "career", "Quarterly OKR sync with Maria",
    "Run a 60-min OKR review with Maria every quarter — ensures alignment and unblocks headcount asks."
  UNION ALL
  SELECT "goal_003", "health", "Run 3x per week minimum",
    "Maintain at least 3 runs per week (any distance). Consistency over volume."
  UNION ALL
  SELECT "goal_004", "health", "Stay current on annual physical",
    "Confirm and attend the annual physical when scheduled. Don't reschedule more than once."
  UNION ALL
  SELECT "goal_005", "relationships", "Weekly check-in with family",
    "At least one meaningful conversation (call, not text) with mom or sister every week."
) AS S
ON T.goal_id = S.gid
WHEN NOT MATCHED THEN
  INSERT (goal_id, user_id, quadrant, title, description, source, status,
          derived_from_signal_ids, derived_reasoning, derived_confidence,
          proposed_at, approved_at, archived_at, active_from, active_until, metadata)
  VALUES (S.gid, "demo_user", S.q, S.title, S.description, "user_set", "active",
          [], NULL, NULL,
          CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), NULL,
          CURRENT_DATE(), NULL, NULL);
