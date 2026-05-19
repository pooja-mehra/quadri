"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Calendar as CalendarIcon,
  Loader2,
  Mail,
  RotateCcw,
  Save,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Slot } from "@/lib/slots-storage";
import { DAY_END_MIN, SLOT_MIN } from "@/components/time-slot-bar";

// Quick presets for the duration editor. User can also enter a custom
// number — these just save a tap. Multiples of SLOT_MIN (15).
const DURATION_PRESETS_MIN = [15, 30, 45, 60, 90, 120];

// Clamp a candidate duration so the slot stays inside the day window
// AND is at least one slot long. Multiples of SLOT_MIN to keep the bar
// grid honest.
function clampDuration(slotStartMin: number, candidateMin: number): number {
  const stepped =
    Math.max(SLOT_MIN, Math.round(candidateMin / SLOT_MIN) * SLOT_MIN);
  const maxRoomMin = DAY_END_MIN - slotStartMin;
  return Math.min(stepped, Math.max(SLOT_MIN, maxRoomMin));
}

type BQTimestamp = { value: string } | string | null;

type ActionDetail = {
  action_id: string;
  action_type: "email_draft" | "text_draft" | "calendar_event";
  status: "drafted" | "approved" | "rejected" | "sent" | "expired";
  to_recipient: string | null;
  subject: string | null;
  body: string | null;
  event_start: BQTimestamp;
  event_end: BQTimestamp;
  reasoning: string | null;
  drafted_at: BQTimestamp;
  decided_at: BQTimestamp;
  sent_at: BQTimestamp;
  sources?: SourceContext[] | null;
};

// One entry per related_signal_id — what drove this draft. The modal
// renders these as a "Source" section so the user can see the original
// email subject/snippet, drive doc title, or calendar event without
// having to leave the app.
type SourceContext = {
  signal_id: string;
  source: string | null;
  title: string | null;
  excerpt: string | null;
  quadrant: string | null;
  weight: number | null;
  occurred_at: BQTimestamp;
  metadata_json: string | null;
};

function prettySource(s: string | null): string {
  if (!s) return "Source";
  if (s === "email") return "Email";
  if (s === "calendar") return "Calendar event";
  if (s.startsWith("google_drive_")) return "Google Drive";
  if (s === "projected") return "Earlier activity";
  return s;
}

