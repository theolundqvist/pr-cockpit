import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { createMergeabilityRetry, type MergeabilityFields } from "./mergeabilityRetry.ts";

const unknown: MergeabilityFields = { state: "OPEN", isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
const clean: MergeabilityFields = { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("an UNKNOWN refresh is retried with backoff until GitHub answers", async () => {
  const answers = [unknown, unknown, clean, unknown];
  let retries = 0;
  const observe = createMergeabilityRetry(async (repo, number, source) => {
    retries++;
    observe(repo, number, answers.shift()!, source);
  }, [10, 20, 40, 80]);

  observe("acme/app", 7, unknown, "relay");
  // A refresh during the chain neither starts a second one nor ends it.
  observe("acme/app", 7, unknown, "app detail");
  await advance(9);
  expect(retries).toBe(0);
  await advance(1);
  expect(retries).toBe(1);
  await advance(19);
  expect(retries).toBe(1);
  await advance(1);
  expect(retries).toBe(2);
  await advance(40);
  expect(retries).toBe(3);
  await advance(1_000);
  expect(retries).toBe(3);
});

test("retries stop after the last delay, and a later UNKNOWN refresh starts a new chain", async () => {
  let retries = 0;
  const observe = createMergeabilityRetry(async (repo, number, source) => {
    retries++;
    observe(repo, number, unknown, source);
  }, [5, 5]);

  observe("acme/app", 7, unknown, "relay");
  await advance(5);
  await advance(5);
  await advance(1_000);
  expect(retries).toBe(2);
  observe("acme/app", 7, unknown, "relay");
  await advance(5);
  expect(retries).toBe(3);
});

test("an answer from another refresh cancels the pending retry", async () => {
  let retries = 0;
  const observe = createMergeabilityRetry(async () => { retries++; }, [20]);
  observe("acme/app", 7, unknown, "relay");
  observe("acme/app", 7, clean, "webhook");
  observe("acme/app", 8, { ...unknown, isDraft: true }, "relay");
  await advance(1_000);
  expect(retries).toBe(0);
});
