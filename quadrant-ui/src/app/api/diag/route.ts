import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Non-sensitive diagnostic — reports the length + SHA-256 prefix of
// each env var so we can compare against a local fingerprint without
// exposing the value. Delete this route after debugging deployment.

function fingerprint(v: string | undefined): { len: number; sha8: string } | null {
  if (!v) return null;
  return {
    len: v.length,
    sha8: createHash("sha256").update(v).digest("hex").slice(0, 8),
  };
}

export async function GET() {
  // Live BQ probe — runs a tiny query against proposed_actions and
  // reports whether it succeeds, what the row count is, and the raw
  // error if not. This is the only way to distinguish "BQ returns
  // empty for this user_id" from "BQ rejects the credentials."
  let bqProbe:
    | { ok: true; count: number; project: string }
    | { ok: false; error: string; code?: number }
    | { skipped: true; reason: string };
  try {
    const [rows] = await bq.query({
      query: `
        SELECT COUNT(*) AS n
        FROM ${fqn("proposed_actions")}
        WHERE user_id = @uid
      `,
      params: { uid: USER_ID },
    });
    const n = Number((rows as Array<{ n: number | string }>)[0]?.n ?? 0);
    bqProbe = {
      ok: true,
      count: n,
      project: bq.projectId ?? "(unknown)",
    };
  } catch (e) {
    const err = e as { message?: string; code?: number; errors?: unknown };
    bqProbe = {
      ok: false,
      error: err.message?.slice(0, 500) ?? String(e).slice(0, 500),
      code: err.code,
    };
  }

  return NextResponse.json({
    GCP_PROJECT: process.env.GCP_PROJECT ?? null,
    QUADRANT_DATASET: process.env.QUADRANT_DATASET ?? null,
    QUADRANT_USER_ID: process.env.QUADRANT_USER_ID ?? null,
    AGENT_BACKEND_URL: process.env.AGENT_BACKEND_URL ?? null,
    AGENT_APP_NAME: process.env.AGENT_APP_NAME ?? null,
    QUADRI_DEMO_MODE: process.env.QUADRI_DEMO_MODE ?? null,
    NEXT_PUBLIC_QUADRI_DEMO_MODE: process.env.NEXT_PUBLIC_QUADRI_DEMO_MODE ?? null,
    GCP_SERVICE_ACCOUNT_KEY: fingerprint(process.env.GCP_SERVICE_ACCOUNT_KEY),
    GCP_SERVICE_ACCOUNT_KEY_parses: (() => {
      try {
        const v = process.env.GCP_SERVICE_ACCOUNT_KEY;
        if (!v) return null;
        const parsed = JSON.parse(v);
        return {
          ok: true,
          client_email: parsed.client_email ?? null,
          private_key_id: parsed.private_key_id ?? null,
          private_key_length: (parsed.private_key ?? "").length,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })(),
    bqProbe,
  });
}
