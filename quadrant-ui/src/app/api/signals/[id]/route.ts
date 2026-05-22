import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// DELETE /api/signals/[id]
// Hard-delete a signal AND any actions referencing it as their only
// source AND any daily_slots referencing those actions. Use when the
// user marks an item "not relevant" from a quadrant card — typically
// an email or drive doc Quadri surfaced from an unrelated source.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // 1) Find actions that reference this signal. We delete actions
    //    whose related_signal_ids set is EXACTLY this one signal — if
    //    an action also cites other signals, leave it alone.
    const [actionRows] = await bq.query({
      query: `
        SELECT action_id
        FROM ${fqn("proposed_actions")}
        WHERE user_id = @uid
          AND ARRAY_LENGTH(related_signal_ids) = 1
          AND @id IN UNNEST(related_signal_ids)
      `,
      params: { id, uid: USER_ID },
    });
    const actionIds = (actionRows as Array<{ action_id: string }>).map(
      (r) => r.action_id,
    );

    if (actionIds.length > 0) {
      await bq.query({
        query: `
          DELETE FROM ${fqn("daily_slots")}
          WHERE user_id = @uid AND item_ref_id IN UNNEST(@ids)
        `,
        params: { ids: actionIds, uid: USER_ID },
      });
      await bq.query({
        query: `
          DELETE FROM ${fqn("proposed_actions")}
          WHERE user_id = @uid AND action_id IN UNNEST(@ids)
        `,
        params: { ids: actionIds, uid: USER_ID },
      });
    }

    // Also kill any slots that pin the signal directly (item_ref_id = signal_id).
    await bq.query({
      query: `
        DELETE FROM ${fqn("daily_slots")}
        WHERE user_id = @uid AND item_ref_id = @id
      `,
      params: { id, uid: USER_ID },
    });

    // Finally the signal itself.
    await bq.query({
      query: `
        DELETE FROM ${fqn("quadrant_signals")}
        WHERE signal_id = @id AND user_id = @uid
      `,
      params: { id, uid: USER_ID },
    });
    return NextResponse.json({ ok: true, deleted_actions: actionIds.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

// GET /api/signals/[id]
// Fetch a single signal for the quadrant-card detail modal. Returns
// the metadata as a JSON-stringified blob (mirrors /api/actions/[id]
// shape) so the client can parse out sender, body, drive URL, etc.
//
// Also includes `linked_action_id` — the action_id of the most-recent
// drafted/approved proposed_actions row referencing this signal. Used
// by the modal to auto-route to the draft view when the user reopens
// a signal that already has a send-back drafted (e.g. after clicking
// "I signed it" on a Drive doc, draft_signed_doc_email creates an
// action linked to the doc signal — without this field, reopening
// the chip lands on the read-only signal view and the user can't
// find the draft).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sql = `
    SELECT
      signal_id, source, source_record_id, occurred_at,
      quadrant, quadrant_secondary, weight, valence,
      title, excerpt, participants,
      TO_JSON_STRING(metadata) AS metadata_json,
      ingested_at
    FROM ${fqn("quadrant_signals")}
    WHERE signal_id = @id AND user_id = @uid
    LIMIT 1
  `;
  try {
    const [rows] = await bq.query({ query: sql, params: { id, uid: USER_ID } });
    if (rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const [linkedRows] = await bq.query({
      query: `
        SELECT action_id
        FROM ${fqn("proposed_actions")}
        WHERE user_id = @uid
          AND status IN ('drafted', 'approved')
          AND @id IN UNNEST(related_signal_ids)
        ORDER BY drafted_at DESC
        LIMIT 1
      `,
      params: { id, uid: USER_ID },
    });
    const linkedActionId =
      (linkedRows as Array<{ action_id: string }>)[0]?.action_id ?? null;
    return NextResponse.json({ ...rows[0], linked_action_id: linkedActionId });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
