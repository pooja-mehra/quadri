"use client";

import { cn } from "@/lib/utils";

// Gradient "Q" badge. Visual identity for Quadri across the app — header,
// chat dock, anywhere the agent is speaking. Pure CSS, no asset.
export function QuadriAvatar({
  size = 24,
  className,
  pulsing = false,
}: {
  size?: number;
  className?: string;
  pulsing?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 via-violet-500 to-rose-400 font-bold text-white shadow-sm ring-1 ring-white/40",
        pulsing && "animate-pulse",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}
      aria-label="Quadri"
    >
      Q
    </span>
  );
}
