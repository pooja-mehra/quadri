-- daily_slots — persistent time-bar slots per user-local date.
--
-- v1 lived in localStorage only, which limited the data to a single
-- browser/device and dropped past slots when planDate rolled. This table
-- gives us durable history and forward visibility — the user can see what
-- they scheduled yesterday, and Quadri (or a future scheduler) can plan
-- ahead.
--
-- The UI keeps localStorage as a synchronous read-cache for instant
-- render; writes go through this table so the cache is fast but never
-- the source of truth.
--
-- Idempotency: writers MERGE on slot_id so re-saves of the same slot are
-- updates, not duplicates.

CREATE TABLE IF NOT EXISTS quadrant.daily_slots (
  slot_id                 STRING NOT NULL,
  user_id                 STRING NOT NULL,
  plan_date               DATE NOT NULL,
  slot_start_min          INT64,                       -- minutes from midnight (user-local)
  item_kind               STRING,                       -- 'pending_action' | 'committed_action' | 'goal' | 'user' | 'forgotten_commitment'
  item_ref_id             STRING,                       -- action_id, signal_id, or other ref
  item_text               STRING,                       -- snapshot title for display
  duration_min            INT64,
  source_event_id         STRING,                       -- Google Calendar event id, when calendar-imported
  done                    BOOL,
  unscheduled             BOOL,                         -- × off the bar but not deleted (parked in panel)
  auto_send_enabled       BOOL,
  auto_send_at_iso        TIMESTAMP,
  original_slot_start_min INT64,                        -- for the "moved · originally HH:MM" indicator
  created_at              TIMESTAMP NOT NULL,
  updated_at              TIMESTAMP NOT NULL
)
PARTITION BY plan_date
CLUSTER BY user_id, slot_id;
