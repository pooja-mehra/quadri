import { NextResponse } from "next/server";
import { bq, fqn, USER_ID } from "@/lib/bq";
import { recordProjectedSignal } from "@/lib/projected-signals";
import { appendNoteToLocalCsv } from "@/lib/local-csv-log";

// "Mark as sent" action — flips status to 'sent', stamps sent_at, and
// records the follow-through signal. Accepts both 'drafted' and 'approved'
// so Mark Done works even when the drop-time approval hasn't landed yet
// (race) or wasn't triggered (e.g. items added via "+ to today" bypassed
// the today-panel approval path). Real outbound integrations (Gmail send,
// Twilio, Calendar insert) will plug in here in Tier 2.
//
// Also mirrors the completion to the user's local notes CSV file
// (~/Documents/quadri-notes.csv by default) — auto-append on every
// successful send, deduped by ref_id.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const sql = `
    UPDATE ${fqn("proposed_actions")}
    SET status = 'sent', sent_at = CURRENT_TIMESTAMP()
    WHERE action_id = @id AND user_id = @uid
      AND status IN ('drafted', 'approved')
  `;

  try {
    await bq.query({ query: sql, params: { id, uid: USER_ID } });
    // Write the follow-through signal. This is on TOP of the +0.4 from
    // approve, so a fully-committed-and-sent action contributes +0.8.
    await recordProjectedSignal(id, "sent").catch((e) =>
      console.error("sent signal write failed:", e),
    );
    // Mirror to local CSV — best-effort. plan_date is today in PT.
    const todayPT = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    void appendNoteToLocalCsv({ refId: id, planDate: todayPT });

    // Surface the send on today's calendar strip:
    //   - If the action already has a scheduled daily_slots row today,
    //     flip its done flag (so a scheduled send becomes a done chip
    //     at its scheduled time slot).
    //   - Otherwise insert a "done now" slot at the user's current PT
    //     time-of-day so an ad-hoc send still appears on the strip.
    void (async () => {
      try {
        const [existing] = await bq.query({
          query: `
            SELECT slot_id FROM ${fqn("daily_slots")}
            WHERE user_id = @uid
              AND plan_date = DATE('${todayPT}')
              AND item_ref_id = @ref
            LIMIT 1
          `,
          params: { uid: USER_ID, ref: id },
        });
        if ((existing as Array<{ slot_id: string }>).length > 0) {
          const existingSlotId = (existing as Array<{ slot_id: string }>)[0]
            .slot_id;
          await bq.query({
            query: `
              UPDATE ${fqn("daily_slots")}
              SET done = TRUE
              WHERE user_id = @uid AND slot_id = @sid
            `,
            params: { uid: USER_ID, sid: existingSlotId },
          });
          return;
        }
        // Subject for the chip label.
        const [subjRows] = await bq.query({
          query: `
            SELECT subject FROM ${fqn("proposed_actions")}
            WHERE user_id = @uid AND action_id = @id
            LIMIT 1
          `,
          params: { uid: USER_ID, id },
        });
        const subject =
          (subjRows as Array<{ subject: string | null }>)[0]?.subject ??
          "(sent draft)";
        const nowPtParts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(new Date());
        const hh = Number(
          nowPtParts.find((p) => p.type === "hour")?.value ?? "0",
        );
        const mm = Number(
          nowPtParts.find((p) => p.type === "minute")?.value ?? "0",
        );
        const startMin = hh * 60 + mm;
        await bq.query({
          query: `
            INSERT INTO ${fqn("daily_slots")} (
              slot_id, user_id, plan_date, slot_start_min, item_kind,
              item_ref_id, item_text, duration_min, source_event_id, done,
              unscheduled, auto_send_enabled, auto_send_at_iso,
              original_slot_start_min, created_at
            ) VALUES (
              @slot_id, @uid, DATE('${todayPT}'), @startMin, 'action',
              @ref, @text, 15, NULL, TRUE,
              FALSE, NULL, NULL,
              @startMin, CURRENT_TIMESTAMP()
            )
          `,
          params: {
            uid: USER_ID,
            slot_id: crypto.randomUUID(),
            ref: id,
            text: subject,
            startMin,
          },
        });
      } catch (e) {
        console.error("upsert done slot failed:", e);
      }
    })();

    return NextResponse.json({ ok: true, action_id: id, status: "sent" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}