// Minutes-since-midnight → "7:00 AM"
function formatMinutes(m: number): string {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const hr12 = hh % 12 === 0 ? 12 : hh % 12;
  const ampm = hh < 12 ? "AM" : "PM";
  return mm === 0
    ? `${hr12}:00 ${ampm}`
    : `${hr12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

export function SlotDetailModal({
  open,
  onClose,
  slot,
  onSlotUpdate,
  onRemoveSlot,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  slot: Slot | null;
  onSlotUpdate: (next: Slot) => void;
  onRemoveSlot: () => void;
  onChanged: () => void;
}) {
  const [action, setAction] = useState<ActionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toRecipient, setToRecipient] = useState("");

  // Calendar-imported slots have no proposed_action backing them. We render
  // a different variant of the modal (no PATCH, no Send, just local
  // Mark-Done + title edit). isCalendarImport short-circuits the fetch.
  const isCalendarImport = !!slot?.source_event_id;

  useEffect(() => {
    if (!open || !slot) {
      setAction(null);
      return;
    }
    if (isCalendarImport) {
      // Local-only — no action row in BQ to fetch. Seed editable fields
      // from the slot itself.
      setAction(null);
      setSubject(slot.item_text);
      setBody("");
      setToRecipient("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/actions/${slot.item_ref_id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ActionDetail | null) => {
        if (cancelled) return;
        setAction(data);
        if (data) {
          setSubject(data.subject ?? "");
          setBody(data.body ?? "");
          setToRecipient(data.to_recipient ?? "");
        } else {
          // Orphaned slot (signal-only "+ to today" pin, or stale localStorage
          // ref_id from before the quadrant-card fix). Fall back to local-only
          // mode so the user can still mark the time block done.
          setSubject(slot.item_text);
          setBody("");
          setToRecipient("");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAction(null);
          setSubject(slot.item_text);
          setBody("");
          setToRecipient("");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, slot, isCalendarImport]);

  if (!slot) return null;

  const isEmail = action?.action_type === "email_draft";
  const isCalEvent = action?.action_type === "calendar_event";
  // Local-only mode: no backing proposed_action row. Either a calendar import
  // (source_event_id present) or an orphaned "+ to today" slot whose item_ref_id
  // didn't resolve (signal-only bullet or stale localStorage from pre-fix).
  // Both fall back to: editable title, no Send/PATCH, local-only Mark Done.
  const isLocalOnly = isCalendarImport || (!loading && !action);
  const isDone = isLocalOnly
    ? !!slot.done
    : action?.status === "sent";
  const readonly = isDone;

  const dirty =
    action !== null &&
    (subject !== (action.subject ?? "") ||
      body !== (action.body ?? "") ||
      (isEmail && toRecipient !== (action.to_recipient ?? "")));

  async function save(): Promise<boolean> {
    if (!action) return false;
    setBusy(true);
    try {
      const patch: Record<string, string> = { subject, body };
      if (isEmail) patch.to_recipient = toRecipient;
      const r = await fetch(`/api/actions/${action.action_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        toast.error("Save failed");
        return false;
      }
      setAction((a) =>
        a ? { ...a, subject, body, to_recipient: toRecipient } : a,
      );
      toast.success("Saved");
      onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function sendOrMarkDone() {
    if (!action || !slot) return;
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/actions/${action.action_id}/send`, {
        method: "POST",
      });
      if (!r.ok) {
        toast.error(isEmail ? "Send failed" : "Mark done failed");
        return;
      }
      // Stamp slot.done locally too. The time bar reads slot.done as the
      // authoritative done flag — without this, the slot would stay amber
      // until the next /api/state refresh propagated the action_id's done
      // state, and even then only for action-backed slots.
      onSlotUpdate({ ...slot, done: true });
      toast.success(isEmail ? "Email sent" : "Marked done");
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function backToPending() {
    if (!action) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/actions/${action.action_id}/uncommit`, {
        method: "POST",
      });
      if (!r.ok) {
        toast.error("Move back failed");
        return;
      }
      onRemoveSlot();
      toast.success("Back in pending");
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const headerIcon = isEmail ? (
    <Mail className="size-4" aria-hidden />
  ) : (
    <CalendarIcon className="size-4" aria-hidden />
  );

  const headerLabel = isCalendarImport
    ? isDone
      ? "Calendar event · done"
      : "Calendar event"
    : isLocalOnly
      ? isDone
        ? "Time block · done"
        : "Time block"
      : isDone
        ? "Done · view only"
        : isEmail
          ? "Email draft"
          : "Time block";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {headerIcon}
            <span>{headerLabel}</span>
          </DialogTitle>
          {action?.reasoning ? (
            <DialogDescription className="text-xs italic text-foreground/60">
              {action.reasoning}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {/* Source context — what drove this draft. Email/drive doc/cal
            event details so the user can see *why* this is on the bar
            without bouncing to another app. */}
        {action?.sources && action.sources.length > 0 ? (
          <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
              {action.sources.length === 1 ? "Source" : `Sources (${action.sources.length})`}
            </div>
            {action.sources.map((src) => {
              let from = "";
              try {
                const m = src.metadata_json ? JSON.parse(src.metadata_json) : null;
                if (m && typeof m === "object") {
                  if (typeof m.from === "string") from = m.from;
                }
              } catch {
                // ignore — metadata might be empty or non-JSON
              }
              return (
                <div key={src.signal_id} className="space-y-0.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-foreground/60">
                    <span className="rounded bg-white px-1.5 py-0.5 font-medium">
                      {prettySource(src.source)}
                    </span>
                    {from ? <span className="truncate">{from}</span> : null}
                  </div>
                  {src.title ? (
                    <div className="text-sm font-medium leading-snug text-foreground/90">
                      {src.title}
                    </div>
                  ) : null}
                  {src.excerpt ? (
                    <p className="line-clamp-4 text-xs leading-snug text-foreground/70 whitespace-pre-wrap">
                      {src.excerpt}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-foreground/40" />
          </div>
        ) : isLocalOnly ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-foreground/55">
                Title
              </label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={readonly || busy}
              />
            </div>
            <div className="text-sm text-foreground/75">
              <strong>{formatMinutes(slot.slot_start_min)}</strong>
              {" · "}
              {slot.duration_min ?? SLOT_MIN} min
              {slot.original_slot_start_min !== undefined &&
              slot.original_slot_start_min !== slot.slot_start_min ? (
                <span className="ml-2 text-xs italic text-amber-700">
                  (moved · originally {formatMinutes(slot.original_slot_start_min)})
                </span>
              ) : null}
            </div>

            <DurationEditor
              slot={slot}
              disabled={readonly || busy}
              onChange={(nextDuration) =>
                onSlotUpdate({ ...slot, duration_min: nextDuration })
              }
            />
            <div className="rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-2 text-xs text-amber-900">
              {isCalendarImport
                ? "Changes here only affect Quadri. The event in your Google Calendar isn't touched."
                : "This time block isn't tied to a Quadri action — Mark Done is local only."}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {isEmail ? (
              <div className="space-y-1">
                <label className="text-xs font-medium uppercase tracking-wide text-foreground/55">
                  To
                </label>
                <Input
                  value={toRecipient}
                  onChange={(e) => setToRecipient(e.target.value)}
                  disabled={readonly || busy}
                />
              </div>
            ) : null}

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-foreground/55">
                {isEmail ? "Subject" : "Title"}
              </label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={readonly || busy}
              />
            </div>

            <div className="text-sm text-foreground/75">
              <strong>{formatMinutes(slot.slot_start_min)}</strong>
              {" · "}
              {slot.duration_min ?? SLOT_MIN} min
            </div>

            <DurationEditor
              slot={slot}
              disabled={readonly || busy}
              onChange={(nextDuration) =>
                onSlotUpdate({ ...slot, duration_min: nextDuration })
              }
            />

            <div className="space-y-1">
              <label className="text-xs font-medium uppercase tracking-wide text-foreground/55">
                {isEmail ? "Body" : "Description"}
              </label>
              <textarea
                rows={isEmail ? 8 : 4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={readonly || busy}
                className={cn(
                  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs",
                  "placeholder:text-muted-foreground",
                  "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  "resize-none",
                )}
              />
            </div>

            {/* Email drafts are editable here (recipient, subject, body).
                Sending itself happens through Quadri (chat), subject to
                your scheduling preferences (send window, lead time,
                blackout hours). */}
            {isEmail && !readonly ? (
              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 text-[11px] leading-snug text-neutral-600">
                Edit any field above and hit <strong>Save changes</strong>.
                The time bar doesn&rsquo;t auto-send &mdash; ask Quadri to
                send when you&rsquo;re ready (she follows your scheduling
                rules).
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {readonly ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {/* Local-only done (no action backing) → just flip slot.done
                  back. Action-backed done → call /uncommit to revert the BQ
                  row to drafted AND remove the slot so the task surfaces
                  in the today panel again. */}
              {isLocalOnly && !isCalendarImport ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    onSlotUpdate({ ...slot, done: false });
                    toast.success("Back in today");
                    onClose();
                  }}
                  disabled={busy}
                >
                  <RotateCcw className="mr-1 size-3.5" aria-hidden />
                  Move back to today
                </Button>
              ) : action ? (
                <Button
                  variant="outline"
                  onClick={backToPending}
                  disabled={busy}
                >
                  <RotateCcw className="mr-1 size-3.5" aria-hidden />
                  Move back to today
                </Button>
              ) : null}
            </>
          ) : isLocalOnly ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  onRemoveSlot();
                  toast.info(isCalendarImport ? "Hidden from today" : "Removed");
                  onClose();
                }}
                disabled={busy}
                className="text-foreground/70"
              >
                {isCalendarImport ? "Hide" : "Remove"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  onSlotUpdate({ ...slot, item_text: subject });
                  toast.success("Saved");
                  onClose();
                }}
                disabled={busy || subject === slot.item_text}
              >
                <Save className="mr-1 size-3.5" aria-hidden />
                Save
              </Button>
              <Button
                onClick={() => {
                  onSlotUpdate({
                    ...slot,
                    item_text: subject,
                    done: true,
                  });
                  toast.success("Marked done");
                  onClose();
                }}
                disabled={busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Mark Done
              </Button>
            </>
          ) : action ? (
            <>
              <Button
                variant="outline"
                onClick={backToPending}
                disabled={busy}
                className="text-foreground/70"
              >
                <RotateCcw className="mr-1 size-3.5" aria-hidden />
                Back to Pending
              </Button>
              <Button
                onClick={save}
                disabled={busy || !dirty}
                className={
                  isEmail
                    ? "bg-sky-600 text-white hover:bg-sky-700"
                    : undefined
                }
                variant={isEmail ? "default" : "outline"}
              >
                <Save className="mr-1 size-3.5" aria-hidden />
                {dirty ? "Save changes" : "Saved"}
              </Button>
              {/* Time bar never sends emails. For non-email actions
                  (calendar events), keep the Mark Done shortcut. For
                  email drafts, hide this button entirely — sending goes
                  through Quadri so scheduling prefs are honored. */}
              {!isEmail ? (
                <Button
                  onClick={sendOrMarkDone}
                  disabled={busy}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Mark Done
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DurationEditor({
  slot,
  disabled,
  onChange,
}: {
  slot: Slot;
  disabled: boolean;
  onChange: (nextDuration: number) => void;
}) {
  const current = slot.duration_min ?? SLOT_MIN;
  const apply = (raw: number) =>
    onChange(clampDuration(slot.slot_start_min, raw));

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wide text-foreground/55">
        Duration
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        {DURATION_PRESETS_MIN.map((m) => {
          const active = m === current;
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => apply(m)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-sky-500 bg-sky-50 text-sky-700"
                  : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50",
                disabled && "opacity-50",
              )}
            >
              {m} min
            </button>
          );
        })}
        <div className="ml-1 flex items-center gap-1 text-xs text-foreground/55">
          <span>or</span>
          <input
            type="number"
            min={SLOT_MIN}
            step={SLOT_MIN}
            value={current}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              apply(n);
            }}
            className={cn(
              "w-16 rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs",
              "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
          <span>min</span>
        </div>
      </div>
    </div>
  );
}
