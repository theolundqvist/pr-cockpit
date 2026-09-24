import { expect, test } from "bun:test";
import { watchForWake } from "./wake.ts";

test("a wall-clock jump between ticks reports a wake; ordinary ticks do not", async () => {
  let clock = 0;
  const wakes: number[] = [];
  const stop = watchForWake((sleptMs) => wakes.push(sleptMs), { intervalMs: 5, gapMs: 1_000, now: () => clock });
  try {
    clock += 5;
    await Bun.sleep(15);
    expect(wakes).toEqual([]);
    clock += 60_000;
    await Bun.sleep(15);
    expect(wakes.length).toBe(1);
    expect(wakes[0]!).toBeGreaterThan(50_000);
    await Bun.sleep(15);
    expect(wakes.length).toBe(1);
  } finally {
    stop();
  }
});
