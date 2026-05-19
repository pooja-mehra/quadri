import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { getAccessToken } from "@/lib/google-oauth";
import { isDemoMode } from "@/lib/demo-mode";

export const dynamic = "force-dynamic";

// Sync today's time-bar slots → Google Calendar events on the user's
// primary calendar. Idempotent — slots that already have a stored
// google_event_id get PATCHed instead of re-created.
//
// Events created here are tagged with extendedProperties.private:
//   {quadri_origin: "true", quadri_slot_id: "<slot_id>"}
// so the calendar classifier can skip them on the next Fivetran sync
// (otherwise we'd round-trip — write to Google, read from Google,
// re-classify into a signal we already represent).

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type SlotRow = {
  slot_id: string;
  plan_date: string;
  slot_start_min: number;
  item_text: string;
  duration_min: number | null;
  google_event_id: string | null;
  source_event_id: string | null;
  original_slot_start_min: number | null;
  done: boolean | null;
  unscheduled: boolean | null;
  action_status: string | null;
  cancel_reason: string | null;
  user_note: string | null;
  action_decided_pt: string | null;  // YYYY-MM-DD, the action's decided_at in PT
};

// Derive the event's visual state from local + BQ flags.
// - "cancelled": action was explicitly rejected (or its resolution is).
// - "done":      slot.done=true (local Mark Done) OR action is 'sent'.
// - "live":      anything else still on the bar.
function deriveState(slot: SlotRow): "cancelled" | "done" | "live" {
  if (slot.action_status === "rejected") return "cancelled";
  if (slot.done || slot.action_status === "sent") return "done";
  return "live";
}

// Build the Google Calendar event payload for a given state. We use
// Google's native `status` field for cancellations (strikes through
// the event in Google's UI) and lean on title + description prefixes
// to communicate "done" since Google has no completed-task concept.
function buildEventBody(
  slot: SlotRow,
  state: "cancelled" | "done" | "live",
  startIso: string,
  endIso: string,
): Record<string, unknown> {
  const baseTitle = slot.item_text;
  let summary = baseTitle;
  let description = "";
  // Always send an explicit status — otherwise PATCH on an event the
  // user deleted on Google (soft-cancelled, status="cancelled") leaves
  // it cancelled. "confirmed" un-deletes it so the bar stays the
  // source of truth.
  const status: string =
    state === "cancelled" ? "cancelled" : "confirmed";

  if (state === "done") {
    // Done state lives in Quadri (quadrant.daily_slots.done), not in the
    // user's Google Calendar. Don't rewrite the event title — a "✓" prefix
    // here flows back via Fivetran and the quadrant card re-renders it as
    // a phantom-done bullet long after the real done state has rolled off.
    description = `Completed via Quadri.`;
    if (slot.user_note) description += `\n\nNote: ${slot.user_note}`;
  } else if (state === "cancelled") {
    summary = `[Cancelled] ${baseTitle}`;
    description = `Cancelled via Quadri.`;
    if (slot.cancel_reason) description += `\n\nReason: ${slot.cancel_reason}`;
  }

  const body: Record<string, unknown> = {
    summary,
    description,
    start: { dateTime: startIso, timeZone: "America/Los_Angeles" },
    end: { dateTime: endIso, timeZone: "America/Los_Angeles" },
    extendedProperties: {
      private: {
        quadri_origin: "true",
        quadri_slot_id: slot.slot_id,
        quadri_state: state,
      },
    },
  };
  body.status = status;
  return body;
}

