"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { QuadrantScore } from "@/lib/types";

const QUADRANTS = ["health", "education", "career", "relationships"] as const;
type Q = (typeof QUADRANTS)[number];
type Weights = Record<Q, number>;

const LABELS: Record<Q, string> = {
  health: "Health",
  education: "Education",
  career: "Career",
  relationships: "Relationships",
};

const DEFAULTS: Weights = {
  health: 0.25,
  education: 0.25,
  career: 0.25,
  relationships: 0.25,
};

const MIN = 0.1;
const MAX = 0.5;
const SUM_TOLERANCE = 0.01;

export function WeightsModal({
  scores,
  onSaved,
}: {
  scores: QuadrantScore[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const initial = useMemo<Weights>(() => {
    const w: Weights = { ...DEFAULTS };
    for (const s of scores) w[s.quadrant] = s.user_weight;
    return w;
  }, [scores]);

  const [weights, setWeights] = useState<Weights>(initial);

  // Resync when the modal is opened.
  useEffect(() => {
    if (open) setWeights(initial);
  }, [open, initial]);

  const total = QUADRANTS.reduce((s, q) => s + weights[q], 0);
  const totalOk = Math.abs(total - 1.0) <= SUM_TOLERANCE;
  const allInRange = QUADRANTS.every((q) => weights[q] >= MIN && weights[q] <= MAX);
  const valid = totalOk && allInRange;

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/weights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(weights),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      toast.success("Impact saved");
      onSaved();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-[0.8rem] font-medium text-foreground transition-colors hover:bg-muted"
      >
        Priorities
      </button>
      {open ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set your priorities</DialogTitle>
          <DialogDescription>
            How much each area matters in your life. Each priority between{" "}
            {Math.round(MIN * 100)}% and {Math.round(MAX * 100)}%; total must equal 100%.
            Quadri uses these to prioritize what to surface during a rebalance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {QUADRANTS.map((q) => (
            <WeightSlider
              key={q}
              label={LABELS[q]}
              value={weights[q]}
              onChange={(v) =>
                setWeights((w) => ({ ...w, [q]: round2(v) }))
              }
            />
          ))}
          <div
            className={cn(
              "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
              totalOk
                ? "border-emerald-200 bg-emerald-50/60"
                : "border-rose-200 bg-rose-50/60",
            )}
          >
            <span className="text-muted-foreground">Total</span>
            <span
              className={cn(
                "font-medium tabular-nums",
                totalOk ? "text-emerald-700" : "text-rose-700",
              )}
            >
              {Math.round(total * 100)}% / 100%
            </span>
          </div>
          {!allInRange ? (
            <p className="text-xs text-rose-700">
              Each priority must be between {Math.round(MIN * 100)}% and {Math.round(MAX * 100)}%.
            </p>
          ) : null}
        </div>
        <DialogFooter className="flex !justify-between gap-2">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setWeights(DEFAULTS)}
            disabled={saving}
          >
            Reset to defaults
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button disabled={!valid || saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
        </DialogContent>
      </Dialog>
      ) : null}
    </>
  );
}

function WeightSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{label}</Label>
        <span className="text-sm font-medium tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <Slider
        value={value}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
        min={MIN}
        max={MAX}
        step={0.01}
      />
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
