import { expect, test } from "bun:test";
import { createPrRefreshScheduler } from "./refreshScheduler.ts";

test("serializes each PR and coalesces overlapping signals", async () => {
  let releaseFirst = () => {};
  const firstRefresh = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: number[] = [];
  const refresh = createPrRefreshScheduler(async (_repo, number) => {
    calls.push(number);
    if (calls.length === 1) await firstRefresh;
  });

  const scheduled = refresh("example-org/webapp", 6059);
  expect(refresh("example-org/webapp", 6059)).toBe(scheduled);
  expect(refresh("example-org/webapp", 6059)).toBe(scheduled);
  expect(calls).toEqual([6059]);

  releaseFirst();
  await scheduled;
  expect(calls).toEqual([6059, 6059]);
});
