-- Classifier: Google Calendar (Fivetran) → quadrant.quadrant_signals
--
-- Reads from `agent_cal.event` — the Fivetran connector for the demo
-- Gmail (portfoliosentient@gmail.com). Whitelists the user's primary
-- calendar; skips Family, HOME, Holidays, etc.
--
-- Maps each event to a `quadrant_signals` row:
--   - `signal_id` = "cal:" + event.id (deterministic, lets us upsert)
--   - `occurred_at` = parsed start_date_time (timed) or start_date midnight UTC (all-day)
--   - `quadrant` = rule-based on event title (defaults to 'career')
--   - `weight` = 0.5 (default; tuneable later)
--   - `valence` = 'neutral' (default; could parse 'cancelled' → 'negative')
--   - metadata: duration_min, calendar name, link
--
-- Idempotent via MERGE on signal_id. Re-run as a scheduled query (every
-- ~15 min is fine for the demo cadence).

MERGE quadrant.quadrant_signals AS T
USING (
  SELECT
    CONCAT('cal:', e.id) AS signal_id,
    'demo_user' AS user_id,
    'calendar' AS source,
    e.id AS source_record_id,

    -- Timed event: parse the ISO start_date_time. All-day: midnight UTC of start_date.
    COALESCE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', e.start_date_time),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', e.start_date_time),
      TIMESTAMP(e.start_date)
    ) AS occurred_at,

    -- Quadrant inference: simple keyword rules. Catches the obvious; falls
    -- back to 'career'. Easy to swap for an LLM call later.
    CASE
      WHEN cl.summary = 'Matador Football' THEN 'health'
      -- Health: physical activity + medical. Use suffix-tolerant forms so
      -- "Running" matches via `running`, "swimming" via `swimming`, etc.
      -- Without these, the bare-stem regex `\brun\b` would not match the
      -- longer variant and the event falls through to the 'career' default.
      -- Health: physical activity + medical + solo meals (self-care).
      -- Solo "breakfast"/"lunch"/"dinner" is personal time, default to
      -- health. "X with Y" is handled by the relationships block below
      -- (evaluated AFTER) — but CASE only matches the first true branch,
      -- so we have to put the social-meal check BEFORE this one.
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(breakfast|lunch|coffee|dinner|drinks|brunch|tea) with\b'
      ) THEN 'relationships'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(happy hour|date night|hangout|catch up|family time|girls night|guys night|kids|reunion|wedding|birthday)\b'
      ) THEN 'relationships'
      -- Family / close-relation keywords. Catches titles like "Call mom
      -- or sister", "Brunch with dad", "Email cousin Priya" — anything
      -- mentioning a family relation goes here, not career/health.
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(mom|mommy|dad|daddy|mother|father|parent|parents|sister|brother|sibling|son|daughter|kid|kids|cousin|aunt|uncle|grandma|grandpa|grandmother|grandfather|grandparent|grandparents|family|partner|spouse|wife|husband|girlfriend|boyfriend|niece|nephew|in-law|in-laws)\b'
      ) THEN 'relationships'
      -- Outreach verb + named person → relationships (catches "Email
      -- Veda about brunch", "Call Priya about Q4", "Text Sam" etc).
      -- Heuristic: any "<verb> <some word>" where verb is reaching out
      -- and the target isn't obviously a work term. Word after the
      -- verb is captured but we don't filter by it — assumes that
      -- if the verb is reach-out-style, the target is a person.
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(email|call|text|message|msg|reply to|dm|ping|check in with|check-in with|catch up with|meet with) [a-z]+\b'
      ) THEN 'relationships'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(run|running|jog|jogging|gym|workout|yoga|swim|swimming|bike|biking|cycling|hike|hiking|walk|walking|doctor|dentist|physical|appointment|therapy|meditation|meditate|pilates|stretch|stretching|breakfast|lunch|dinner|brunch)\b'
      ) THEN 'health'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(e.summary, '')),
        r'\b(course|class|study|reading|learn|learning|cohort|book club|tutorial|lecture|workshop)\b'
      ) THEN 'education'
      -- (Relationships meal/social rules were moved above the Health
      -- block so "lunch with Maya" doesn't get caught by the bare
      -- "lunch" rule in Health. CASE picks the first matching branch.)
      ELSE 'career'
    END AS quadrant,

    CAST(NULL AS STRING) AS quadrant_secondary,
    0.5 AS weight,

    CASE
      WHEN e.status = 'cancelled' THEN 'negative'
      ELSE 'neutral'
    END AS valence,

    e.summary AS title,
    SUBSTR(IFNULL(e.description, e.summary), 1, 200) AS excerpt,
    CAST(NULL AS ARRAY<STRING>) AS participants,

    TO_JSON(STRUCT(
      cl.summary AS calendar,
      e.html_link AS link,
      -- duration in minutes (best-effort)
      CAST(
        TIMESTAMP_DIFF(
          COALESCE(
            SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', e.end_date_time),
            SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', e.end_date_time),
            TIMESTAMP(e.end_date)
          ),
          COALESCE(
            SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', e.start_date_time),
            SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', e.start_date_time),
            TIMESTAMP(e.start_date)
          ),
          MINUTE
        ) AS INT64
      ) AS duration_min,
      e.start_time_zone AS timezone,
      e.event_type AS event_type
    )) AS metadata,

    'rule' AS classified_by,
    'rule_calendar_v1' AS classified_ref_id,
    CURRENT_TIMESTAMP() AS ingested_at

  FROM `quadrant-495518.agent_cal.event` AS e
  JOIN `quadrant-495518.agent_cal.calendar_list` AS cl
    ON e.calendar_list_id = cl.id

  WHERE e._fivetran_deleted IS NOT TRUE
    AND IFNULL(e.status, 'confirmed') != 'cancelled'
    -- Whitelist: only the primary calendar for the demo Gmail.
    AND cl.summary IN ('portfoliosentient@gmail.com')
    -- Skip events Quadri itself wrote to Google Calendar. They're tagged
    -- via extendedProperties.private.quadri_origin="true". Without this
    -- filter we'd round-trip: write → Fivetran reads → classifier writes
    -- a synth signal → quadrant card shows it twice (slot + signal).
    -- Note: Fivetran's `event` schema exposes extended_properties as a
    -- nested STRUCT or as a flattened column depending on connector
    -- version. We probe with REGEXP on the JSON dump so it works either
    -- way without breaking if the column reshapes.
    AND NOT REGEXP_CONTAINS(
      TO_JSON_STRING(e),
      r'"quadri_origin"\s*:\s*"true"'
    )
    -- Sliding window: last 7 days through next 30 days. Old events not
    -- relevant; far-future events fill in over time.
    AND COALESCE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', e.start_date_time),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', e.start_date_time),
      TIMESTAMP(e.start_date)
    ) BETWEEN TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
          AND TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
) AS S
ON T.signal_id = S.signal_id
WHEN MATCHED THEN
  UPDATE SET
    occurred_at = S.occurred_at,
    quadrant = S.quadrant,
    weight = S.weight,
    valence = S.valence,
    title = S.title,
    excerpt = S.excerpt,
    metadata = S.metadata,
    ingested_at = S.ingested_at
WHEN NOT MATCHED BY TARGET THEN
  INSERT (signal_id, user_id, source, source_record_id, occurred_at,
          quadrant, quadrant_secondary, weight, valence, title, excerpt,
          participants, metadata, classified_by, classified_ref_id, ingested_at)
  VALUES (S.signal_id, S.user_id, S.source, S.source_record_id, S.occurred_at,
          S.quadrant, S.quadrant_secondary, S.weight, S.valence, S.title, S.excerpt,
          S.participants, S.metadata, S.classified_by, S.classified_ref_id, S.ingested_at)
-- Self-cleaning: remove any rule_calendar_v1 rows that no longer satisfy the
-- whitelist / window in the source query (e.g., calendar removed from the
-- whitelist, event deleted upstream, event aged out of the 7-day window).
WHEN NOT MATCHED BY SOURCE
  AND T.user_id = 'demo_user'
  AND T.source = 'calendar'
  AND T.classified_ref_id = 'rule_calendar_v1'
THEN DELETE;
