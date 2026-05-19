// Batch-save today's done items + their per-item notes into the
// notes_log table. Triggered at end of day (either by the user
// asking Quadri "save today's notes" or by an evening chat-dock
// prompt).
//
// Behavior: ONE row per (user_id, item_ref_id) — MERGE pattern. If
// the user runs this twice in a day, the second run refreshes the
// title/notes/source for items they've since edited rather than
// stacking duplicates.
//
// Title + source resolution:
//   - Tries proposed_actions.subject first (action-backed items).
//   - Falls back to quadrant_signals.title (signal-only items).
//   - Source comes from the related signal where available, else
//     literal "user".

import { bq, fqn, USER_ID } from "@/lib/bq";

export async function saveTodayNotesLog(
  planDate: string,
): Promise<{ count: number }> {
  // Pull every done ref for the plan date. We MERGE one row per
  // ref into notes_log, joining to item_notes for the user's note
  // text and pulling title/source from actions or signals.
  const sql = `
    MERGE ${fqn("notes_log")} T
    USING (
      WITH done_refs AS (
        SELECT DISTINCT item_ref_id
        FROM ${fqn("daily_slots")}
        WHERE user_id = @uid
          AND plan_date = DATE('${planDate}')
          AND done = TRUE
          AND item_ref_id IS NOT NULL
      ),
      action_lookup AS (
        SELECT
          p.action_id AS ref,
          ANY_VALUE(p.subject) AS title,
          ANY_VALUE(s.source) AS source
        FROM ${fqn("proposed_actions")} p
        LEFT JOIN UNNEST(p.related_signal_ids) AS sid
        LEFT JOIN ${fqn("quadrant_signals")} s
          ON s.signal_id = sid AND s.user_id = @uid
        WHERE p.user_id = @uid
          AND p.action_id IN (SELECT item_ref_id FROM done_refs)
        GROUP BY p.action_id
      ),
      signal_lookup AS (
        SELECT
          signal_id AS ref,
          title,
          source
        FROM ${fqn("quadrant_signals")}
        WHERE user_id = @uid
          AND signal_id IN (SELECT item_ref_id FROM done_refs)
      ),
      slot_text AS (
        SELECT
          item_ref_id AS ref,
          MAX(item_text) AS fallback_title
        FROM ${fqn("daily_slots")}
        WHERE user_id = @uid
          AND plan_date = DATE('${planDate}')
          AND done = TRUE
          AND item_ref_id IS NOT NULL
        GROUP BY item_ref_id
      ),
      notes_lookup AS (
        -- Defensive de-dup: item_notes is meant to be unique on
        -- (user, ref) but if duplicates ever creep in (streaming-
        -- buffer race, manual inserts) MERGE would die with
        -- "must match at most one source row". Aggregate to one row.
        SELECT
          item_ref_id AS ref,
          ANY_VALUE(notes) AS notes
        FROM ${fqn("item_notes")}
        WHERE user_id = @uid
        GROUP BY item_ref_id
      )
      SELECT
        @uid AS user_id,
        d.item_ref_id AS item_ref_id,
        COALESCE(a.title, s.title, st.fallback_title) AS title,
        n.notes AS notes,
        COALESCE(a.source, s.source, 'user') AS source,
        DATE('${planDate}') AS plan_date,
        CURRENT_TIMESTAMP() AS ts
      FROM done_refs d
      LEFT JOIN action_lookup a ON a.ref = d.item_ref_id
      LEFT JOIN signal_lookup s ON s.ref = d.item_ref_id
      LEFT JOIN slot_text st ON st.ref = d.item_ref_id
      LEFT JOIN notes_lookup n ON n.ref = d.item_ref_id
    ) S
    ON T.user_id = S.user_id AND T.item_ref_id = S.item_ref_id
    WHEN MATCHED THEN
      UPDATE SET
        title = S.title,
        notes = S.notes,
        source = S.source,
        plan_date = S.plan_date,
        done_at = S.ts
    WHEN NOT MATCHED THEN
      INSERT (user_id, item_ref_id, title, notes, source, plan_date, done_at)
      VALUES (S.user_id, S.item_ref_id, S.title, S.notes, S.source, S.plan_date, S.ts)
  `;

  await bq.query({
    query: sql,
    params: { uid: USER_ID },
  });

  // BQ Node client doesn't reliably surface DML-stats counts. Just
  // count the rows in notes_log for this plan_date — that's what
  // the user actually wants to know ("how many items got logged").
  const [countRows] = await bq.query({
    query: `
      SELECT COUNT(*) AS n
      FROM ${fqn("notes_log")}
      WHERE user_id = @uid AND plan_date = DATE('${planDate}')
    `,
    params: { uid: USER_ID },
  });
  const count = Number(
    (countRows as Array<{ n: number | string }>)[0]?.n ?? 0,
  );
  return { count };
}
