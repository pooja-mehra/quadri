-- User-set importance weights per quadrant.
-- Defaults: 0.25 each (equal). Bounds enforced in tool layer:
--   * each weight in [0.10, 0.50]
--   * weights sum to 1.0 (±0.01)

CREATE TABLE IF NOT EXISTS quadrant.user_quadrant_weights (
  user_id   STRING NOT NULL,
  quadrant  STRING NOT NULL,
  weight    FLOAT64 NOT NULL,
  source    STRING NOT NULL,         -- 'default' | 'user_set'
  set_at    TIMESTAMP NOT NULL
);

-- Seed defaults idempotently. MERGE only inserts rows that don't exist;
-- existing weights (default OR user-set) are preserved on re-run.
-- Note: alias the seed columns as uid/q/w to avoid name collision with the
-- target column `quadrant` and the dataset `quadrant`.
MERGE quadrant.user_quadrant_weights AS T
USING (
  SELECT "demo_user" AS uid, "health"        AS q, 0.25 AS w UNION ALL
  SELECT "demo_user",        "education",       0.25            UNION ALL
  SELECT "demo_user",        "career",          0.25            UNION ALL
  SELECT "demo_user",        "relationships",   0.25
) AS S
ON T.user_id = S.uid AND T.quadrant = S.q
WHEN NOT MATCHED THEN
  INSERT (user_id, quadrant, weight, source, set_at)
  VALUES (S.uid, S.q, S.w, "default", CURRENT_TIMESTAMP());
