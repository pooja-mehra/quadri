-- User settings — single row per user with a JSON blob.
-- Flexible structure so new toggles can be added without schema migrations.

CREATE TABLE IF NOT EXISTS quadrant.user_settings (
  user_id    STRING NOT NULL,
  settings   JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

-- Seed default settings for demo_user (idempotent — only inserts if absent).
MERGE quadrant.user_settings T
USING (
  SELECT
    "demo_user" AS user_id,
    JSON """
    {
      "data_sources": {
        "calendar": true,
        "gmail": true,
        "slack": true,
        "github": true,
        "notion": true
      },
      "actions": {
        "draft_email": true,
        "draft_text": true,
        "draft_calendar_event": true,
        "propose_goals": true,
        "auto_send_approved": false
      },
      "memory": {
        "remember_conversations": true,
        "auto_classify_signals": true,
        "cross_quadrant_insights": true
      },
      "notifications": {
        "morning_briefing": false,
        "sunday_rebalance": false,
        "body_double_sms": false,
        "forgotten_commitment_nudges": false
      }
    }
    """ AS settings
) S
ON T.user_id = S.user_id
WHEN NOT MATCHED THEN
  INSERT (user_id, settings, updated_at)
  VALUES (S.user_id, S.settings, CURRENT_TIMESTAMP());
