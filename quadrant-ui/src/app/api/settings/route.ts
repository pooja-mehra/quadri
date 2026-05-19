import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { DEFAULTS, withDefaults, type Settings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [rows] = await bq.query({
      query: `
        SELECT settings
        FROM ${fqn("user_settings")}
        WHERE user_id = @uid
        LIMIT 1
      `,
      params: { uid: USER_ID },
    });
    if (rows.length === 0) {
      return NextResponse.json({ settings: DEFAULTS });
    }
    // BigQuery JSON columns deserialize as objects in the Node client.
    const raw = (rows[0] as { settings: unknown }).settings;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Partial<Settings>) : (raw as Partial<Settings>);
    return NextResponse.json({ settings: withDefaults(parsed) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch failed" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  let body: { settings?: unknown };
  try {
    body = (await request.json()) as { settings?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.settings || typeof body.settings !== "object") {
    return NextResponse.json({ error: "settings field required" }, { status: 400 });
  }

  // Fill in defaults for any missing keys so we always store a complete shape.
  const merged = withDefaults(body.settings as Partial<Settings>);
  const settingsJson = JSON.stringify(merged);

  const sql = `
    MERGE ${fqn("user_settings")} T
    USING (
      SELECT @uid AS user_id, PARSE_JSON(@settings) AS settings
    ) S
    ON T.user_id = S.user_id
    WHEN MATCHED THEN
      UPDATE SET settings = S.settings, updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN
      INSERT (user_id, settings, updated_at)
      VALUES (S.user_id, S.settings, CURRENT_TIMESTAMP())
  `;

  try {
    await bq.query({
      query: sql,
      params: { uid: USER_ID, settings: settingsJson },
    });
    return NextResponse.json({ ok: true, settings: merged });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "save failed" },
      { status: 500 },
    );
  }
}
