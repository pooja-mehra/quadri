import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

// Revert an action back to drafted. Lets the user undo a commit or an
// already-sent send when they change their mind (e.g. the auto-send timer
// fired while they were away). Clears decided_at AND sent_at so the row
// looks "fresh again" — it'll re-appear in the pending list and can be
// re-pinned to today.
//
// Note: the current demo doesn't actually send emails — /send just flips
// status to 'sent' as a proxy for "done". So reverting sent→drafted has
// no external side effect. When real send is wired, sent rows will be
// terminal and this path will need to refuse them.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sql = `
    UPDATE ${fqn("proposed_actions")}
    SET status = 'drafted', decided_at = NULL, sent_at = NULL
    WHERE action_id = @id AND user_id = @uid
      AND status IN ('approved', 'sent')
  `;
  try {
    await bq.query({ query: sql, params: { id, uid: USER_ID } });
    return NextResponse.json({ ok: true, action_id: id, status: "drafted" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