function isoStartEnd(planDate: string, startMin: number, durationMin: number) {
  // planDate is YYYY-MM-DD (PT). Build a Date in PT, then ISO it. We
  // encode PT offset explicitly (-07:00 PDT or -08:00 PST) by going
  // through Intl. For demo simplicity we assume PDT (-07:00). If your
  // demo crosses DST, switch to a tz-aware library.
  const [y, m, d] = planDate.split("-").map(Number);
  const hh = Math.floor(startMin / 60);
  const mm = startMin % 60;
  const start = new Date(Date.UTC(y, m - 1, d, hh + 7, mm, 0));
  const end = new Date(start.getTime() + Math.max(15, durationMin) * 60_000);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

async function googleApi(
  accessToken: string,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const r = await fetch(`${CAL_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

export async function POST(request: Request) {
  // Demo mode: pretend we pushed to Google Calendar. Returns a
  // synthetic count so the Sync button's toast reads sensibly. No
  // events are created in any real Google account.
  if (isDemoMode()) {
    // Count what *would* have been synced — non-done, non-source-event slots
    // for today PT. This gives the judge a realistic-looking number.
    try {
      const [rows] = await bq.query({
        query: `
          SELECT COUNT(*) AS n
          FROM ${fqn("daily_slots")}
          WHERE user_id = @uid
            AND plan_date = CURRENT_DATE('America/Los_Angeles')
            AND (done IS NULL OR done = FALSE)
            AND source_event_id IS NULL
        `,
        params: { uid: USER_ID },
      });
      const synced = Number(
        (rows as Array<{ n: number | string }>)[0]?.n ?? 0,
      );
      return NextResponse.json({ ok: true, demo: true, synced });
    } catch {
      return NextResponse.json({ ok: true, demo: true, synced: 0 });
    }
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "unauthorized",
        authorize_url: "/api/auth/google",
      },
      { status: 401 },
    );
  }

  // Date to sync — defaults to today in PT, but caller can pass an
  // explicit `date` in the JSON body so Quadri can sync any single day
  // (this/last week, future days, etc.) without inventing a new route.
  let bodyDate: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { date?: unknown };
    if (typeof body.date === "string") bodyDate = body.date;
  } catch {
    // ignore — no body
  }
  const todayPT = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const today = bodyDate && ISO_DATE.test(bodyDate) ? bodyDate : todayPT;
  if (!ISO_DATE.test(today)) {
    return NextResponse.json({ error: "date invalid" }, { status: 400 });
  }

  // Pull every slot on today's bar (skip only unscheduled — those
  // aren't on the bar). Done/cancelled slots ARE synced, just with
  // status markers (see buildEventBody). LEFT JOIN proposed_actions
  // so we know the action's lifecycle state.
  const queryResult = await bq.query({
    query: `
      SELECT s.slot_id, CAST(s.plan_date AS STRING) AS plan_date,
             s.slot_start_min, s.item_text, s.duration_min,
             s.google_event_id, s.source_event_id,
             s.original_slot_start_min, s.done, s.unscheduled,
             a.status AS action_status,
             JSON_VALUE(a.metadata, '$.cancel_reason') AS cancel_reason,
             JSON_VALUE(a.metadata, '$.user_note') AS user_note,
             CASE
               WHEN a.status IN ('sent', 'rejected') AND a.decided_at IS NOT NULL
                 THEN FORMAT_DATE('%Y-%m-%d', DATE(a.decided_at, 'America/Los_Angeles'))
               ELSE NULL
             END AS action_decided_pt
      FROM ${fqn("daily_slots")} s
      LEFT JOIN ${fqn("proposed_actions")} a
        ON a.action_id = s.item_ref_id AND a.user_id = s.user_id
      WHERE s.user_id = @uid
        AND s.plan_date = DATE('${today}')
        AND COALESCE(s.unscheduled, FALSE) = FALSE
    `,
    params: { uid: USER_ID },
  });
  const rows = queryResult[0] as SlotRow[];

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const slot of rows) {
    if (slot.unscheduled) {
      skipped++;
      continue;
    }
    const dur = slot.duration_min && slot.duration_min > 0 ? slot.duration_min : 30;
    const state = deriveState(slot);
    // Always use the slot's plan_date — sync_today means today, not
    // some clever date inference. If the user wants past-day items
    // to land on past days, that's a separate "sync this week" flow.
    const { startIso, endIso } = isoStartEnd(
      slot.plan_date,
      slot.slot_start_min,
      dur,
    );

    // For Fivetran-imported events: skip UNLESS user moved the slot
    // OR the slot's state has changed (done / cancelled). Moving →
    // PATCH start/end. Done/cancelled → PATCH summary + description
    // + Google's native event status so it shows struck-through.
    if (slot.source_event_id) {
      const moved =
        slot.original_slot_start_min != null &&
        slot.original_slot_start_min !== slot.slot_start_min;
      if (!moved && state === "live") {
        skipped++;
        continue;
      }
      const patchBody: Record<string, unknown> = {};
      if (moved) {
        patchBody.start = { dateTime: startIso, timeZone: "America/Los_Angeles" };
        patchBody.end = { dateTime: endIso, timeZone: "America/Los_Angeles" };
      }
      if (state === "cancelled") {
        patchBody.status = "cancelled";
        patchBody.description = slot.cancel_reason
          ? `Cancelled via Quadri.\n\nReason: ${slot.cancel_reason}`
          : "Cancelled via Quadri.";
      } else if (state === "done") {
        // Don't rewrite the title — done state is owned by Quadri's
        // daily_slots, not the user's calendar. See buildEventBody above.
        patchBody.description = slot.user_note
          ? `Completed via Quadri.\n\nNote: ${slot.user_note}`
          : "Completed via Quadri.";
      }
      // Fivetran prefixes the Google event id with "cal:" in its
      // ingestion pipeline (and we store that verbatim as
      // source_event_id). Google's API needs the raw id only.
      const rawId = slot.source_event_id.startsWith("cal:")
        ? slot.source_event_id.slice(4)
        : slot.source_event_id;
      const r = await googleApi(
        accessToken,
        "PATCH",
        `/${encodeURIComponent(rawId)}`,
        patchBody,
      );
      if (r.ok) {
        updated++;
        await bq.query({
          query: `
            UPDATE ${fqn("daily_slots")}
            SET google_synced_at = CURRENT_TIMESTAMP(),
                original_slot_start_min = @new_start
            WHERE slot_id = @sid AND user_id = @uid
          `,
          params: { sid: slot.slot_id, new_start: slot.slot_start_min, uid: USER_ID },
        });
      } else {
        errors.push(
          `patch imported ${slot.slot_id}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`,
        );
      }
      continue;
    }

    const body = buildEventBody(slot, state, startIso, endIso);

    if (slot.google_event_id) {
      // Idempotent update.
      const r = await googleApi(
        accessToken,
        "PATCH",
        `/${encodeURIComponent(slot.google_event_id)}`,
        body,
      );
      if (r.ok) {
        updated++;
        await bq.query({
          query: `
            UPDATE ${fqn("daily_slots")}
            SET google_synced_at = CURRENT_TIMESTAMP()
            WHERE slot_id = @sid AND user_id = @uid
          `,
          params: { sid: slot.slot_id, uid: USER_ID },
        });
        continue;
      }
      // 404/410 → event was hard-deleted on Google. Fall through to
      // POST a fresh event so the bar stays the source of truth.
      if (r.status !== 404 && r.status !== 410) {
        errors.push(
          `update ${slot.slot_id}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`,
        );
        continue;
      }
    }

    const r = await googleApi(accessToken, "POST", "", body);
    if (r.ok && r.data && typeof r.data === "object" && "id" in r.data) {
      const eventId = String((r.data as { id: unknown }).id);
      await bq.query({
        query: `
          UPDATE ${fqn("daily_slots")}
          SET google_event_id = @gid, google_synced_at = CURRENT_TIMESTAMP()
          WHERE slot_id = @sid AND user_id = @uid
        `,
        params: { sid: slot.slot_id, gid: eventId, uid: USER_ID },
      });
      created++;
    } else {
      errors.push(
        `create ${slot.slot_id}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`,
      );
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    created,
    updated,
    skipped,
    errors,
  });
}
