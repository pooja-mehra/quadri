import { NextResponse } from "next/server";
import { saveTodayNotesLog } from "@/lib/notes-log";

export const dynamic = "force-dynamic";

// End-of-day batch save. Reads today's done items + their notes
// and MERGEs them into notes_log. Idempotent — running twice the
// same day just refreshes the rows.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request) {
  let body: { plan_date?: unknown };
  try {
    body = (await request.json()) as typeof body;
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
  try {
    const { count } = await saveTodayNotesLog(planDate);
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
