import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";

export const dynamic = "force-dynamic";

// Returns today's calendar events for the user. Reads from quadrant_signals
// where source='calendar' (populated by the Fivetran → classifier pipeline).
// Caller passes plan_date (YYYY-MM-DD in user-local TZ) and timezone so the
// SQL filter "today" matches what the user sees on their wall clock.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const planDate = url.searchParams.get("plan_date") ?? "";
  const tz = url.searchParams.get("tz") ?? "UTC";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    return NextResponse.json(
      { error: "plan_date query param required (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  try {
    const [rows] = await bq.query({
      query: `
        SELECT
          signal_id,
          title,
          quadrant,
          occurred_at,
          JSON_VALUE(metadata, '$.duration_min') AS duration_min,
          JSON_VALUE(metadata, '$.calendar') AS calendar
        FROM ${fqn("quadrant_signals")}
        WHERE user_id = @uid
          AND source = 'calendar'
          AND DATE(occurred_at, @tz) = DATE(@plan_date)
        ORDER BY occurred_at
      `,
      params: { uid: USER_ID, tz, plan_date: planDate },
    });

    const events = rows.map((r: Record<string, unknown>) => {
      const occurredAt =
        r.occurred_at && typeof r.occurred_at === "object" && "value" in r.occurred_at
          ? String((r.occurred_at as { value: unknown }).value)
          : String(r.occurred_at ?? "");
      // Compute start_min in the user's local TZ using JS Date (Intl).
      const date = new Date(occurredAt);
      const localFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const parts = localFormatter.formatToParts(date);
      const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
      const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
      const startMin = hh * 60 + mm;
      const durationMin = r.duration_min ? Number(r.duration_min) : 30;
      return {
        id: String(r.signal_id),
        start_min: startMin,
        duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : 30,
        title: String(r.title ?? "(untitled)"),
        quadrant: r.quadrant ? String(r.quadrant) : null,
        calendar: r.calendar ? String(r.calendar) : null,
      };
    });

    return NextResponse.json({ events });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
