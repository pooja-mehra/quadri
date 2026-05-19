"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  ListPlus,
  ExternalLink,
  Save,
  Check,
  Sparkles,
  CalendarClock,
  Paperclip,
  X,
  CalendarX,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { markSent } from "@/lib/decisions";
import { cn } from "@/lib/utils";

// Lightweight detail modal for quadrant-card bullets. The bullet may be
// backed by either:
//   - an action (the user / Quadri drafted something), or
//   - a signal-only bullet (Quadri surfaced the source but hasn't drafted
//     anything yet — common for email-derived items).
//
// In both cases the user wants to see WHAT the item is (sender, summary,
// source) BEFORE deciding whether to pin it to today's bar. The "Add to
// today" button at the bottom is the shortcut for pinning.

type SourceCtx = {
  signal_id: string;
  source: string | null;
  title: string | null;
  excerpt: string | null;
  quadrant: string | null;
  weight: number | null;
  occurred_at: { value: string } | string | null;
  metadata_json: string | null;
};

type Attachment = {
  file_id: string;
  name: string;
  mime_type?: string;
};

type ActionDetail = {
  action_id: string;
  action_type: "email_draft" | "text_draft" | "calendar_event";
  status: string;
  to_recipient: string | null;
  subject: string | null;
  body: string | null;
  reasoning: string | null;
  sources?: SourceCtx[] | null;
  attachments?: Attachment[] | null;
};

type SignalDetail = {
  signal_id: string;
  source: string | null;
  title: string | null;
  excerpt: string | null;
  quadrant: string | null;
  weight: number | null;
  metadata_json: string | null;
  participants: string[] | null;
};

function prettySource(s: string | null | undefined): string {
  if (!s) return "Source";
  if (s === "email") return "Email";
  if (s === "calendar") return "Calendar event";
  if (s.startsWith("google_drive_")) return "Google Drive";
  if (s === "projected") return "Earlier activity";
  return s;
}

function parseMeta(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Pretty sender for RFC-822 style `Name <email@x.com>` strings. Drops
// the angle-bracketed address so the modal doesn't blow out its width
// on long auto-generated do-not-reply addresses.
function friendlySender(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/^(.*?)\s*<[^>]+>\s*$/);
  if (m && m[1].trim()) return m[1].trim().replace(/^"|"$/g, "");
  return raw;
}

