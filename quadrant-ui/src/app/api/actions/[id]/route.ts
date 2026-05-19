import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

// DELETE /api/actions/[id]
// Hard-delete an action and any daily_slot rows referencing it. Used
// when the user dismisses an item from a quadrant card as "not
// relevant to me at all" — rejection (soft) leaves a footprint and
// can come back as a "deferred" suggestion; this is the kill switch.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Remove any slots first to avoid orphaning the bar.
    await bq.query({
      query: `
        DELETE FROM ${fqn("daily_slots")}
        WHERE user_id = @uid AND item_ref_id = @id
      `,
      params: { id, uid: USER_ID },
    });
    await bq.query({
      query: `
        DELETE FROM ${fqn("proposed_actions")}
        WHERE action_id = @id AND user_id = @uid
      `,
      params: { id, uid: USER_ID },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

// PATCH /api/actions/[id]
// Edits the user-facing fields of a proposed action. The user's edits in
// the slot modal are immediate + final — there is no draft-of-an-edit.
// Allowed only while status is 'drafted' or 'approved'; sent items are
// view-only.

type PatchBody = {
  subject?: string;
  body?: string;
  to_recipient?: string;
  // Full replacement of the attachments list. Empty array clears
  // attachments; omit to leave unchanged.
  attachments?: Array<{ file_id: string; name: string; mime_type?: string }>;
};

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let patch: PatchBody;
  try {
    patch = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const setFragments: string[] = [];
  const queryParams: Record<string, string | null> = { id, uid: USER_ID };

  if (patch.subject !== undefined) {
    setFragments.push("subject = @subject");
    queryParams.subject = patch.subject;
  }
  if (patch.body !== undefined) {
    setFragments.push("body = @body");
    queryParams.body = patch.body;
  }
  if (patch.to_recipient !== undefined) {
    setFragments.push("to_recipient = @to_recipient");
    queryParams.to_recipient = patch.to_recipient;
  }

  // Attachments live in metadata.attachments. PATCH-replace: build
  // the new metadata JSON from existing metadata (preserving other
  // keys like later_list flags) but swap the attachments slot.
  if (patch.attachments !== undefined) {
    const clean = patch.attachments
      .filter(
        (a) =>
          a && typeof a.file_id === "string" && typeof a.name === "string",
      )
      .map((a) => ({
        file_id: a.file_id,
        name: a.name,
        mime_type: a.mime_type ?? "",
      }));
    setFragments.push(
      "metadata = (SELECT JSON_SET(IFNULL(metadata, JSON '{}'), '$.attachments', PARSE_JSON(@attachments_json)))",
    );
    queryParams.attachments_json = JSON.stringify(clean);
  }

  if (setFragments.length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }

  const sql = `
    UPDATE ${fqn("proposed_actions")}
    SET ${setFragments.join(", ")}
    WHERE action_id = @id AND user_id = @uid
      AND status IN ('drafted', 'approved')
  `;

  try {
    await bq.query({ query: sql, params: queryParams });
    return NextResponse.json({ ok: true, action_id: id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

// GET /api/actions/[id]
// Single-action fetch for the slot modal. Returns the action row PLUS a
// `sources` array — one entry per related_signal_id — so the modal can
// show the originating email / drive doc / calendar event the action
// was drafted from. Empty when there are no signals attached.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sql = `
    WITH a AS (
      SELECT
        action_id, action_type, status,
        to_recipient, subject, body,
        event_start, event_end, attendees,
        reasoning, related_signal_ids,
        drafted_at, decided_at, sent_at,
        TO_JSON_STRING(JSON_QUERY(metadata, '$.attachments')) AS attachments_json
      FROM ${fqn("proposed_actions")}
      WHERE action_id = @id AND user_id = @uid
      LIMIT 1
    ),
    src AS (
      SELECT
        ARRAY_AGG(STRUCT(
          s.signal_id,
          s.source,
          s.title,
          s.excerpt,
          s.quadrant,
          s.weight,
          s.occurred_at,
          TO_JSON_STRING(s.metadata) AS metadata_json
        ) ORDER BY s.occurred_at DESC) AS sources
      FROM a, UNNEST(a.related_signal_ids) sid
      LEFT JOIN ${fqn("quadrant_signals")} s
        ON s.signal_id = sid AND s.user_id = @uid
      WHERE s.signal_id IS NOT NULL
    )
    SELECT a.*, COALESCE(src.sources, []) AS sources
    FROM a LEFT JOIN src ON TRUE
  `;
  try {
    const [rows] = await bq.query({ query: sql, params: { id, uid: USER_ID } });
    if (rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const row = rows[0] as { attachments_json?: string | null } & Record<
      string,
      unknown
    >;
    // Parse the JSON-encoded attachments array. Quadri stores them in
    // metadata.attachments via draft_email; the modal renders them as
    // chips with an × to remove.
    let attachments: Array<{
      file_id: string;
      name: string;
      mime_type?: string;
    }> = [];
    const raw = row.attachments_json;
    if (typeof raw === "string" && raw.length > 0 && raw !== "null") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          attachments = parsed.filter(
            (a) =>
              a &&
              typeof a === "object" &&
              typeof a.file_id === "string" &&
              typeof a.name === "string",
          );
        }
      } catch {
        // Malformed metadata — leave empty.
      }
    }
    const { attachments_json: _drop, ...rest } = row;
    void _drop;
    return NextResponse.json({ ...rest, attachments });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
