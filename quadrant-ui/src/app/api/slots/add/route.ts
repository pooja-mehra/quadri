import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Atomic single-slot insert. The main /api/slots POST replaces the
// entire day's slot set (used by the time-bar DnD which has the full
// local state in hand). For one-off scheduling from the focus card
// (chip click, drag-drop, picker modal), we want to ADD a slot
// without disturbing existing ones. This route does exactly that and
// also flips the action to status='approved' so the focus queue
// drops it correctly.

type AddBody = {
  plan_date?: unknown;
  slot_id?: unknown;
  slot_start_min?: unknown;
  duration_min?: unknown;
  item_ref_id?: unknown;
  item_kind?: unknown;
  item_text?: unknown;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  let body: AddBody;
  try {
    body = (await request.json()) as AddBody;
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
  const slotId =
    typeof body.slot_id === "string" && body.slot_id.length > 0
      ? body.slot_id
      : crypto.randomUUID();
  const slotStartMin =
    typeof body.slot_start_min === "number"
      ? Math.max(0, Math.floor(body.slot_start_min))
      : -1;
  if (slotStartMin < 0) {
    return NextResponse.json(
      { error: "slot_start_min must be a non-negative integer" },
      { status: 400 },
    );
  }
  const durationMin =
    typeof body.duration_min === "number" && body.duration_min > 0
      ? Math.floor(body.duration_min)
      : 15;
  const itemRefId =
    typeof body.item_ref_id === "string" ? body.item_ref_id : null;
  const itemKind =
    typeof body.item_kind === "string" ? body.item_kind : "committed_action";
  const itemText = typeof body.item_text === "string" ? body.item_text : null;

  try {
    // Refuse if the slot collides with an existing one (same start_min)
    // OR if the action is already scheduled today. Caller picks a
    // different chip.
    if (itemRefId) {
      const [collision] = await bq.query({
        query: `
          SELECT slot_id
          FROM ${fqn("daily_slots")}
          WHERE user_id = @uid
            AND plan_date = DATE('${planDate}')
            AND (slot_start_min = @start OR item_ref_id = @ref)
            AND (done IS NULL OR done = FALSE)
          LIMIT 1
        `,
        params: { uid: USER_ID, start: slotStartMin, ref: itemRefId },
      });
      if ((collision as Array<unknown>).length > 0) {
        return NextResponse.json(
          { error: "slot taken or item already scheduled today" },
          { status: 409 },
        );
      }
    }

    await bq.query({
      query: `
        INSERT INTO ${fqn("daily_slots")} (
          slot_id, user_id, plan_date, slot_start_min, item_kind,
          item_ref_id, item_text, duration_min, source_event_id, done,
          unscheduled, auto_send_enabled, auto_send_at_iso,
          original_slot_start_min, created_at
        ) VALUES (
          @slot_id, @uid, DATE('${planDate}'), @start, @kind,
          @ref, @text, @dur, NULL, FALSE,
          FALSE, NULL, NULL,
          @start, CURRENT_TIMESTAMP()
        )
      `,
      params: {
        uid: USER_ID,
        slot_id: slotId,
        start: slotStartMin,
        kind: itemKind,
        ref: itemRefId,
        text: itemText,
        dur: durationMin,
      },
    });

    // Slotting an item == approving the underlying action (if any).
    // Same semantics as the time-bar drop: the user committed to it.
    if (itemRefId) {
      await bq.query({
        query: `
          UPDATE ${fqn("proposed_actions")}
          SET status = 'approved',
              decided_at = CURRENT_TIMESTAMP()
          WHERE action_id = @ref
            AND user_id = @uid
            AND status = 'drafted'
        `,
        params: { uid: USER_ID, ref: itemRefId },
      }).catch(() => null);

    }

    return NextResponse.json({ ok: true, slot_id: slotId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
