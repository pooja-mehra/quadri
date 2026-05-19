import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { getAccessToken } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

// Deletes every Google Calendar event Quadri ever wrote (tagged with
// extendedProperties.private.quadri_origin = "true") and clears the
// stored google_event_id / google_synced_at columns. Use to recover
// from a runaway-duplicate sync. After this, a fresh /sync-today will
// recreate exactly one event per slot.

const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type ListResponse = {
  items?: Array<{ id: string }>;
  nextPageToken?: string;
};

export async function POST() {
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unauthorized" },
      { status: 401 },
    );
  }

  let deleted = 0;
  let failed = 0;
  let pageToken: string | undefined;

  // Paginate through all Quadri-tagged events. The list endpoint
  // returns up to 250 per page; we filter server-side via the
  // privateExtendedProperty query parameter.
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: "quadri_origin=true",
      maxResults: "250",
      showDeleted: "false",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const listResp = await fetch(`${CAL_BASE}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      const text = await listResp.text();
      return NextResponse.json(
        { error: `list failed: ${listResp.status} ${text}` },
        { status: 500 },
      );
    }
    const data = (await listResp.json()) as ListResponse;
    for (const ev of data.items ?? []) {
      const del = await fetch(
        `${CAL_BASE}/${encodeURIComponent(ev.id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (del.ok || del.status === 410) deleted++;
      else failed++;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Clear the stored event IDs so a follow-up sync recreates fresh ones.
  await bq.query({
    query: `
      UPDATE ${fqn("daily_slots")}
      SET google_event_id = NULL, google_synced_at = NULL
      WHERE user_id = @uid AND google_event_id IS NOT NULL
    `,
    params: { uid: USER_ID },
  });

  return NextResponse.json({ ok: failed === 0, deleted, failed });
}
