import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { recordProjectedSignal } from "@/lib/projected-signals";

type Decision = "approve" | "reject";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let decision: Decision;
  try {
    const body = (await request.json()) as { decision?: string };
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json(
        { error: "decision must be 'approve' or 'reject'" },
        { status: 400 },
      );
    }
    decision = body.decision;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const newStatus = decision === "approve" ? "approved" : "rejected";

  const sql = `
    UPDATE ${fqn("proposed_actions")}
    SET status = @status, decided_at = CURRENT_TIMESTAMP()
    WHERE action_id = @id AND user_id = @uid AND status = 'drafted'
  `;

  try {
    await bq.query({
      query: sql,
      params: { status: newStatus, id, uid: USER_ID },
    });
    // Write a synthetic signal so the score reacts in real time. Best-effort:
    // if it fails (e.g., action wasn't anchored to signals), don't fail the
    // whole request — the status flip already succeeded.
    await recordProjectedSignal(id, decision === "approve" ? "approved" : "rejected").catch(
      (e) => console.error("projected signal write failed:", e),
    );
    return NextResponse.json({ ok: true, action_id: id, status: newStatus });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
