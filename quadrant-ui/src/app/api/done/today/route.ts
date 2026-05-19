import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Today's "done" feed — combines two paths into one ranked list:
//   1. daily_slots rows with done=TRUE on today's plan_date
//      (user pressed Done on a signal/calendar event/scheduled item).
//   2. proposed_actions sent today (status='sent' with sent_at in PT
//      today) — covers emails the user actually sent via /api/gmail/send
//      or had drafts fire from the FastAPI poller.
//
// Each row resolves to a human-readable title using the same fallback
// chain the focus card uses: action.subject → signal.title → slot.item_text.
//
// Returns: { items: [{ ref_id, title, source, done_at }] }
// `source` is one of: 'email' | 'calendar' | 'google_drive_sheet' |
// 'google_drive_doc' | 'user' (and any new sources added later).

type DoneItem = {
  ref_id: string;
  title: string;
  source: string;
  done_at: string;
};

export async function GET() {
  try {
    const [rows] = await bq.query({
      query: `
        WITH today_slots AS (
          SELECT
            item_ref_id AS ref_id,
            MAX(item_text) AS slot_text,
            MAX(updated_at) AS slot_done_at
          FROM ${fqn("daily_slots")}
          WHERE user_id = @uid
            AND plan_date = CURRENT_DATE('America/Los_Angeles')
            AND done = TRUE
            AND item_ref_id IS NOT NULL
          GROUP BY item_ref_id
        ),
        today_sent AS (
          SELECT
            action_id AS ref_id,
            ANY_VALUE(subject) AS action_subject,
            MAX(sent_at) AS action_sent_at,
            -- Source = source of the first related signal where set,
            -- else 'user' so we always have a label.
            ANY_VALUE((
              SELECT s.source FROM UNNEST(p.related_signal_ids) sid
              JOIN ${fqn("quadrant_signals")} s
                ON s.signal_id = sid AND s.user_id = @uid
              LIMIT 1
            )) AS action_source
          FROM ${fqn("proposed_actions")} p
          WHERE p.user_id = @uid
            AND p.status = 'sent'
            AND DATE(p.sent_at, 'America/Los_Angeles')
              = CURRENT_DATE('America/Los_Angeles')
          GROUP BY action_id
        ),
        combined AS (
          SELECT ref_id, slot_text AS title_hint, NULL AS subject,
                 NULL AS source, slot_done_at AS done_at
          FROM today_slots
          UNION ALL
          SELECT ref_id, NULL, action_subject, action_source, action_sent_at
          FROM today_sent
        ),
        signal_titles AS (
          SELECT signal_id, ANY_VALUE(title) AS sig_title,
                 ANY_VALUE(source) AS sig_source
          FROM ${fqn("quadrant_signals")}
          WHERE user_id = @uid
          GROUP BY signal_id
        ),
        action_meta AS (
          -- Pull subjects + signal-sourced source for refs that are
          -- action_ids (the today_sent CTE already has subjects but
          -- slot rows might carry action_ids whose source we want).
          SELECT
            p.action_id AS ref_id,
            ANY_VALUE(p.subject) AS subject,
            ANY_VALUE((
              SELECT s.source FROM UNNEST(p.related_signal_ids) sid
              JOIN ${fqn("quadrant_signals")} s
                ON s.signal_id = sid AND s.user_id = @uid
              LIMIT 1
            )) AS source
          FROM ${fqn("proposed_actions")} p
          WHERE p.user_id = @uid
          GROUP BY p.action_id
        )
        SELECT
          c.ref_id,
          COALESCE(c.subject, a.subject, s.sig_title, c.title_hint, c.ref_id) AS title,
          COALESCE(c.source, a.source, s.sig_source, 'user') AS source,
          MAX(c.done_at) AS done_at
        FROM combined c
        LEFT JOIN signal_titles s ON s.signal_id = c.ref_id
        LEFT JOIN action_meta a ON a.ref_id = c.ref_id
        GROUP BY c.ref_id, title, source
        ORDER BY done_at DESC
        LIMIT 50
      `,
      params: { uid: USER_ID },
    });

    const items: DoneItem[] = (
      rows as Array<{
        ref_id: string;
        title: string | null;
        source: string | null;
        done_at: { value: string } | string | null;
      }>
    ).map((r) => ({
      ref_id: r.ref_id,
      title: r.title ?? r.ref_id,
      source: r.source ?? "user",
      done_at:
        typeof r.done_at === "string"
          ? r.done_at
          : r.done_at && typeof r.done_at === "object" && "value" in r.done_at
            ? r.done_at.value
            : "",
    }));

    return NextResponse.json({ items });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
