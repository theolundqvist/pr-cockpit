import { expect, test } from "bun:test";
import { cachedActionLog, loadActionLog } from "./actionPrefetch.js";

test("log cache evicts least recently read bodies by bytes, not only job count", async () => {
  const result = { state: "ready", body: "x".repeat(6 * 1024 * 1024) };
  await loadActionLog("budget-a", () => Promise.resolve(result));
  await loadActionLog("budget-b", () => Promise.resolve(result));
  expect(cachedActionLog("budget-a")).toBe(result);
  await loadActionLog("budget-c", () => Promise.resolve(result));
  expect(cachedActionLog("budget-b")).toBeNull();
  expect(cachedActionLog("budget-a")).toBe(result);
  expect(cachedActionLog("budget-c")).toBe(result);
});

test("oversized logs remain readable without displacing reusable logs", async () => {
  const small = { state: "ready", body: "cached" };
  await loadActionLog("small", () => Promise.resolve(small));
  const large = { state: "ready", body: "x".repeat(17 * 1024 * 1024) };
  expect(await loadActionLog("large", () => Promise.resolve(large))).toBe(large);
  expect(cachedActionLog("large")).toBeNull();
  expect(cachedActionLog("small")).toBe(small);
});

test("concurrent log reads still share one request", async () => {
  let calls = 0;
  let finish;
  const loader = () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = loadActionLog("pending", loader);
  const second = loadActionLog("pending", loader);
  expect(calls).toBe(1);
  const result = { state: "not-produced", body: null };
  finish(result);
  expect(await first).toBe(result);
  expect(await second).toBe(result);
});
