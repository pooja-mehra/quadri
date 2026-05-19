import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Persistent slot storage. v1 was localStorage-only; this gives us
// past/future visibility and cross-device durability. localStorage still
// acts as a synchronous read cache on the client.
//
// GET  /api/slots?plan_date=YYYY-MM-DD  → list slots for that date.
// POST /api/slots                       → replace the slot set for a date.
//   body: { plan_date, slots: Slot[] }

type SlotPayload = {
  slot_id: string;
  slot_start_min: number;
  item_kind?: string | null;
  item_ref_id?: string | null;
  item_text?: string | null;
  duration_min?: number | null;
  source_event_id?: string | null;
  done?: boolean | null;
  unscheduled?: boolean | null;
  auto_send_enabled?: boolean | null;
  auto_send_at_iso?: string | null;
  original_slot_start_min?: number | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const planDate = url.searchParams.get("plan_date");
  if (!planDate || !ISO_DATE.test(planDate)) {
    return NextResponse.json(
      { error: "plan_date query parameter must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  try {
    // planDate is validated against ISO_DATE above, so safe to inline as
    // a DATE() literal. The Node BQ client doesn't reliably coerce string
    // params into DATE columns, so we sidestep that with a literal here.
    const [rows] = await bq.query({
      query: `
        SELECT slot_id, slot_start_min, item_kind, item_ref_id, item_text,
               duration_min, source_event_id, done, unscheduled,
               auto_send_enabled, auto_send_at_iso, original_slot_start_min
        FROM ${fqn("daily_slots")}
        WHERE user_id = @uid AND plan_date = DATE('${planDate}')
        ORDER BY slot_start_min ASC
      `,
      params: { uid: USER_ID },
    });
    return NextResponse.json({ slots: rows.map(normalize) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: { plan_date?: unknown; slots?: unknown };
  try {
    body = (await request.json()) as { plan_date?: unknown; slots?: unknown };
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
  const slotsRaw = Array.isArray(body.slots) ? (body.slots as SlotPayload[]) : null;
  if (slotsRaw === null) {
    return NextResponse.json(
      { error: "slots must be an array" },
      { status: 400 },
    );
  }
  // Dedupe by item_ref_id when present: same task → one slot per day.
  // The auto-pin / hydrate races used to push the same action multiple
  // times with different random slot_ids, which is what created the
  // 18-row count for ~8 visible items. Keeping the EARLIEST start_min
  // wins; the rest are dropped before they reach BQ.
  const byRef = new Map<string, SlotPayload>();
  const noRef: SlotPayload[] = [];
  for (const s of slotsRaw) {
    if (!s.item_ref_id) {
      noRef.push(s);
      continue;
    }
    const existing = byRef.get(s.item_ref_id);
    if (!existing || (s.slot_start_min ?? Infinity) < (existing.slot_start_min ?? Infinity)) {
      byRef.set(s.item_ref_id, s);
    }
  }
  const slots: SlotPayload[] = [...byRef.values(), ...noRef];

  // Single-statement MERGE: upsert all provided slots by slot_id, then
  // delete any rows for this (user, plan_date) whose slot_id wasn't in
  // the request. This is race-safe (one BQ job) and idempotent —
  // concurrent POSTs can no longer leave duplicate rows.
  try {
    if (slots.length === 0) {
      // Empty body = clear the day.
      await bq.query({
        query: `DELETE FROM ${fqn(
          "daily_slots",
        )} WHERE user_id = @uid AND plan_date = DATE('${planDate}')`,
        params: { uid: USER_ID },
      });
      return NextResponse.json({ ok: true, count: 0 });
    }

    // Build a source SELECT with one UNION ALL row per incoming slot,
    // then MERGE on slot_id. The NOT-MATCHED-BY-SOURCE branch handles
    // deletion of stale slots that the client removed.
    const params: Record<string, unknown> = { uid: USER_ID };
    const types: Record<string, string> = { uid: "STRING" };
    const sourceRows = slots
      .map((s, i) => {
        params[`slot_id_${i}`] = s.slot_id;
        types[`slot_id_${i}`] = "STRING";
        params[`slot_start_min_${i}`] = s.slot_start_min;
        types[`slot_start_min_${i}`] = "INT64";
        params[`item_kind_${i}`] = s.item_kind ?? null;
        types[`item_kind_${i}`] = "STRING";
        params[`item_ref_id_${i}`] = s.item_ref_id ?? null;
        types[`item_ref_id_${i}`] = "STRING";
        params[`item_text_${i}`] = s.item_text ?? null;
        types[`item_text_${i}`] = "STRING";
        params[`duration_min_${i}`] = s.duration_min ?? null;
        types[`duration_min_${i}`] = "INT64";
        params[`source_event_id_${i}`] = s.source_event_id ?? null;
        types[`source_event_id_${i}`] = "STRING";
        params[`done_${i}`] = s.done ?? null;
        types[`done_${i}`] = "BOOL";
        params[`unscheduled_${i}`] = s.unscheduled ?? null;
        types[`unscheduled_${i}`] = "BOOL";
        params[`auto_send_enabled_${i}`] = s.auto_send_enabled ?? null;
        types[`auto_send_enabled_${i}`] = "BOOL";
        params[`auto_send_at_iso_${i}`] = s.auto_send_at_iso ?? null;
        types[`auto_send_at_iso_${i}`] = "TIMESTAMP";
        params[`original_slot_start_min_${i}`] = s.original_slot_start_min ?? null;
        types[`original_slot_start_min_${i}`] = "INT64";
        return `SELECT
          @slot_id_${i} AS slot_id, @uid AS user_id, DATE('${planDate}') AS plan_date,
          @slot_start_min_${i} AS slot_start_min,
          @item_kind_${i} AS item_kind, @item_ref_id_${i} AS item_ref_id,
          @item_text_${i} AS item_text, @duration_min_${i} AS duration_min,
          @source_event_id_${i} AS source_event_id,
          @done_${i} AS done, @unscheduled_${i} AS unscheduled,
          @auto_send_enabled_${i} AS auto_send_enabled,
          @auto_send_at_iso_${i} AS auto_send_at_iso,
          @original_slot_start_min_${i} AS original_slot_start_min`;
      })
      .join("\nUNION ALL\n");

    await bq.query({
      query: `
        MERGE ${fqn("daily_slots")} T
        USING (${sourceRows}) S
        ON T.slot_id = S.slot_id
        WHEN MATCHED THEN UPDATE SET
          slot_start_min = S.slot_start_min,
          item_kind = S.item_kind,
          item_ref_id = S.item_ref_id,
          item_text = S.item_text,
          duration_min = S.duration_min,
          source_event_id = S.source_event_id,
          done = S.done,
          unscheduled = S.unscheduled,
          auto_send_enabled = S.auto_send_enabled,
          auto_send_at_iso = S.auto_send_at_iso,
          original_slot_start_min = S.original_slot_start_min,
          updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED BY TARGET THEN
          INSERT (slot_id, user_id, plan_date, slot_start_min, item_kind,
                  item_ref_id, item_text, duration_min, source_event_id,
                  done, unscheduled, auto_send_enabled, auto_send_at_iso,
                  original_slot_start_min, created_at, updated_at)
          VALUES (S.slot_id, S.user_id, S.plan_date, S.slot_start_min,
                  S.item_kind, S.item_ref_id, S.item_text, S.duration_min,
                  S.source_event_id, S.done, S.unscheduled,
                  S.auto_send_enabled, S.auto_send_at_iso,
                  S.original_slot_start_min, CURRENT_TIMESTAMP(),
                  CURRENT_TIMESTAMP())
        WHEN NOT MATCHED BY SOURCE
          AND T.user_id = @uid AND T.plan_date = DATE('${planDate}')
        THEN DELETE
      `,
      params,
      types,
    });
    return NextResponse.json({ ok: true, count: slots.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

function normalize(r: Record<string, unknown>): SlotPayload {
  return {
    slot_id: String(r.slot_id),
    slot_start_min: Number(r.slot_start_min ?? 0),
    item_kind: r.item_kind ? String(r.item_kind) : null,
    item_ref_id: r.item_ref_id ? String(r.item_ref_id) : null,
    item_text: r.item_text ? String(r.item_text) : null,
    duration_min: r.duration_min == null ? null : Number(r.duration_min),
    source_event_id: r.source_event_id ? String(r.source_event_id) : null,
    done: r.done == null ? null : Boolean(r.done),
    unscheduled: r.unscheduled == null ? null : Boolean(r.unscheduled),
    auto_send_enabled:
      r.auto_send_enabled == null ? null : Boolean(r.auto_send_enabled),
    auto_send_at_iso: isoOrNull(r.auto_send_at_iso),
    original_slot_start_min:
      r.original_slot_start_min == null
        ? null
        : Number(r.original_slot_start_min),
  };
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v && "value" in v)
    return String((v as { value: unknown }).value);
  return null;
}
