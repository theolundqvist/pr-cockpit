const WAKE_CHECK_MS = 5_000;
const WAKE_GAP_MS = 30_000;

interface WakeWatchOptions {
  intervalMs?: number;
  gapMs?: number;
  now?: () => number;
}

// A laptop lid close suspends the process without closing anything: timers resume where they
// stopped and remote sockets are silently dead. A wall-clock jump between two short ticks is the
// only signal left, so schedules and connections planned before it must be redone.
export function watchForWake(onWake: (sleptMs: number) => void, options: WakeWatchOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? WAKE_CHECK_MS;
  const gapMs = options.gapMs ?? WAKE_GAP_MS;
  const now = options.now ?? Date.now;
  let lastTickAt = now();
  const timer = setInterval(() => {
    const tickAt = now();
    const sleptMs = tickAt - lastTickAt - intervalMs;
    lastTickAt = tickAt;
    if (sleptMs > gapMs) onWake(sleptMs);
  }, intervalMs);
  return () => clearInterval(timer);
}
