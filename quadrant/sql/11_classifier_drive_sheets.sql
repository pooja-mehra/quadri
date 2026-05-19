-- Classifier: Google Drive Sheets (Fivetran) → quadrant.quadrant_signals
--
-- Reads from the per-tab tables Fivetran's Google Drive connector lands
-- in `quadrant-495518.google_drive.*`. Two sheets in scope for the demo:
--   * gk_4_i_project_tracker_sheet_1   (Tasks tab — owner / due / status)
--   * gk_4_i_beta_feedback_sheet_1     (Forms→Sheets responses)
--
-- Each row in scope produces one quadrant_signals row. Idempotent via MERGE
-- on signal_id. Re-run as a scheduled query (~15 min cadence is fine).
--
-- Sister classifier `12_classifier_drive_documents.sql` (TBD) will read
-- Docs/Slides/PDFs from `quadrant.drive_documents_raw` (populated by
-- app.drive_ingest). Same target table.

MERGE quadrant.quadrant_signals AS T
USING (

  ----------------------------------------------------------------------
  -- 1. Project tracker rows → urgent/important signal
  ----------------------------------------------------------------------
  SELECT
    CONCAT('sheet:gk4i_tracker:', CAST(t._line AS STRING))  AS signal_id,
    'demo_user'                                              AS user_id,
    'google_drive_sheet'                                     AS source,
    CAST(t._line AS STRING)                                  AS source_record_id,

    -- Due date midnight UTC. Rows without a due date fall back to sync time
    -- so they don't get dropped — the agent can still surface them.
    COALESCE(TIMESTAMP(t.due), t._fivetran_synced)           AS occurred_at,

    -- All GK4I project work classifies as career for v1. Refine later via
    -- LLM extraction if cross-quadrant tasks appear.
    'career'                                                 AS quadrant,
    CAST(NULL AS STRING)                                     AS quadrant_secondary,

    -- Weight ladder: just-fixed (user-marked → email needed) >
    -- overdue > blocked > in-progress > not-started.
    -- "staus" (typo intentional — that's the user's column name in
    -- the GK4I tracker) carries a freeform user note; we treat
    -- "fixed" as the trigger for "follow-up email needed".
    CASE
      WHEN LOWER(IFNULL(t.staus, '')) = 'fixed'               THEN 0.85
      WHEN LOWER(IFNULL(t.status, '')) = 'overdue'
        OR (t.due IS NOT NULL AND t.due < CURRENT_DATE())     THEN 0.9
      WHEN LOWER(IFNULL(t.status, '')) = 'blocked'            THEN 0.7
      WHEN LOWER(IFNULL(t.status, '')) = 'in progress'        THEN 0.5
      ELSE 0.4
    END                                                       AS weight,

    CASE
      WHEN LOWER(IFNULL(t.staus, '')) = 'fixed'               THEN 'positive'
      WHEN LOWER(IFNULL(t.status, '')) = 'overdue'
        OR (t.due IS NOT NULL AND t.due < CURRENT_DATE())     THEN 'negative'
      ELSE 'neutral'
    END                                                       AS valence,

    t.task                                                    AS title,
    SUBSTR(IFNULL(t.notes, t.task), 1, 200)                  AS excerpt,

    -- Owner goes in participants so the UI can show who's responsible.
    CASE WHEN t.owner IS NULL THEN CAST(NULL AS ARRAY<STRING>)
         ELSE [t.owner] END                                   AS participants,

    TO_JSON(STRUCT(
      'project_tracker'              AS sheet,
      t.status                       AS status,
      t.staus                        AS user_status,
      t.owner                        AS owner,
      t.due                          AS due_date,
      t.notes                        AS notes,
      t.dev_notes                    AS dev_notes,
      'gk_4_i_project_tracker'       AS source_file
    ))                                                        AS metadata,

    'rule'                                                    AS classified_by,
    'rule_drive_sheet_tracker_v1'                             AS classified_ref_id,
    CURRENT_TIMESTAMP()                                       AS ingested_at

  FROM `quadrant-495518.google_drive.gk_4_i_project_tracker_sheet_1` AS t

  WHERE t.task IS NOT NULL
    -- Skip completed work.
    AND LOWER(IFNULL(t.status, '')) NOT IN ('done', 'completed', 'complete')

  UNION ALL

  ----------------------------------------------------------------------
  -- 2. Beta feedback rows that need follow-up → response signal
  ----------------------------------------------------------------------
  SELECT
    CONCAT('sheet:gk4i_feedback:', CAST(f._line AS STRING))  AS signal_id,
    'demo_user'                                              AS user_id,
    'google_drive_sheet'                                     AS source,
    CAST(f._line AS STRING)                                  AS source_record_id,

    -- Forms timestamps land as strings. Try a couple of common formats;
    -- fall back to fivetran sync time if both fail.
    COALESCE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', f.timestamp),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M',    f.timestamp),
      SAFE.PARSE_TIMESTAMP('%m/%d/%Y %H:%M:%S', f.timestamp),
      f._fivetran_synced
    )                                                        AS occurred_at,

    'career'                                                 AS quadrant,
    CAST(NULL AS STRING)                                     AS quadrant_secondary,

    -- Weight ladder: explicit "urgent" follow-up > low rating > standard.
    CASE
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(f.follow_up_, '')), r'urgent') THEN 0.9
      WHEN f.rating IS NOT NULL AND f.rating <= 2                       THEN 0.7
      ELSE 0.5
    END                                                       AS weight,

    -- Valence reflects the feedback tone, not whether *we* feel good
    -- about it. Bug reports → negative; happy users → positive.
    CASE
      WHEN f.rating IS NOT NULL AND f.rating <= 2 THEN 'negative'
      WHEN f.rating IS NOT NULL AND f.rating >= 4 THEN 'positive'
      ELSE 'neutral'
    END                                                       AS valence,

    CONCAT('Beta feedback from ', IFNULL(f.name, 'anonymous')) AS title,

    -- Prefer the gripe; fall back to what worked.
    SUBSTR(
      COALESCE(NULLIF(f.what_didn_t, ''), f.what_worked, ''),
      1, 200
    )                                                         AS excerpt,

    CASE WHEN f.email IS NULL THEN CAST(NULL AS ARRAY<STRING>)
         ELSE [f.email] END                                   AS participants,

    TO_JSON(STRUCT(
      'beta_feedback'                AS sheet,
      f.name                         AS responder_name,
      f.email                        AS responder_email,
      f.rating                       AS rating,
      f.follow_up_                   AS follow_up,
      f.what_worked                  AS what_worked,
      f.what_didn_t                  AS what_didnt,
      'gk_4_i_beta_feedback'         AS source_file
    ))                                                        AS metadata,

    'rule'                                                    AS classified_by,
    'rule_drive_sheet_feedback_v1'                            AS classified_ref_id,
    CURRENT_TIMESTAMP()                                       AS ingested_at

  FROM `quadrant-495518.google_drive.gk_4_i_beta_feedback_sheet_1` AS f

  -- Only surface rows that need follow-up. "No" / blank means user already
  -- handled it (or it was a thumbs-up).
  WHERE LOWER(IFNULL(f.follow_up_, '')) LIKE 'yes%'

) AS S

ON  T.signal_id = S.signal_id

WHEN MATCHED THEN UPDATE SET
  occurred_at        = S.occurred_at,
  quadrant           = S.quadrant,
  quadrant_secondary = S.quadrant_secondary,
  weight             = S.weight,
  valence            = S.valence,
  title              = S.title,
  excerpt            = S.excerpt,
  participants       = S.participants,
  metadata           = S.metadata,
  classified_by      = S.classified_by,
  classified_ref_id  = S.classified_ref_id,
  ingested_at        = S.ingested_at

WHEN NOT MATCHED THEN
  INSERT (
    signal_id, user_id, source, source_record_id, occurred_at,
    quadrant, quadrant_secondary, weight, valence,
    title, excerpt, participants, metadata,
    classified_by, classified_ref_id, ingested_at
  )
  VALUES (
    S.signal_id, S.user_id, S.source, S.source_record_id, S.occurred_at,
    S.quadrant, S.quadrant_secondary, S.weight, S.valence,
    S.title, S.excerpt, S.participants, S.metadata,
    S.classified_by, S.classified_ref_id, S.ingested_at
  );
