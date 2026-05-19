import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

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

  const sql =
    decision === "approve"
      ? `UPDATE ${fqn("user_goals")}
         SET status = 'active',
             approved_at = CURRENT_TIMESTAMP(),
             active_from = CURRENT_DATE()
         WHERE goal_id = @id AND user_id = @uid AND status = 'proposed'`
      : `UPDATE ${fqn("user_goals")}
         SET status = 'archived', archived_at = CURRENT_TIMESTAMP()
         WHERE goal_id = @id AND user_id = @uid AND status = 'proposed'`;

  try {
    await bq.query({ query: sql, params: { id, uid: USER_ID } });
    const newStatus = decision === "approve" ? "active" : "archived";
    return NextResponse.json({ ok: true, goal_id: id, status: newStatus });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
