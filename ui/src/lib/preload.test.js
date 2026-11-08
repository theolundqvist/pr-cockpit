import { expect, test, spyOn } from "bun:test";
import { preloadPr } from "./preload.js";

test("idle preloads share one wake, bound queued work, and retry expired misses", async () => {
  const originalFetch = globalThis.fetch;
  const originalIdle = globalThis.requestIdleCallback;
  const originalCancel = globalThis.cancelIdleCallback;
  const idles = new Map();
  let id = 0;
  let calls = 0;
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  globalThis.requestIdleCallback = (run) => { idles.set(++id, run); return id; };
  globalThis.cancelIdleCallback = (key) => idles.delete(key);
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  async function drain() {
    while (idles.size) {
      const [key, run] = idles.entries().next().value;
      idles.delete(key);
      run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const pr = (number) => ({ repo: "example/project", number, headSha: `head-${number}` });
  try {
    for (let number = 1; number <= 100; number++) preloadPr(pr(number), { diff: false });
    expect(idles.size).toBe(1);
    await drain();
    expect(calls).toBe(64);
    preloadPr(pr(1), { diff: false });
    await drain();
    expect(calls).toBe(64);
    now += 60_001;
    preloadPr(pr(1), { diff: false });
    await drain();
    expect(calls).toBe(67);
  } finally {
    clock.mockRestore();
    globalThis.fetch = originalFetch;
    globalThis.requestIdleCallback = originalIdle;
    globalThis.cancelIdleCallback = originalCancel;
  }
});
