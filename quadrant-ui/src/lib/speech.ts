"use client";

// Thin wrappers over the Web Speech APIs so component code stays terse.
// Both APIs are best-effort: speechSynthesis is widely supported, while
// SpeechRecognition is Chrome-only via the webkit prefix on most platforms.

export function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  // Cancel anything currently speaking so we don't queue noise.
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(trimmed);
  u.rate = 1.0;
  u.pitch = 1.05;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

// Minimal type for SpeechRecognition since it isn't in standard lib.d.ts.
type RecognitionResult = {
  results: ArrayLike<{ 0: { transcript: string } }>;
};
export type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: RecognitionResult) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

export function getSpeechRecognition(): SpeechRecognitionInstance | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = false;
  r.interimResults = false;
  r.lang = "en-US";
  return r;
}
