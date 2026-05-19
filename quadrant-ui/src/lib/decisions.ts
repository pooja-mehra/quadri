"use client";

// Shared client-side helpers for action / goal mutations. Each helper posts
// to its API route, surfaces a toast on success or error, and returns true
// on success so callers can decide whether to refresh state.

import { toast } from "sonner";
import { addDismissed } from "./dismissed-actions";
import { todayLocalISO } from "./date";

async function postDecision(
  url: string,
  body: object,
  successMsg: string,
): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${r.status}`);
    }
    toast.success(successMsg);
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed");
    return false;
  }
}

export async function decideAction(
  id: string,
  decision: "approve" | "reject",
): Promise<boolean> {
  const ok = await postDecision(
    `/api/actions/${id}/decide`,
    { decision },
    decision === "approve" ? "Approved" : "Rejected",
  );
  if (ok && decision === "reject") {
    // Mirror the rejection client-side so today panel + time bar drop the
    // item immediately, even before /api/state refreshes.
    addDismissed(todayLocalISO(), id);
  }
  return ok;
}

export async function markSent(id: string): Promise<boolean> {
  return postDecision(
    `/api/actions/${id}/send`,
    {},
    "Done — follow-through credit added",
  );
}

export async function uncommit(id: string): Promise<boolean> {
  return postDecision(
    `/api/actions/${id}/uncommit`,
    {},
    "Moved back to pending",
  );
}

export async function decideGoal(
  id: string,
  decision: "approve" | "reject",
): Promise<boolean> {
  return postDecision(
    `/api/goals/${id}/decide`,
    { decision },
    decision === "approve" ? "Goal activated" : "Goal archived",
  );
}
