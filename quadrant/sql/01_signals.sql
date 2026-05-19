CREATE TABLE IF NOT EXISTS quadrant.quadrant_signals (
  signal_id          STRING NOT NULL,
  user_id            STRING NOT NULL,
  source             STRING NOT NULL,
  source_record_id   STRING NOT NULL,
  occurred_at        TIMESTAMP NOT NULL,
  quadrant           STRING,
  quadrant_secondary STRING,
  weight             FLOAT64 NOT NULL,
  valence            STRING NOT NULL,
  title              STRING,
  excerpt            STRING,
  participants       ARRAY<STRING>,
  metadata           JSON,
  classified_by      STRING NOT NULL,
  classified_ref_id  STRING,
  ingested_at        TIMESTAMP NOT NULL
)
PARTITION BY DATE(occurred_at)
CLUSTER BY user_id, quadrant;
