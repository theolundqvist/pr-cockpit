import { expect, mock, test } from "bun:test";
import { createEventRefreshThrottle } from "./eventRefresh.ts";

test("coalesces repeated event refreshes for one PR", async () => {
  const schedule = createEventRefreshThrottle(20);
  const refresh = mock(async () => {});

  await schedule("acme/app", 7, refresh);
  const second = schedule("acme/app", 7, refresh);
  const third = schedule("acme/app", 7, refresh);

  expect(refresh).toHaveBeenCalledTimes(1);
  await Promise.all([second, third]);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("does not throttle different PRs together", async () => {
  const schedule = createEventRefreshThrottle(20);
  const refresh = mock(async () => {});

  await Promise.all([
    schedule("acme/app", 7, refresh),
    schedule("acme/app", 8, refresh),
  ]);

  expect(refresh).toHaveBeenCalledTimes(2);
});
