-- Score formula (0–10):
--   engagement: 0–5 from total weight (saturates once total_weight >= 2.0)
--   sentiment:  -2 to +5 from (positive_weight - negative_weight)
-- Sum, clamped to [0, 10]. Zero engagement = score 0.
--
-- under_funded_score = score / user_weight.
-- Lower = the quadrant is under-served relative to how much the user said
-- it matters. Agent surfaces lowest under_funded_score first.
--
-- Trailing 14 days for the demo; Sunday rebalance can re-window to 7 later.

CREATE OR REPLACE VIEW quadrant.vw_quadrant_scores_current AS
WITH window_signals AS (
  -- Current-week window (Mon → Sun in PT). Powers both score math and the
  -- visible bullet list. Anything older or further-future is out of scope
  -- for "this week's progress."
  SELECT *
  FROM quadrant.quadrant_signals
  WHERE user_id = "demo_user"
    AND DATE(occurred_at, "America/Los_Angeles") BETWEEN
      DATE_TRUNC(CURRENT_DATE("America/Los_Angeles"), WEEK(MONDAY))
      AND DATE_ADD(DATE_TRUNC(CURRENT_DATE("America/Los_Angeles"), WEEK(MONDAY)),
                   INTERVAL 6 DAY)
),
score_rollup AS (
  -- Score math includes source='projected' lifecycle nudges so commit/send
  -- actually moves the displayed score.
  SELECT
    quadrant,
    COUNT(*) AS signal_count,
    SUM(IF(valence = "positive", weight, 0)) AS positive_weight,
    SUM(IF(valence = "negative", weight, 0)) AS negative_weight,
    SUM(weight) AS total_weight
  FROM window_signals
  WHERE quadrant IN ("health", "education", "career", "relationships")
  GROUP BY quadrant
),
display_signals AS (
  -- Bullet list shows real-source items only. Lifecycle synthetic rows
  -- ("Committed: …", "Sent: …") are score-only.
  SELECT *
  FROM window_signals
  WHERE source != "projected"
),
display_rollup AS (
  SELECT
    quadrant,
    ARRAY_AGG(
      STRUCT(signal_id, title, valence, weight, excerpt, occurred_at, source)
      ORDER BY occurred_at ASC LIMIT 10
    ) AS top_signals
  FROM display_signals
  WHERE quadrant IN ("health", "education", "career", "relationships")
  GROUP BY quadrant
),
all_quadrants AS (
  SELECT "health"        AS quadrant UNION ALL
  SELECT "education"     UNION ALL
  SELECT "career"        UNION ALL
  SELECT "relationships"
),
scored AS (
  SELECT
    aq.quadrant,
    COALESCE(s.signal_count, 0)                              AS signal_count,
    ROUND(COALESCE(s.positive_weight, 0), 2)                 AS positive_weight,
    ROUND(COALESCE(s.negative_weight, 0), 2)                 AS negative_weight,
    ROUND(COALESCE(s.total_weight, 0), 2)                    AS total_weight,
    ROUND(LEAST(10.0, GREATEST(0.0,
      5.0 * LEAST(1.0, COALESCE(s.total_weight, 0) / 2.0)
      + 2.5 * (COALESCE(s.positive_weight, 0) - COALESCE(s.negative_weight, 0))
    )), 1)                                                   AS score,
    COALESCE(w.weight, 0.25)                                 AS user_weight,
    COALESCE(w.source, "default")                            AS weight_source,
    COALESCE(d.top_signals, [])                              AS top_signals
  FROM all_quadrants aq
  LEFT JOIN score_rollup s USING (quadrant)
  LEFT JOIN display_rollup d USING (quadrant)
  LEFT JOIN `quadrant-495518.quadrant.user_quadrant_weights` w
    ON w.user_id = "demo_user" AND w.quadrant = aq.quadrant
)
SELECT
  *,
  ROUND(score / NULLIF(user_weight, 0), 2) AS under_funded_score
FROM scored
ORDER BY under_funded_score ASC;
