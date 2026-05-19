"use client";

// "Done today" — the ADHD "you did more than you thought" panel.
//
// Renders after a soft check-in: collapsed by default, expand chevron
// shows the full list. Hidden entirely when zero items so the section
// doesn't become a guilt trip on a quiet morning. Pulls from
// /api/done/today which already joined slot rows, sent actions, signal
// titles, and subjects into one ranked feed.
//
// Refreshes on the same key the page uses (incremented after any
// Done/Send/markdone flow), so newly-completed items appear without
// a page reload.

import { useEffect, useState } from "react";
import {
  ChevronDown,
  CheckCircle2,
  Mail,
  Calendar as CalendarIcon,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";

type DoneItem = {
  ref_id: string;
  title: string;
  source: string;
  done_at: string;
};

function SourceIcon({ source }: { source: string }) {
  if (source === "email")
    return <Mail className="size-3 shrink-0 text-emerald-600" aria-hidden />;
  if (source === "calendar")
    return (
      <CalendarIcon className="size-3 shrink-0 text-emerald-600" aria-hidden />
    );
  if (source.startsWith("google_drive_"))
    return <FileText className="size-3 shrink-0 text-emerald-600" aria-hidden />;
  return (
    <CheckCircle2 className="size-3 shrink-0 text-emerald-600" aria-hidden />
  );
}

function fmtTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DoneToday({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<DoneItem[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/done/today", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data: { items?: DoneItem[] }) => {
        if (!cancelled) setItems(data.items ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (items.length === 0) return null;

  // Initial peek: 3 most recent. Tap to expand for the rest.
  const peek = items.slice(0, 3);
  const rest = items.slice(3);

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-emerald-50/70"
      >
        <CheckCircle2
          className="size-3.5 shrink-0 text-emerald-700"
          aria-hidden
        />
        <span className="text-[11px] font-medium uppercase tracking-wider text-emerald-800">
          Done today
        </span>
        <span className="text-[11px] tabular-nums text-emerald-700/80">
          ({items.length})
        </span>
        {rest.length > 0 ? (
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 text-emerald-600 transition-transform",
              expanded ? "rotate-180" : "",
            )}
            aria-hidden
          />
        ) : null}
      </button>
      <ul className="divide-y divide-emerald-100 border-t border-emerald-100">
        {peek.map((it) => (
          <li
            key={it.ref_id}
            className="flex items-center gap-2 px-3 py-1.5 text-sm"
          >
            <SourceIcon source={it.source} />
            <span className="line-clamp-1 flex-1 text-emerald-900 line-through decoration-emerald-400">
              {it.title}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-emerald-700/70">
              {fmtTime(it.done_at)}
            </span>
          </li>
        ))}
        {expanded
          ? rest.map((it) => (
              <li
                key={it.ref_id}
                className="flex items-center gap-2 px-3 py-1.5 text-sm"
              >
                <SourceIcon source={it.source} />
                <span className="line-clamp-1 flex-1 text-emerald-900 line-through decoration-emerald-400">
                  {it.title}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-emerald-700/70">
                  {fmtTime(it.done_at)}
                </span>
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
