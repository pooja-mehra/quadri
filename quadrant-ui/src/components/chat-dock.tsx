"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Mic, MicOff, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { QuadriAvatar } from "@/components/quadri-avatar";
import {
  getSpeechRecognition,
  speak,
  type SpeechRecognitionInstance,
} from "@/lib/speech";

// `actions` carry inline directive-driven buttons that the chat-dock
// renders below the agent's text. Quadri emits these via tokens like
// `<<connect-google>>` in its reply, which the parser strips and
// surfaces as a button instead.
type Message = {
  role: "user" | "agent";
  text: string;
  actions?: Array<"connect-google" | "sync-today">;
};

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ChatDock({
  onAgentResponse,
}: {
  onAgentResponse?: () => void;
}) {
  const [sessionId] = useState(makeSessionId);

  // Google account connection status — polled once on mount and refreshed
  // when the user returns from the OAuth callback (?google_auth=ok).
  // null = still loading; true/false = known state.
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null);
  // Onboarding completion — also polled from /api/auth/google/status.
  // If false, the connect → fetch flow is gated behind a chat-driven
  // scope picker (Quadri lists what it can read and asks before fetching).
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/auth/google/status", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { authorized: false, onboarding_completed: false }))
        .then((d: { authorized?: boolean; onboarding_completed?: boolean }) => {
          if (cancelled) return;
          setGoogleConnected(Boolean(d?.authorized));
          setOnboardingCompleted(Boolean(d?.onboarding_completed));
        })
        .catch(() => {
          if (cancelled) return;
          setGoogleConnected(false);
          setOnboardingCompleted(false);
        });
    };
    check();
    // If the OAuth callback dropped us back with ?google_auth=ok, re-check
    // so the indicator flips without a full reload.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("google_auth") === "ok") {
        check();
        url.searchParams.delete("google_auth");
        window.history.replaceState({}, "", url.toString());
      }
    }
    // Re-check when the tab regains focus — catches the case where the
    // user revoked the app on Google's side (or in another tab) without
    // reloading Quadrant. Without this, the badge stays stale until the
    // next full reload.
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Contextual loading label. Defaults to "thinking…" but switches
  // to "Creating drafts…" while Quadri is mid-flight on the opener
  // (inbox-scan + draft generation) and while the modal's "Draft
  // a reply" call is in flight (those fire window events the dock
  // listens for so progress is visible across surfaces).
  const [busyMessage, setBusyMessage] = useState<string>("thinking…");
  // Counter for outstanding "drafting" work — multiple sources can
  // start/stop draft work in parallel, so we count rather than
  // toggle a boolean.
  const draftingCountRef = useRef(0);
  useEffect(() => {
    function onDraftStart() {
      draftingCountRef.current += 1;
      setBusyMessage("Creating drafts…");
      setBusy(true);
    }
    function onDraftEnd() {
      draftingCountRef.current = Math.max(0, draftingCountRef.current - 1);
      if (draftingCountRef.current === 0) {
        setBusyMessage("thinking…");
        // Don't force-clear busy here — the in-flight chat call
        // will clear it when its response lands. This just resets
        // the label so the next setBusy(true) doesn't show stale
        // "Creating drafts…".
      }
    }
    window.addEventListener("quadri:drafting-start", onDraftStart);
    window.addEventListener("quadri:drafting-end", onDraftEnd);
    return () => {
      window.removeEventListener("quadri:drafting-start", onDraftStart);
      window.removeEventListener("quadri:drafting-end", onDraftEnd);
    };
  }, []);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Post-connect flow: when Google is connected, fire either the
  // onboarding intro (if user hasn't completed scope/behavior picking
  // yet) or the silent inbox-scan (if they have). The onboarding flow is
  // chat-driven — Quadri lists what it can read, asks scope, asks
  // behavior, saves prefs, then begins scanning. Inbox-scan is silent
  // and side-effect only.
  const inboxScanSentRef = useRef(false);
  useEffect(() => {
    if (googleConnected !== true) return;
    if (onboardingCompleted === null) return;  // still loading
    if (inboxScanSentRef.current) return;
    inboxScanSentRef.current = true;
    const message = onboardingCompleted
      ? "[internal:inbox-scan]"
      : "[internal:onboarding-start]";
    // For the silent inbox-scan path, surface "Creating drafts…"
    // in the dock so the user knows Quadri is actively working
    // (the call itself returns empty by design). Onboarding-start
    // is conversational so it stays on the default label.
    if (onboardingCompleted) {
      setBusyMessage("Creating drafts…");
      setBusy(true);
    }
    void (async () => {
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, sessionId }),
        });
        // For onboarding-start, the agent's reply IS visible (it asks
        // the user about scope). For inbox-scan, the reply is empty by
        // design. Either way, surface the reply in chat if non-empty.
        if (!onboardingCompleted) {
          const data = (await r.json()) as { response?: string };
          const clean = (data.response ?? "")
            .replace(/<<view-date:\d{4}-\d{2}-\d{2}>>/g, "")
            .replace(/<<connect-google>>/g, "")
            .trim();
          if (clean) {
            setMessages((m) => [...m, { role: "agent", text: clean }]);
          }
        }
        onAgentResponse?.();
      } catch {
        // Silent — user can prod Quadri manually.
      } finally {
        if (onboardingCompleted) {
          setBusy(false);
          setBusyMessage("thinking…");
        }
      }
    })();
  }, [googleConnected, onboardingCompleted, sessionId, onAgentResponse]);

  // Pre-connect intro: when the user is NOT yet connected to Google,
  // show a static welcome that explains the defaults + example prefs +
  // a Connect button. Hardcoded (not LLM-generated) so it loads
  // instantly and the wording is stable — users see what they're
  // signing up for BEFORE they consent. The post-connect
  // [internal:onboarding-start] flow handles the interactive
  // preference-setting once they're authorized.
  const preConnectShownRef = useRef(false);
  useEffect(() => {
    if (preConnectShownRef.current) return;
    if (googleConnected !== false) return;  // wait until we know !authed
    if (messages.length > 0) return;
    preConnectShownRef.current = true;
    setMessages([
      {
        role: "agent",
        text:
          "Welcome! Before I look at anything, here's what I'll do — so you know what you're signing up for.\n\n" +
          "By default I'll:\n" +
          "- Read your emails and Drive docs from the last 1 week\n" +
          "- Infer signals and prioritize them for you across the four quadrants\n" +
          "- Draft email replies — but I won't send them automatically. You ask me, I send.\n\n" +
          "You can also tell me things like:\n" +
          "- “GK4I emails are highest priority”\n" +
          "- “Don't send emails before 9 AM or after 10 PM”\n" +
          "- “Send me the draft an hour before it's scheduled”\n" +
          "- “Don't read Drive sheets, just docs”\n\n" +
          "Connect your Google account when you're ready, and I'll ask what you want me to remember.",
        actions: ["connect-google"],
      },
    ]);
  }, [googleConnected, messages.length]);

  // Proactive opener: on first mount AFTER connect, ask Quadri to
  // generate a brief contextual greeting (notices a deferred item,
  // gaps in schedule, or just checks in). Skipped if the user is
  // unauthorized (the pre-connect intro above runs instead) or has
  // already started chatting.
  const openerSentRef = useRef(false);
  useEffect(() => {
    if (openerSentRef.current) return;
    if (googleConnected !== true) return;  // wait until connected
    if (onboardingCompleted !== true) return;  // onboarding-start handles greeting
    if (messages.length > 0) return;
    openerSentRef.current = true;
    const prompt =
      "[internal:opener] First call list_pending_actions to see " +
      "drafts you've prepared. Then write ONE short message that:\n" +
      "  1. Greets briefly (one line, ~10 words). No 'Hi, I'm Quadri'.\n" +
      "  2. If email_draft actions exist, surface them as a bulleted " +
      "list (max 5) in the format: '✓ <subject>'. Bias toward the " +
      "freshest. After the list write ONE line: 'Ask me to review, " +
      "edit, send, or schedule any of these — or open the card to " +
      "do it yourself.'\n" +
      "  3. If there are zero email drafts, skip the list. Just the " +
      "greeting plus one neutral check-in ('How's the day shaping " +
      "up?').\n" +
      "Do NOT mention workload, packed days, or rebalancing — the " +
      "Quadri Score in the header covers day shape. Don't pluck " +
      "random todos — only surface the actual drafts you found.";
    void (async () => {
      setBusyMessage("Creating drafts…");
      setBusy(true);
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: prompt, sessionId }),
        });
        const data = (await r.json()) as { response?: string };
        if (!r.ok || !data.response) return;
        // Strip view-date (no side-effect nav on first open) but DO
        // honor <<connect-google>> if the agent offers it as part of
        // the greeting (proactive nudge when there are unsynced
        // changes and the user hasn't authorized yet).
        const hasConnect = /<<connect-google>>/.test(data.response);
        const clean = data.response
          .replace(/<<view-date:\d{4}-\d{2}-\d{2}>>/g, "")
          .replace(/<<connect-google>>/g, "")
          .trim();
        if (clean) {
          setMessages([
            {
              role: "agent",
              text: clean,
              actions: hasConnect ? ["connect-google"] : undefined,
            },
          ]);
        }
      } catch {
        // Silent — fallback message renders below if the opener fails.
      } finally {
        setBusy(false);
        setBusyMessage("thinking…");
      }
    })();
  }, [googleConnected, onboardingCompleted, messages.length, sessionId]);

  function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const r = getSpeechRecognition();
    if (!r) {
      toast.error("Voice input isn't supported in this browser");
      return;
    }
    r.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      if (transcript) {
        setInput((cur) => (cur ? `${cur} ${transcript}` : transcript));
      }
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognitionRef.current = r;
    r.start();
    setListening(true);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;

    setMessages((m) => [...m, { role: "user", text: msg }]);
    setInput("");
    setBusy(true);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, sessionId }),
      });
      const data = (await r.json()) as { response?: string; error?: string };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      // Parse the agent reply for directives. Recognized tokens:
      //   <<connect-google>>  → render an inline "Connect Google
      //                          Calendar" button under the reply.
      // <<view-date:...>> was removed 2026-05-14 along with date
      // navigation — strip any stragglers from older prompts so they
      // don't render as literal text.
      const rawResponse = data.response ?? "";
      const hasConnectGoogle = /<<connect-google>>/.test(rawResponse);
      const cleanResponse = rawResponse
        .replace(/<<view-date:\d{4}-\d{2}-\d{2}>>/g, "")
        .replace(/<<connect-google>>/g, "")
        .trim();
      const actions: Message["actions"] = [];
      if (hasConnectGoogle) actions.push("connect-google");
      setMessages((m) => [
        ...m,
        { role: "agent", text: cleanResponse, actions: actions.length ? actions : undefined },
      ]);
      onAgentResponse?.();
      // The agent may have called slot-mutating tools (add_time_block,
      // move_slot_to_date, etc.). The bar's slots state only refetches
      // on its own internal triggers; without this nudge, a Quadri-
      // scheduled item lands in BQ but not in the bar UI.
      window.dispatchEvent(new CustomEvent("quadri:slot-confirmed"));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Chat failed";
      toast.error(errMsg);
      setMessages((m) => [...m, { role: "agent", text: `⚠ ${errMsg}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3">
        <QuadriAvatar size={22} pulsing={busy} />
        <span className="text-sm font-semibold text-neutral-900">Quadri</span>
        <span className="ml-auto text-[11px] text-neutral-500">
          {busy ? "thinking…" : "ready"}
        </span>
      </div>
      {googleConnected === false ? (
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-amber-50 px-4 py-2">
          <span className="text-[11px] text-amber-900">
            Connect your Google account to sync calendar and email.
          </span>
          <button
            type="button"
            onClick={() => {
              window.location.href = `/api/auth/google?return_to=${encodeURIComponent(
                window.location.pathname,
              )}`;
            }}
            className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
          >
            Connect Google
          </button>
        </div>
      ) : googleConnected === true ? (
        <div className="flex items-center gap-1.5 border-b border-neutral-200 bg-emerald-50 px-4 py-1.5 text-[11px] text-emerald-800">
          <CheckCircle2 className="size-3" aria-hidden />
          <span>Google account connected</span>
          <button
            type="button"
            onClick={async () => {
              try {
                await fetch("/api/auth/google/disconnect", { method: "POST" });
              } finally {
                setGoogleConnected(false);
                setOnboardingCompleted(false);
                inboxScanSentRef.current = false;
                preConnectShownRef.current = false;
                openerSentRef.current = false;
                setMessages([]);
              }
            }}
            className="ml-auto rounded px-1.5 py-0.5 text-emerald-800 hover:bg-emerald-100"
          >
            Disconnect
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {messages.length === 0 && !busy ? (
          <p className="text-xs italic leading-relaxed text-neutral-400">
            Quadri is looking at your week&hellip;
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <div key={i} className="text-sm">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                  <span>{m.role === "user" ? "you" : "Quadri"}</span>
                  {m.role === "agent" ? (
                    <button
                      type="button"
                      onClick={() => speak(m.text)}
                      className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                      aria-label="Speak"
                      title="Speak"
                    >
                      <Volume2 className="size-3" aria-hidden />
                    </button>
                  ) : null}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed text-neutral-800">
                  {m.text}
                </div>
                {m.actions?.includes("connect-google") ? (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = `/api/auth/google?return_to=${encodeURIComponent(
                        window.location.pathname,
                      )}`;
                    }}
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                  >
                    Connect Google Calendar
                  </button>
                ) : null}
              </div>
            ))}
            {busy ? (
              <div className="text-sm">
                <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                  Quadri
                </div>
                <div className="flex items-center gap-1.5 text-neutral-500">
                  <span className="size-1.5 animate-pulse rounded-full bg-sky-400" aria-hidden />
                  {busyMessage}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-t border-neutral-200 px-3 py-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            listening ? "Listening…" : busy ? "Thinking…" : "Ask Quadri…"
          }
          className="border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={busy}
        />
        <Button
          size="icon-sm"
          variant={listening ? "default" : "ghost"}
          onClick={toggleMic}
          disabled={busy}
          aria-label={listening ? "Stop listening" : "Start voice input"}
          title={listening ? "Stop listening" : "Voice input"}
        >
          {listening ? (
            <MicOff className="size-4" aria-hidden />
          ) : (
            <Mic className="size-4" aria-hidden />
          )}
        </Button>
        <Button size="sm" disabled={busy || !input.trim()} onClick={send}>
          Send
        </Button>
      </div>
    </div>
  );
}
