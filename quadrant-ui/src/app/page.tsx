"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatDock } from "@/components/chat-dock";
import { CalendarStrip } from "@/components/calendar-strip";
import { FocusCard } from "@/components/focus-card";
import { DoneToday } from "@/components/done-today";
import { computeQuadriScore } from "@/lib/quadri-score";
import { todayLocalISO } from "@/lib/date";
import { isDemoMode } from "@/lib/demo-mode";
import type { DashboardState } from "@/lib/types";

// Layout (locked 2026-05-17, lanes redesign):
// - Header with Quadri Score
// - "Today on your calendar" strip — external commitments, read-only
// - FocusCard 3-lane stack: Now Brewing / Up Next / Later
// - Right-side chat dock (Quadri)
//
// The time bar (24h grid + slot drag-drop + drop modal) was removed
// here on 2026-05-17. Time-blindness made scheduled slots a source
// of shame more than utility. Lanes carry the "what's next" signal
// without the clock.

export default function Home() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every refresh. DoneToday uses it as its refetch key so
  // the panel reflects fresh sends/Done clicks without a hard reload.
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as DashboardState;
      setState(data);
      setError(null);
      setRefreshTick((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Quadri</h1>
        <p className="mt-4 text-rose-600">Failed to load state: {error}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Check that you ran <code className="rounded bg-muted px-1">gcloud auth application-default login</code>{" "}
          and that the BigQuery views exist.
        </p>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="mx-auto max-w-7xl p-8">
        <h1 className="text-2xl font-semibold">Quadri</h1>
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  const quadriScore = computeQuadriScore(state);
  const planDate = todayLocalISO();

  return (
    <main className="flex h-dvh overflow-hidden bg-neutral-50">
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight text-neutral-900">
                Quadri
              </h1>
              {isDemoMode() ? (
                <span
                  className="rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800"
                  title="Demo mode — Send / Sync calls are sandboxed. No real Gmail or Google Calendar writes leave this deployment."
                >
                  Demo
                </span>
              ) : null}
            </div>
            <div
              className="flex items-baseline gap-1.5"
              title={quadriScore.summary}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                Quadri Score
              </span>
              <span className="text-base font-semibold tabular-nums text-neutral-900">
                {quadriScore.score}
              </span>
              <span className="text-[11px] text-neutral-400">/ 100</span>
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <CalendarStrip planDate={planDate} externalRefreshKey={refreshTick} />
          <FocusCard
            state={state}
            onChanged={refresh}
            scoreComponents={quadriScore.components}
          />
          <DoneToday refreshKey={refreshTick} />
        </div>
      </div>

      <aside className="hidden w-[380px] shrink-0 border-l border-neutral-200 bg-white lg:flex lg:flex-col">
        <ChatDock onAgentResponse={refresh} />
      </aside>
    </main>
  );
}
