import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { appendNoteToLocalCsv } from "@/lib/local-csv-log";

export const dynamic = "force-dynamic";

// Mark a signal-only item done.
//
// Used by the FocusCard's "Done" button when the current item has no
// backing draft action (e.g. a calendar event or a raw email signal
// the user dealt with externally). Action-backed items use
// /api/actions/<id>/send instead — that endpoint stamps sent_at on
// the action and the rolling done-week view picks it up.
//
// This route writes a daily_slots row with done=TRUE so the item
// drops out of today's queue and shows up in `done_slot_refs` for
// the rolling 7-day window.

type DoneBody = {
  plan_date?: unknown;
  item_ref_id?: unknown;
  item_kind?: unknown;
  item_text?: unknown;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  let body: DoneBody;
  try {
    body = (await request.json()) as DoneBody;
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
    typeof body.item_ref_id === "string" ? body.item_ref_id : "";
  if (!itemRefId) {
    return NextResponse.json(
      { error: "item_ref_id is required" },
      { status: 400 },
    );
  }
  const itemKind =
    typeof body.item_kind === "string" ? body.item_kind : "user";
  const itemText = typeof body.item_text === "string" ? body.item_text : null;
  const slotId = crypto.randomUUID();

  try {
    // If a slot already exists for this ref today, flip its done flag
    // instead of inserting a duplicate. UPDATE-then-INSERT pattern.
    const [existing] = await bq.query({
      query: `
        SELECT slot_id
        FROM ${fqn("daily_slots")}
        WHERE user_id = @uid
          AND plan_date = DATE('${planDate}')
          AND item_ref_id = @ref
        LIMIT 1
      `,
      params: { uid: USER_ID, ref: itemRefId },
    });

    if ((existing as Array<{ slot_id: string }>).length > 0) {
      const existingId = (existing as Array<{ slot_id: string }>)[0].slot_id;
      await bq.query({
        query: `
          UPDATE ${fqn("daily_slots")}
          SET done = TRUE
          WHERE user_id = @uid AND slot_id = @sid
        `,
        params: { uid: USER_ID, sid: existingId },
      });
      // Mirror to local CSV — best-effort, doesn't block the response.
      void appendNoteToLocalCsv({
        refId: itemRefId,
        planDate,
        titleHint: itemText,
      });
      return NextResponse.json({ ok: true, slot_id: existingId });
    }

    await bq.query({
      query: `
        INSERT INTO ${fqn("daily_slots")} (
          slot_id, user_id, plan_date, slot_start_min, item_kind,
          item_ref_id, item_text, duration_min, source_event_id, done,
          unscheduled, auto_send_enabled, auto_send_at_iso,
          original_slot_start_min, created_at
        ) VALUES (
          @slot_id, @uid, DATE('${planDate}'), 0, @kind,
          @ref, @text, 15, NULL, TRUE,
          FALSE, NULL, NULL,
          0, CURRENT_TIMESTAMP()
        )
      `,
      params: {
        uid: USER_ID,
        slot_id: slotId,
        kind: itemKind,
        ref: itemRefId,
        text: itemText,
      },
    });

    void appendNoteToLocalCsv({
      refId: itemRefId,
      planDate,
      titleHint: itemText,
    });
    return NextResponse.json({ ok: true, slot_id: slotId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
