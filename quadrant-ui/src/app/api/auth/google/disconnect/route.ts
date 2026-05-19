import { NextResponse } from "next/server";
import { deleteRefreshToken } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

// Clears the stored Google refresh token for the user. Doesn't revoke
// on Google's side (that happens at myaccount.google.com/permissions
// or via Google's revoke endpoint) — just removes our local copy so
// the app treats the user as disconnected.
export async function POST() {
  try {
    await deleteRefreshToken();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
