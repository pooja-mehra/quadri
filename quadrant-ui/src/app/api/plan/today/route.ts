import { NextResponse } from "next/server";
import { USER_ID } from "@/lib/bq";
import type { DailyPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

const AGENT_BASE = process.env.AGENT_BACKEND_URL ?? "http://localhost:8000";

type PlanResponse = { plan: DailyPlan | null };

export async function POST(request: Request) {
  let body: { plan_date?: unknown; user_intentions?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const planDate = typeof body.plan_date === "string" ? body.plan_date : "";
  const userIntentions =
    typeof body.user_intentions === "string" ? body.user_intentions : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    return NextResponse.json(
      { error: "plan_date must be ISO date YYYY-MM-DD" },
      { status: 400 },
    );
  }

  let r: Response;
  try {
    r = await fetch(`${AGENT_BASE}/plan/today`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: USER_ID,
        plan_date: planDate,
        user_intentions: userIntentions,
      }),
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: `cannot reach agent at ${AGENT_BASE} — is 'make local-backend' running? (${
          e instanceof Error ? e.message : "fetch failed"
        })`,
      },
      { status: 502 },
    );
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: `agent backend ${r.status}: ${text.slice(0, 500)}` },
      { status: 502 },
    );
  }

  const data = (await r.json()) as PlanResponse;
  return NextResponse.json(data);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const planDate = url.searchParams.get("plan_date") ?? "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    return NextResponse.json(
      { error: "plan_date query param required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  let r: Response;
  try {
    r = await fetch(
      `${AGENT_BASE}/plan/today?plan_date=${encodeURIComponent(
        planDate,
      )}&user_id=${encodeURIComponent(USER_ID)}`,
      { cache: "no-store" },
    );
  } catch (e) {
    return NextResponse.json(
      {
        error: `cannot reach agent at ${AGENT_BASE} (${
          e instanceof Error ? e.message : "fetch failed"
        })`,
      },
      { status: 502 },
    );
  }

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: `agent backend ${r.status}: ${text.slice(0, 500)}` },
      { status: 502 },
    );
  }

  const data = (await r.json()) as PlanResponse;
  return NextResponse.json(data);
}
