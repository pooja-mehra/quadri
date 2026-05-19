import { NextResponse } from "next/server";
import { USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

const AGENT_BASE = process.env.AGENT_BACKEND_URL ?? "http://localhost:8000";
const APP_NAME = process.env.AGENT_APP_NAME ?? "app";

type AdkPart = { text?: string; functionCall?: unknown; functionResponse?: unknown };
type AdkEvent = {
  content?: { role?: string; parts?: AdkPart[] };
  partial?: boolean;
};

export async function POST(request: Request) {
  let body: { message?: unknown; sessionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!message || !sessionId) {
    return NextResponse.json(
      { error: "message and sessionId are required" },
      { status: 400 },
    );
  }

  // Idempotently create the session. ADK returns 200 if new, 400 if it
  // already exists — both are fine, ignore errors here.
  await fetch(
    `${AGENT_BASE}/apps/${APP_NAME}/users/${USER_ID}/sessions/${sessionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  ).catch(() => undefined);

  // Run the agent. /run returns the full event array (non-streaming).
  let runResp: Response;
  try {
    runResp = await fetch(`${AGENT_BASE}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId,
        newMessage: { role: "user", parts: [{ text: message }] },
        streaming: false,
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

  if (!runResp.ok) {
    const text = await runResp.text().catch(() => "");
    return NextResponse.json(
      { error: `agent backend ${runResp.status}: ${text.slice(0, 500)}` },
      { status: 502 },
    );
  }

  const events = (await runResp.json()) as AdkEvent[];

  // Concatenate text parts from model-role events. Skip partial events.
  // Tool-call events (functionCall / functionResponse) carry no text.
  const textParts: string[] = [];
  for (const e of events) {
    if (e.partial) continue;
    if (e.content?.role !== "model") continue;
    for (const p of e.content.parts ?? []) {
      if (typeof p.text === "string" && p.text.length > 0) {
        textParts.push(p.text);
      }
    }
  }

  const response = textParts.join("\n").trim();
  return NextResponse.json({
    response: response || "(agent returned no text)",
    eventCount: events.length,
  });
}
