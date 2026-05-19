CREATE TABLE IF NOT EXISTS quadrant.proposed_actions (
  action_id           STRING NOT NULL,
  user_id             STRING NOT NULL,
  action_type         STRING NOT NULL,         -- 'email_draft' | 'text_draft' | 'calendar_event'
  status              STRING NOT NULL,         -- 'drafted' | 'approved' | 'rejected' | 'sent' | 'expired'
  reasoning           STRING,
  related_signal_ids  ARRAY<STRING>,

  -- payload (nullable, depends on action_type)
  to_recipient        STRING,
  subject             STRING,
  body                STRING,
  event_start         TIMESTAMP,
  event_end           TIMESTAMP,
  attendees           ARRAY<STRING>,

  -- lifecycle
  drafted_at          TIMESTAMP NOT NULL,
  decided_at          TIMESTAMP,
  sent_at             TIMESTAMP,
  metadata            JSON
)
PARTITION BY DATE(drafted_at)
CLUSTER BY user_id, status;
