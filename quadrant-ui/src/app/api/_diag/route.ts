import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

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
  return NextResponse.json({
    GCP_PROJECT: process.env.GCP_PROJECT ?? null,
    QUADRANT_DATASET: process.env.QUADRANT_DATASET ?? null,
    QUADRANT_USER_ID: process.env.QUADRANT_USER_ID ?? null,
    AGENT_BACKEND_URL: process.env.AGENT_BACKEND_URL ?? null,
    AGENT_APP_NAME: process.env.AGENT_APP_NAME ?? null,
    QUADRI_DEMO_MODE: process.env.QUADRI_DEMO_MODE ?? null,
    NEXT_PUBLIC_QUADRI_DEMO_MODE: process.env.NEXT_PUBLIC_QUADRI_DEMO_MODE ?? null,
    GCP_SERVICE_ACCOUNT_KEY: fingerprint(process.env.GCP_SERVICE_ACCOUNT_KEY),
    // Sanity: confirm we can JSON.parse what's stored.
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
  });
}
