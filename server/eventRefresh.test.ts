import { expect, mock, test } from "bun:test";
import { createEventRefreshThrottle } from "./eventRefresh.ts";
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
