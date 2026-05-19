import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Per-item user state stored in BQ.item_notes. Two fields:
//   notes  — free-form text the user types in the modal
//   due_at — schedule timestamp (when to send, or just "due by")
//
// GET  /api/notes?ref_id=X       → { notes, due_at }
// POST /api/notes { ref_id, notes?, due_at? } → upsert
//
// Partial updates supported: omit a field to leave it unchanged.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refId = url.searchParams.get("ref_id") ?? "";
  if (!refId) {
    return NextResponse.json({ error: "ref_id required" }, { status: 400 });
  }
  try {
    const [rows] = await bq.query({
      query: `
        SELECT notes, due_at
        FROM ${fqn("item_notes")}
        WHERE user_id = @uid AND item_ref_id = @ref
        LIMIT 1
      `,
      params: { uid: USER_ID, ref: refId },
    });
    const row = (rows as Array<{
      notes: string | null;
      due_at: { value: string } | string | null;
    }>)[0];
    const notes = row?.notes ?? null;
    const dueRaw = row?.due_at;
    const due_at =
      typeof dueRaw === "string"
        ? dueRaw
        : dueRaw && typeof dueRaw === "object" && "value" in dueRaw
          ? dueRaw.value
          : null;
    return NextResponse.json({ notes, due_at });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: { ref_id?: unknown; notes?: unknown; due_at?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const refId = typeof body.ref_id === "string" ? body.ref_id : "";
  if (!refId) {
    return NextResponse.json({ error: "ref_id required" }, { status: 400 });
  }
  const notesProvided = body.notes !== undefined;
  const dueProvided = body.due_at !== undefined;
  if (!notesProvided && !dueProvided) {
    return NextResponse.json(
      { error: "provide notes and/or due_at" },
      { status: 400 },
    );
  }
  const notes =
    !notesProvided
      ? undefined
      : typeof body.notes === "string"
        ? body.notes
        : null;
  // due_at: empty string means "clear", any non-empty value goes through
  // BQ as a TIMESTAMP parameter. Validate parseability up-front.
  let due_at: string | null | undefined = undefined;
  if (dueProvided) {
    if (body.due_at === "" || body.due_at === null) {
      due_at = null;
    } else if (typeof body.due_at === "string") {
      const d = new Date(body.due_at);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json(
          { error: "due_at must be a parseable ISO/date-time string" },
          { status: 400 },
        );
      }
      due_at = d.toISOString();
    } else {
      return NextResponse.json(
        { error: "due_at must be a string (ISO date-time) or null" },
        { status: 400 },
      );
    }
  }

  // Build the MERGE so missing fields don't get wiped. Wrap the
  // due_at parameter in TIMESTAMP() — the Node BQ client passes
  // string params as STRING and that won't auto-cast on INSERT to
  // a TIMESTAMP column; explicit TIMESTAMP() makes the conversion.
  // NULL stays NULL via the IF(@due_at='', NULL, ...) shape.
  const updates: string[] = [];
  const params: Record<string, unknown> = { uid: USER_ID, ref: refId };
  if (notesProvided) {
    updates.push("notes = @notes");
    params.notes = notes ?? null;
  }
  if (dueProvided) {
    updates.push(
      "due_at = IF(@due_at IS NULL OR @due_at = '', NULL, TIMESTAMP(@due_at))",
    );
    // BQ Node client needs a non-null typed value for null params,
    // otherwise it can't infer type. Pass "" as sentinel and the
    // IF above converts to NULL.
    params.due_at = due_at ?? "";
  }
  // Always touch updated_at.
  updates.push("updated_at = S.ts");
  const insertNotesExpr = notesProvided ? "@notes" : "NULL";
  const insertDueExpr = dueProvided
    ? "IF(@due_at IS NULL OR @due_at = '', NULL, TIMESTAMP(@due_at))"
    : "NULL";

  try {
    await bq.query({
      query: `
        MERGE ${fqn("item_notes")} T
        USING (SELECT @uid AS user_id, @ref AS item_ref_id, CURRENT_TIMESTAMP() AS ts) S
        ON T.user_id = S.user_id AND T.item_ref_id = S.item_ref_id
        WHEN MATCHED THEN UPDATE SET ${updates.join(", ")}
        WHEN NOT MATCHED THEN
          INSERT (user_id, item_ref_id, notes, due_at, created_at, updated_at)
          VALUES (S.user_id, S.item_ref_id, ${insertNotesExpr}, ${insertDueExpr}, S.ts, S.ts)
      `,
      params,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
