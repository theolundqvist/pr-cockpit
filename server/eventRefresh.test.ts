import { expect, mock, test } from "bun:test";
import { createEventRefreshThrottle, createPollRequester } from "./eventRefresh.ts";
import type { PrDetailScope } from "./github.ts";

test("coalesces repeated event refreshes for one PR", async () => {
  const schedule = createEventRefreshThrottle(20);
  const refresh = mock(async (_repo: string, _number: number, _scope: PrDetailScope) => {});

  await schedule("acme/app", 7, "checks", refresh);
  const second = schedule("acme/app", 7, "checks", refresh);
  const third = schedule("acme/app", 7, "review", refresh);

  expect(refresh).toHaveBeenCalledTimes(1);
  await Promise.all([second, third]);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(refresh.mock.calls.map((call) => call[2])).toEqual(["checks", "all"]);
});

test("does not throttle different PRs together", async () => {
  const schedule = createEventRefreshThrottle(20);
  const refresh = mock(async () => {});

  await Promise.all([
    schedule("acme/app", 7, "checks", refresh),
    schedule("acme/app", 8, "review", refresh),
  ]);

  expect(refresh).toHaveBeenCalledTimes(2);
});

test("a poll request inside the debounce window runs once at its end instead of being dropped", async () => {
  const polls: number[] = [];
  const started = Date.now();
  const request = createPollRequester(async () => {
    polls.push(Date.now() - started);
  }, 40, (error) => { throw error; });

  request();
  request();
  request();
  expect(polls.length).toBe(1);
  await Bun.sleep(80);
  expect(polls.length).toBe(2);
  expect(polls[1]!).toBeGreaterThanOrEqual(35);
});

test("a poll request during a running poll earns one trailing poll", async () => {
  const release = Promise.withResolvers<void>();
  let polls = 0;
  const request = createPollRequester(async () => {
    polls++;
    if (polls === 1) await release.promise;
  }, 0, (error) => { throw error; });

  request();
  request();
  request();
  expect(polls).toBe(1);
  release.resolve();
  await Bun.sleep(10);
  expect(polls).toBe(2);
});
