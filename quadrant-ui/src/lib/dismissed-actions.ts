"use client";

// localStorage-backed set of action_ids the user has rejected/deleted today.
// Used by TodaySection to hide them from the today panel + time bar so the
// three surfaces (pending chip, committed chip, today panel) stay in sync
// without needing an API change.
//
// Keyed by date so yesterday's dismissals don't leak forward.

const KEY = (planDate: string) => `quadri:dismissed:${planDate}`;

export function readDismissed(planDate: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(planDate));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

export function addDismissed(planDate: string, id: string): void {
  if (typeof window === "undefined") return;
  const set = new Set(readDismissed(planDate));
  set.add(id);
  try {
    window.localStorage.setItem(KEY(planDate), JSON.stringify([...set]));
  } catch {
    // ignore
  }
}
