import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { getAccessToken } from "@/lib/google-oauth";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";

// Remove an item from today's calendar. Two layers:
//   1. Delete the matching daily_slots row(s) for (user, plan_date,
//      item_ref_id) — that drops it from the strip immediately.
//   2. If any of those rows had a google_event_id set (i.e. the user
//      previously synced this slot to Google Calendar), DELETE the
//      event on Google's side too so we don't leave a ghost.
//
// Body: { plan_date: "YYYY-MM-DD", item_ref_id?: string,
//         slot_id?: string }
// Either item_ref_id OR slot_id is required.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAL_BASE =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export async function POST(request: Request) {
  let body: { plan_date?: unknown; item_ref_id?: unknown; slot_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const planDate = typeof body.plan_date === "string" ? body.plan_date : "";
  if (!ISO_DATE.test(planDate)) {
    return NextResponse.json(
      { error: "plan_date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const itemRefId =
    typeof body.item_ref_id === "string" ? body.item_ref_id : null;
  const slotId = typeof body.slot_id === "string" ? body.slot_id : null;
  if (!itemRefId && !slotId) {
    return NextResponse.json(
      { error: "item_ref_id or slot_id is required" },
      { status: 400 },
    );
  }

  // Google-Calendar-sourced chips on the strip use a synthetic ref
  // `cal_<event_id>` (no backing daily_slots row — they came IN via
  // Fivetran, not OUT via Sync). Detect the prefix so we can DELETE
  // the underlying Google event AND drop the quadrant_signals row,
  // even though the daily_slots DELETE below will match zero.
  const CAL_REF_PREFIX = "cal_";
  const isCalEventRef =
    itemRefId != null && itemRefId.startsWith(CAL_REF_PREFIX);
  const calEventId = isCalEventRef
    ? itemRefId!.slice(CAL_REF_PREFIX.length)
    : null;

  try {
    // 1. Find google_event_ids on the rows we're about to delete so
    //    we can clean Google Calendar in step 2.
    const findParams: Record<string, unknown> = { uid: USER_ID };
    let findFilter = "";
    if (slotId) {
      findFilter = "AND slot_id = @sid";
      findParams.sid = slotId;
    } else if (itemRefId) {
      findFilter = "AND item_ref_id = @ref";
      findParams.ref = itemRefId;
    }
    const [rows] = await bq.query({
      query: `
        SELECT slot_id, google_event_id
        FROM ${fqn("daily_slots")}
        WHERE user_id = @uid
          AND plan_date = DATE('${planDate}')
          ${findFilter}
      `,
      params: findParams,
    });
    const eventIds = (
      rows as Array<{ slot_id: string; google_event_id: string | null }>
    )
      .map((r) => r.google_event_id)
      .filter((v): v is string => !!v);

    // For Google-source events, the cal_<event_id> *is* the Google
    // event id to delete — slip it into the same delete list.
    if (calEventId) eventIds.push(calEventId);

    // 2. Delete from BQ first (cheap, local).
    await bq.query({
      query: `
        DELETE FROM ${fqn("daily_slots")}
        WHERE user_id = @uid
          AND plan_date = DATE('${planDate}')
          ${findFilter}
      `,
      params: findParams,
    });

    // 2b. For Google-source events, also drop the matching
    //     quadrant_signals row so /api/calendar/today stops
    //     returning it on the next refetch. The classifier's MERGE
    //     "NOT MATCHED BY SOURCE THEN DELETE" path would eventually
    //     do this after Fivetran resyncs, but we want immediate UI.
    if (calEventId) {
      await bq.query({
        query: `
          DELETE FROM ${fqn("quadrant_signals")}
          WHERE user_id = @uid AND signal_id = @sig
        `,
        params: { uid: USER_ID, sig: `cal:${calEventId}` },
      });
    }

    // 3. Delete from Google Calendar best-effort. We don't fail the
    //    whole call if Google rejects (event may already be gone, or
    //    the token might be missing) — the BQ side is the source of
    //    truth for what shows in the strip. In demo mode we skip
    //    the Google-side delete entirely (no token, no real events).
    if (eventIds.length > 0 && !isDemoMode()) {
      let token: string | null = null;
      try {
        token = await getAccessToken();
      } catch {
        token = null;
      }
      if (token) {
        await Promise.all(
          eventIds.map((eid) =>
            fetch(`${CAL_BASE}/${encodeURIComponent(eid)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            }).catch(() => null),
          ),
        );
      }
    }
    return NextResponse.json({
      ok: true,
      removed_slots: rows.length,
      google_events_removed: eventIds.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