export function ItemDetailModal({
  open,
  onClose,
  actionId,
  signalId,
  title,
  alreadyInToday,
  onAddToToday,
  onChanged,
  planDate,
  onDone,
  removableRefId,
}: {
  open: boolean;
  onClose: () => void;
  actionId?: string;
  signalId?: string;
  title: string;
  alreadyInToday: boolean;
  onAddToToday?: () => void;
  onChanged?: () => void;
  // When set, the modal exposes a "Done" button. For action-backed
  // items it calls /send (markSent); for signal-only items it
  // writes a done=TRUE daily_slots row via /api/slots/done. The
  // optional onDone callback fires AFTER the modal closes so the
  // caller (FocusCard) can run a celebration overlay on the
  // surface behind.
  planDate?: string;
  onDone?: () => void;
  // Caller opted into a "Remove from calendar" button. The ref_id
  // identifies the daily_slots row to delete; if the slot was
  // previously synced to Google, /api/slots/remove also nukes the
  // Google event so we don't leave a ghost.
  removableRefId?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<ActionDetail | null>(null);
  const [signal, setSignal] = useState<SignalDetail | null>(null);

  // Editable mirrors of the draft (action) fields. Seeded from the
  // fetched action; saved via PATCH /api/actions/[id]. Signal-only
  // bullets stay read-only — there's nothing to edit on a raw signal.
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toRecipient, setToRecipient] = useState("");
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);

  // User-authored notes stored in BQ.item_notes. Loaded when the
  // modal opens, debounce-saved on blur. ref_id is whatever
  // discriminator the caller passes — action_id or signal_id.
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const noteRefId = actionId ?? signalId ?? "";

  // Schedule (due_at) — same item_notes table. Stored as ISO TS;
  // the <input type="datetime-local"> takes/produces a local
  // datetime string we convert on save.
  const [dueAt, setDueAt] = useState<string>(""); // local datetime-input value
  const [savedDueAt, setSavedDueAt] = useState<string>("");
  const [dueSaving, setDueSaving] = useState(false);

  // Attachments — drafted by Quadri (find_drive_attachments +
  // draft_email). Modal lets the user × any to remove.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentSaving, setAttachmentSaving] = useState(false);

  // Draft-on-demand state. When a signal-only email item has no
  // backing draft, the user can ask Quadri to write one. The
  // sessionId is a per-modal-open UUID so requests are isolated;
  // ADK's /run treats each session independently.
  const [drafting, setDrafting] = useState(false);
  const draftSessionRef = useRef<string>("");
  if (!draftSessionRef.current && typeof crypto !== "undefined") {
    draftSessionRef.current =
      "draft-" + ("randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`);
  }

  // Load existing notes + schedule whenever the modal opens for a
  // new ref.
  useEffect(() => {
    if (!open || !noteRefId) {
      setNotes("");
      setSavedNotes("");
      setDueAt("");
      setSavedDueAt("");
      return;
    }
    let cancelled = false;
    fetch(`/api/notes?ref_id=${encodeURIComponent(noteRefId)}`, {
      cache: "no-store",
    })
      .then((r) =>
        r.ok ? r.json() : { notes: null, due_at: null },
      )
      .then(
        (data: { notes: string | null; due_at: string | null }) => {
          if (cancelled) return;
          const n = data.notes ?? "";
          setNotes(n);
          setSavedNotes(n);
          // ISO → local datetime-input value (YYYY-MM-DDTHH:mm).
          if (data.due_at) {
            const d = new Date(data.due_at);
            if (!Number.isNaN(d.getTime())) {
              const local = new Date(
                d.getTime() - d.getTimezoneOffset() * 60_000,
              )
                .toISOString()
                .slice(0, 16);
              setDueAt(local);
              setSavedDueAt(local);
            } else {
              setDueAt("");
              setSavedDueAt("");
            }
          } else {
            setDueAt("");
            setSavedDueAt("");
          }
        },
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, noteRefId]);

  // Persist notes — fired on blur and on Done (so the user can
  // dash through quickly without thinking about saving).
  // On the user's first-ever save, surface a toast telling them
  // where the notes live on disk (~/Documents/quadri-notes.csv).
  // Tracked via localStorage so it shows once per browser, not
  // every time. Empty saves (just clearing the field) don't
  // trigger the toast.
  async function saveNotes(): Promise<boolean> {
    if (!noteRefId) return true;
    if (notes === savedNotes) return true;
    setNotesSaving(true);
    try {
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref_id: noteRefId, notes }),
      });
      if (!r.ok) {
        toast.error("Couldn't save notes");
        return false;
      }
      setSavedNotes(notes);
      if (notes.trim().length > 0 && typeof window !== "undefined") {
        const SHOWN = "quadri.notes.first-save-shown";
        if (!localStorage.getItem(SHOWN)) {
          toast.success("Notes saved", {
            description:
              "Auto-appending to ~/Documents/quadri-notes.csv every time you mark Done.",
            duration: 6000,
          });
          localStorage.setItem(SHOWN, "1");
        }
      }
      return true;
    } finally {
      setNotesSaving(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setAction(null);
    setSignal(null);
    setSubject("");
    setBody("");
    setToRecipient("");
    let cancelled = false;
    const fetchTarget = actionId
      ? `/api/actions/${actionId}`
      : signalId
        ? `/api/signals/${encodeURIComponent(signalId)}`
        : null;
    if (!fetchTarget) return;
    setLoading(true);
    fetch(fetchTarget, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (actionId) {
          const a = data as ActionDetail;
          setAction(a);
          setSubject(a.subject ?? "");
          setBody(a.body ?? "");
          setToRecipient(a.to_recipient ?? "");
          setAttachments(a.attachments ?? []);
        } else {
          setSignal(data as SignalDetail);
          setAttachments([]);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, actionId, signalId]);

  const isReadonly = action ? action.status === "sent" : true;
  const dirty =
    action !== null &&
    !isReadonly &&
    (subject !== (action.subject ?? "") ||
      body !== (action.body ?? "") ||
      toRecipient !== (action.to_recipient ?? ""));

  async function save(): Promise<boolean> {
    if (!action) return false;
    setSaving(true);
    try {
      const patch: Record<string, string> = { subject, body };
      if (action.action_type === "email_draft") patch.to_recipient = toRecipient;
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
      onChanged?.();
      return true;
    } finally {
      setSaving(false);
    }
  }

  // Save the schedule (due_at) for this item. For action-backed
  // email drafts we ALSO ask Quadri (via /api/chat) to call its
  // schedule_send tool so the email actually goes out at the
  // chosen time. For other items the due_at is informational —
  // surfaces in the modal and feeds into Quadri's chat context.
  async function saveSchedule(): Promise<boolean> {
    if (!noteRefId) return false;
    if (dueAt === savedDueAt) return true;
    setDueSaving(true);
    try {
      // Convert local datetime to UTC ISO. Empty value = clear.
      let iso: string | null = null;
      if (dueAt) {
        const local = new Date(dueAt);
        if (Number.isNaN(local.getTime())) {
          toast.error("Pick a valid date and time");
          return false;
        }
        iso = local.toISOString();
      }
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref_id: noteRefId, due_at: iso }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        toast.error(data.error ?? "Couldn't save schedule");
        return false;
      }
      setSavedDueAt(dueAt);

      // If the chosen time is TODAY (user-local), also write the
      // item into daily_slots so it appears on top in the calendar
      // strip and can be pushed to Google Calendar via the Sync
      // button. /api/slots/add returns 409 if a slot for this ref
      // already exists today — that's fine, just ignore: it means
      // an earlier schedule already wired it up.
      if (iso && dueAt) {
        const local = new Date(dueAt);
        const todayPT = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        const pickedPT = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(local);
        if (pickedPT === todayPT) {
          const slotStartMin =
            local.getHours() * 60 + local.getMinutes();
          const titleForSlot =
            action?.subject ?? signal?.title ?? title ?? "Scheduled item";
          // Await the slot insert so the parent-driven refetch
          // (onChanged → state refresh → CalendarStrip refetch via
          // refreshTick) sees the new row instead of racing past
          // it. 409 = slot already exists for this ref today — that's
          // fine, the schedule update is captured in item_notes.due_at.
          await fetch("/api/slots/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              plan_date: todayPT,
              slot_start_min: slotStartMin,
              duration_min: 15,
              item_ref_id: noteRefId,
              item_kind: action ? "committed_action" : "user",
              item_text: titleForSlot,
            }),
          }).catch(() => undefined);
        }
      }

      // For active email drafts, also fire schedule_send via chat
      // so the agent actually queues the send. Skipping when no
      // ISO (clear) or when the action is already sent.
      if (
        iso &&
        action &&
        action.action_type === "email_draft" &&
        action.status !== "sent" &&
        actionId
      ) {
        const sessionId =
          (typeof crypto !== "undefined" && "randomUUID" in crypto
            ? "sched-" + crypto.randomUUID()
            : "sched-" + Date.now());
        void fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message:
              `Schedule the send of action ${actionId} for ${iso}. ` +
              `Use the schedule_send tool. Don't quote scheduling preferences ` +
              `if the time falls in a blackout — just queue at the time the ` +
              `user picked.`,
            sessionId,
          }),
        }).catch(() => {});
      }

      const when = iso
        ? new Date(iso).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : null;
      toast.success(
        iso ? `Scheduled for ${when}` : "Schedule cleared",
      );
      onChanged?.();
      return true;
    } finally {
      setDueSaving(false);
    }
  }

  // Remove this item from today's calendar. Deletes the
  // daily_slots row and, if it was already synced, the Google
  // Calendar event too.
  const [removing, setRemoving] = useState(false);
  async function removeFromCalendar() {
    if (removing || !removableRefId || !planDate) return;
    setRemoving(true);
    try {
      const r = await fetch("/api/slots/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_date: planDate,
          item_ref_id: removableRefId,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        toast.error(data.error ?? "Couldn't remove from calendar");
        return;
      }
      const data = await r.json().catch(() => ({}));
      const googleRemoved =
        typeof data.google_events_removed === "number"
          ? data.google_events_removed
          : 0;
      toast.success(
        googleRemoved > 0
          ? `Removed from calendar (and Google Calendar)`
          : `Removed from calendar`,
      );
      onChanged?.();
      onClose();
    } finally {
      setRemoving(false);
    }
  }

  // Remove one attachment by file_id. PATCHes the action's
  // metadata.attachments to the new list (full replace).
  async function removeAttachment(fileId: string) {
    if (!action) return;
    if (attachmentSaving) return;
    const next = attachments.filter((a) => a.file_id !== fileId);
    setAttachmentSaving(true);
    setAttachments(next);
    try {
      const r = await fetch(`/api/actions/${action.action_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: next }),
      });
      if (!r.ok) {
        toast.error("Couldn't remove attachment");
        // Revert.
        setAttachments(attachments);
        return;
      }
      toast.success("Attachment removed");
      onChanged?.();
    } finally {
      setAttachmentSaving(false);
    }
  }

  // Ask Quadri to draft an email reply for this signal-only item.
  // The agent's draft_email tool inserts a row into proposed_actions
  // (status='drafted') linked to the source signal. After the chat
  // call returns, we refetch state — the FocusCard queue's
  // signal→action normalization will then route a re-open of this
  // item to /api/actions/<id> (the editable draft) instead of
  // /api/signals/<id> (read-only excerpt).
  async function draftReply() {
    if (drafting || !signal) return;
    setDrafting(true);
    // Tell the chat dock to flip its busy label to "Creating drafts…"
    // so the user has a single, consistent indicator for draft work
    // no matter where they triggered it from. The dock counts these
    // events so multiple in-flight drafts coalesce cleanly.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("quadri:drafting-start"));
    }
    try {
      const sender = (() => {
        const meta = parseMeta(signal.metadata_json);
        const from = typeof meta?.from === "string" ? meta.from : "";
        return friendlySender(from);
      })();
      const subj = signal.title ?? title;
      const msg = [
        "Please draft an email reply for me.",
        `Source signal_id: ${signal.signal_id}`,
        sender ? `From: ${sender}` : "",
        `Subject: ${subj}`,
        signal.excerpt ? `Excerpt: ${signal.excerpt}` : "",
        "Use the draft_email tool with this signal_id as a related signal.",
      ]
        .filter(Boolean)
        .join("\n");

      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          sessionId: draftSessionRef.current,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        toast.error(data.error ?? "Quadri couldn't draft right now");
        return;
      }
      toast.success("Draft created — reopen to see it");
      onChanged?.();
      onClose();
    } finally {
      setDrafting(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("quadri:drafting-end"));
      }
    }
  }

  // Mark-done flow. For action-backed items this stamps sent_at on
  // the action; for signal-only items it writes a done=TRUE row in
  // daily_slots so the rolling done-week view picks it up. The
  // onDone callback is fired after the modal closes so the caller
  // can run a celebration on the surface behind.
  // Three semantic flavors of "done" depending on what's open:
  //   - Email draft with no schedule  → SEND NOW via Gmail API,
  //     then mark sent. Done == release.
  //   - Email draft WITH a schedule   → just stamp it 'approved' so
  //     the FastAPI poller fires it at the scheduled time. Done ==
  //     confirm the queued send and close the modal.
  //   - Non-email action              → mark sent (existing).
  //   - Signal-only item              → write done=TRUE in slots.
  async function markDone() {
    if (marking) return;
    if (action && !isReadonly && dirty) {
      const ok = await save();
      if (!ok) return;
    }
    if (notes !== savedNotes) {
      const ok = await saveNotes();
      if (!ok) return;
    }
    // Persist any pending schedule before deciding send-now vs
    // schedule. Otherwise a user who picks a time and clicks Send
    // before the input's onBlur fires would race past the save
    // and the email would go out immediately — the bug we fixed
    // here on 2026-05-18.
    if (dueAt !== savedDueAt) {
      const ok = await saveSchedule();
      if (!ok) return;
    }
    setMarking(true);
    try {
      let ok = false;
      let closeWithCelebration = true;
      const isEmail =
        action && action.action_type === "email_draft" && !isReadonly;
      // Use `dueAt` (the input's current value) directly. We just
      // awaited saveSchedule above so the value is guaranteed
      // persisted; relying on `savedDueAt` here would read a stale
      // closure value because React state updates don't propagate
      // synchronously.
      const scheduledIso = dueAt ? new Date(dueAt).toISOString() : null;

      if (isEmail && action) {
        if (scheduledIso) {
          // Schedule path: schedule_send already wired via the
          // saveSchedule chat call. Here we just bump the action
          // to 'approved' so the FastAPI poller treats it as live
          // and fires at scheduled time. No actual send yet.
          const r = await fetch(`/api/actions/${action.action_id}/decide`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "approve" }),
          });
          ok = r.ok;
          if (ok) {
            const when = new Date(scheduledIso).toLocaleString(
              undefined,
              {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              },
            );
            toast.success(`Queued — will send at ${when}`);
          } else {
            toast.error("Couldn't queue the send");
          }
        } else {
          // Send-now path: fire Gmail API immediately. Pull
          // attachments off the action (already loaded in state).
          if (!toRecipient.trim()) {
            toast.error("Add a recipient before sending");
            return;
          }
          const r = await fetch("/api/gmail/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              to: toRecipient,
              subject,
              body,
              attachment_file_ids: attachments.map((a) => a.file_id),
            }),
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            toast.error(data.error ?? "Send failed");
            return;
          }
          // Gmail accepted it → mark sent in our store too.
          ok = await markSent(action.action_id);
        }
      } else if (action) {
        ok = await markSent(action.action_id);
      } else if (signalId && planDate) {
        const r = await fetch("/api/slots/done", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan_date: planDate,
            item_ref_id: signalId,
            item_kind: "user",
            item_text: signal?.title ?? title,
          }),
        });
        ok = r.ok;
        if (!ok) {
          const data = await r.json().catch(() => ({}));
          toast.error(data.error ?? "Couldn't mark done");
        }
      } else {
        toast.error("Can't mark done — missing context");
      }
      if (ok) {
        onChanged?.();
        onClose();
        if (closeWithCelebration && onDone) {
          window.setTimeout(onDone, 60);
        }
      }
    } finally {
      setMarking(false);
    }
  }

  const sources: SourceCtx[] = action?.sources ?? [];
  const isEmail = action?.action_type === "email_draft";
  const isCalEvent = action?.action_type === "calendar_event";
  // Done is offered whenever the caller wired up planDate (or there
  // is a non-sent action). Sent actions are already terminal.
  const canMarkDone =
    !marking &&
    ((action && action.status !== "sent") ||
      (!action && !!signalId && !!planDate));
  // Offer "Draft a reply" when this is a signal-only item AND the
  // source signal is an email. Hides for drive docs / calendar
  // events / non-email sources where a reply doesn't make sense.
  const canDraft =
    !drafting &&
    !action &&
    !!signal &&
    !!signalId &&
    (signal.source === "email" || signal.source === "projected");

  // For signal-only items we synthesize a single "Source" panel from
  // the signal itself so the UI is consistent.
  const signalAsSource: SourceCtx[] = signal
    ? [
        {
          signal_id: signal.signal_id,
          source: signal.source,
          title: signal.title,
          excerpt: signal.excerpt,
          quadrant: signal.quadrant,
          weight: signal.weight,
          occurred_at: null,
          metadata_json: signal.metadata_json,
        },
      ]
    : [];
  const allSources = sources.length > 0 ? sources : signalAsSource;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "overflow-hidden",
          // Email drafts get a landscape layout so the composer feels
          // like Gmail — To / Subject / Body / Attachments stacked
          // vertically in a wide left column, source + schedule +
          // notes as a sidebar on the right. Signal-only items stay
          // portrait since there's nothing email-shaped to show.
          isEmail ? "max-w-4xl" : "max-w-lg",
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-base leading-snug">
            {action?.subject ?? signal?.title ?? title}
          </DialogTitle>
          {action?.reasoning ? (
            <DialogDescription className="text-xs italic text-foreground/60">
              {action.reasoning}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-foreground/40" />
          </div>
        ) : isEmail ? (
          // ─── Email-draft layout: landscape, Gmail-shaped ──────────
          // Left column = the email composer (To / Subject / Body /
          // Attachments stacked top→bottom, attachments visually
          // anchored to the bottom of the body like Gmail).
          // Right column = the "why" sidebar: source context,
          // schedule send, notes. Stacks to single column on mobile.
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Composer — 2/3 width on md+ */}
            <div className="space-y-3 md:col-span-2">
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                  To
                </label>
                <Input
                  value={toRecipient}
                  onChange={(e) => setToRecipient(e.target.value)}
                  disabled={isReadonly || saving}
                  className="text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                  Subject
                </label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={isReadonly || saving}
                  className="text-xs"
                />
              </div>
              {/* Body + attachments as one visual block, like Gmail's
                  compose window. Border wraps both so the chips read
                  as "files attached to this message." */}
              <div className="overflow-hidden rounded-md border border-input shadow-xs">
                <textarea
                  rows={12}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={isReadonly || saving}
                  className={cn(
                    "flex w-full bg-background px-3 py-2 text-xs leading-relaxed",
                    "focus-visible:outline-none",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "resize-none border-0",
                  )}
                  placeholder="Body…"
                />
                {action && attachments.length > 0 ? (
                  <div className="border-t border-neutral-200 bg-neutral-50/60 px-3 py-2">
                    <ul className="flex flex-wrap gap-1.5">
                      {attachments.map((a) => (
                        <li
                          key={a.file_id}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] shadow-xs"
                        >
                          <Paperclip
                            className="size-3 shrink-0 text-neutral-500"
                            aria-hidden
                          />
                          <span
                            className="line-clamp-1 max-w-[220px] text-neutral-800"
                            title={a.name}
                          >
                            {a.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => void removeAttachment(a.file_id)}
                            disabled={
                              attachmentSaving || action.status === "sent"
                            }
                            className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800 disabled:opacity-40"
                            title="Remove this attachment"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Sidebar — 1/3 width on md+ */}
            <div className="space-y-3 md:col-span-1">
              {/* Source(s) */}
              {allSources.length > 0 ? (
                <div className="min-w-0 space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                    {allSources.length === 1
                      ? "Source"
                      : `Sources (${allSources.length})`}
                  </div>
                  {allSources.map((src) => {
                    const meta = parseMeta(src.metadata_json);
                    const fromRaw =
                      typeof meta?.from === "string" ? meta.from : "";
                    const from = friendlySender(fromRaw);
                    const driveLink =
                      typeof meta?.web_view_link === "string"
                        ? meta.web_view_link
                        : "";
                    return (
                      <div key={src.signal_id} className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/60">
                          <span className="rounded bg-white px-1.5 py-0.5 font-medium">
                            {prettySource(src.source)}
                          </span>
                          {from ? (
                            <span
                              className="min-w-0 max-w-full truncate"
                              title={fromRaw}
                            >
                              {from}
                            </span>
                          ) : null}
                          {src.quadrant ? (
                            <span className="rounded bg-white px-1.5 py-0.5 capitalize">
                              {src.quadrant}
                            </span>
                          ) : null}
                          {driveLink ? (
                            <a
                              href={driveLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 text-sky-700 hover:underline"
                            >
                              open <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : null}
                        </div>
                        {src.title ? (
                          <div className="break-words text-sm font-medium leading-snug text-foreground/90">
                            {src.title}
                          </div>
                        ) : null}
                        {src.excerpt ? (
                          <p className="whitespace-pre-wrap break-words text-xs leading-snug text-foreground/75">
                            {src.excerpt}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* Schedule */}
              {noteRefId ? (
                <div className="space-y-1">
                  <label className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                    <CalendarClock className="size-3" aria-hidden />
                    Schedule send
                  </label>
                  <input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                    onBlur={() => {
                      if (dueAt !== savedDueAt) void saveSchedule();
                    }}
                    disabled={dueSaving || action?.status === "sent"}
                    className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-xs focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <div className="flex items-center justify-between text-[10px] text-foreground/45">
                    <span>
                      {dueSaving
                        ? "Saving…"
                        : dueAt !== savedDueAt
                          ? "Unsaved — leave the field or click Save"
                          : savedDueAt
                            ? "Saved"
                            : ""}
                    </span>
                    {dueAt !== savedDueAt ? (
                      <button
                        type="button"
                        onClick={() => void saveSchedule()}
                        disabled={dueSaving}
                        className="text-sky-700 hover:underline"
                      >
                        Save
                      </button>
                    ) : savedDueAt ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDueAt("");
                          void saveSchedule();
                        }}
                        className="hover:text-neutral-800 hover:underline"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* Notes */}
              {noteRefId ? (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                    Your notes
                  </label>
                  <textarea
                    rows={4}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onBlur={() => {
                      void saveNotes();
                    }}
                    placeholder="Anything you want to remember…"
                    disabled={notesSaving}
                    className={cn(
                      "flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-xs leading-relaxed",
                      "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                      "resize-none",
                    )}
                  />
                  <div className="text-[10px] text-foreground/45">
                    {notesSaving
                      ? "Saving…"
                      : notes !== savedNotes
                        ? "Unsaved — click outside to save"
                        : "Saved"}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          // ─── Non-email layout: portrait single column ─────────────
          <div className="space-y-3">
            {allSources.length > 0 ? (
              <div className="min-w-0 space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
                <div className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                  {allSources.length === 1
                    ? "Source"
                    : `Sources (${allSources.length})`}
                </div>
                {allSources.map((src) => {
                  const meta = parseMeta(src.metadata_json);
                  const fromRaw = typeof meta?.from === "string" ? meta.from : "";
                  const from = friendlySender(fromRaw);
                  const driveLink =
                    typeof meta?.web_view_link === "string" ? meta.web_view_link : "";
                  return (
                    <div key={src.signal_id} className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/60">
                        <span className="rounded bg-white px-1.5 py-0.5 font-medium">
                          {prettySource(src.source)}
                        </span>
                        {from ? (
                          <span
                            className="min-w-0 max-w-full truncate"
                            title={fromRaw}
                          >
                            {from}
                          </span>
                        ) : null}
                        {src.quadrant ? (
                          <span className="rounded bg-white px-1.5 py-0.5 capitalize">
                            {src.quadrant}
                          </span>
                        ) : null}
                        {driveLink ? (
                          <a
                            href={driveLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-sky-700 hover:underline"
                          >
                            open <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : null}
                      </div>
                      {src.title ? (
                        <div className="break-words text-sm font-medium leading-snug text-foreground/90">
                          {src.title}
                        </div>
                      ) : null}
                      {src.excerpt ? (
                        <p className="whitespace-pre-wrap break-words text-xs leading-snug text-foreground/75">
                          {src.excerpt}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {noteRefId ? (
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                  <CalendarClock className="size-3" aria-hidden />
                  Schedule / due
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="datetime-local"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                    onBlur={() => {
                      if (dueAt !== savedDueAt) void saveSchedule();
                    }}
                    disabled={dueSaving || action?.status === "sent"}
                    className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs shadow-xs focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {dueAt !== savedDueAt ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void saveSchedule()}
                      disabled={dueSaving}
                      className="border-sky-300 text-sky-700 hover:bg-sky-50"
                    >
                      {dueSaving ? (
                        <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
                      ) : null}
                      Save
                    </Button>
                  ) : savedDueAt ? (
                    <button
                      type="button"
                      onClick={() => {
                        setDueAt("");
                        void saveSchedule();
                      }}
                      className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-800 hover:underline"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
                <div className="text-[10px] text-foreground/45">
                  {dueSaving
                    ? "Saving schedule…"
                    : dueAt !== savedDueAt
                      ? "Unsaved — leave the field or click Save"
                      : savedDueAt
                        ? "Saved"
                        : ""}
                </div>
              </div>
            ) : null}

            {noteRefId ? (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                  Your notes
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => {
                    void saveNotes();
                  }}
                  placeholder="Anything you want to remember about this — context, decisions, what to do next…"
                  disabled={notesSaving}
                  className={cn(
                    "flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-xs leading-relaxed",
                    "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "resize-none",
                  )}
                />
                <div className="text-[10px] text-foreground/45">
                  {notesSaving
                    ? "Saving…"
                    : notes !== savedNotes
                      ? "Unsaved — click outside to save"
                      : "Saved"}
                </div>
              </div>
            ) : null}

            {action && !isEmail ? (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                    Subject
                  </label>
                  <Input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={isReadonly || saving}
                    className="text-xs"
                  />
                </div>
                {action.body ? (
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-foreground/55">
                      Description
                    </label>
                    <textarea
                      rows={3}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={isReadonly || saving}
                      className={cn(
                        "flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-xs leading-relaxed",
                        "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[3px] focus-visible:outline-none",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        "resize-none",
                      )}
                    />
                  </div>
                ) : null}
                {isCalEvent ? (
                  <div className="text-[11px] text-foreground/55">
                    This is a scheduled time block — pin it to today to see it on the bar.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          {removableRefId && planDate ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void removeFromCalendar()}
              disabled={removing}
              className="border-rose-300 text-rose-700 hover:bg-rose-50"
              title="Take this off the calendar (and Google Calendar if it was synced)"
            >
              {removing ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
              ) : (
                <CalendarX className="mr-1 size-3.5" aria-hidden />
              )}
              Remove from calendar
            </Button>
          ) : null}
          {action && !isReadonly ? (
            <Button
              size="sm"
              variant={dirty ? "default" : "outline"}
              onClick={save}
              disabled={!dirty || saving}
              className={dirty ? "bg-sky-600 text-white hover:bg-sky-700" : undefined}
            >
              <Save className="mr-1 size-3.5" aria-hidden />
              {dirty ? "Save changes" : "Saved"}
            </Button>
          ) : null}
          {onAddToToday && !alreadyInToday ? (
            <Button
              size="sm"
              onClick={async () => {
                if (dirty) {
                  const ok = await save();
                  if (!ok) return;
                }
                onAddToToday();
                onClose();
              }}
            >
              <ListPlus className="mr-1 size-3.5" aria-hidden />
              Add to today
            </Button>
          ) : null}
          {canDraft ? (
            <Button
              size="sm"
              variant="outline"
              onClick={draftReply}
              disabled={drafting}
              className="border-sky-300 text-sky-700 hover:bg-sky-50"
            >
              {drafting ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="mr-1 size-3.5" aria-hidden />
              )}
              {drafting ? "Drafting…" : "Draft a reply"}
            </Button>
          ) : null}
          {canMarkDone ? (
            (() => {
              // Single button label per item type. Schedule context
              // is already visible above (the "Schedule send" input
              // and saved-time line); duplicating it in the button
              // copy just clutters. Toast tells the user what
              // actually happened on click.
              const isEmail =
                action && action.action_type === "email_draft" && !isReadonly;
              const label = isEmail ? "Send" : "Done";
              return (
                <Button
                  size="sm"
                  onClick={markDone}
                  disabled={marking}
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  <Check className="mr-1 size-3.5" aria-hidden />
                  {label}
                </Button>
              );
            })()
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
