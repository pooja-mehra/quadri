import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { recordProjectedSignal } from "@/lib/projected-signals";
import { appendNoteToLocalCsv } from "@/lib/local-csv-log";

// "Mark as sent" action — flips status to 'sent', stamps sent_at, and
// records the follow-through signal. Accepts both 'drafted' and 'approved'
// so Mark Done works even when the drop-time approval hasn't landed yet
// (race) or wasn't triggered (e.g. items added via "+ to today" bypassed
// the today-panel approval path). Real outbound integrations (Gmail send,
// Twilio, Calendar insert) will plug in here in Tier 2.
//
// Also mirrors the completion to the user's local notes CSV file
// (~/Documents/quadri-notes.csv by default) — auto-append on every
// successful send, deduped by ref_id.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const sql = `
    UPDATE ${fqn("proposed_actions")}
    SET status = 'sent', sent_at = CURRENT_TIMESTAMP()
    WHERE action_id = @id AND user_id = @uid
      AND status IN ('drafted', 'approved')
  `;

  try {
    await bq.query({ query: sql, params: { id, uid: USER_ID } });
    // Write the follow-through signal. This is on TOP of the +0.4 from
    // approve, so a fully-committed-and-sent action contributes +0.8.
    await recordProjectedSignal(id, "sent").catch((e) =>
      console.error("sent signal write failed:", e),
    );
    // Mirror to local CSV — best-effort. plan_date is today in PT.
    const todayPT = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    void appendNoteToLocalCsv({ refId: id, planDate: todayPT });
    return NextResponse.json({ ok: true, action_id: id, status: "sent" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
