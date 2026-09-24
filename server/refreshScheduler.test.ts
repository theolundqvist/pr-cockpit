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

test("a trailing refresh starts once the detail is stored, not after the Actions catalog", async () => {
  const catalog = Promise.withResolvers<void>();
  const detail = Promise.withResolvers<void>();
  const events: string[] = [];
  let calls = 0;
  const refresh = createPrRefreshScheduler(async () => {
    const call = ++calls;
    events.push(`detail ${call}`);
    if (call === 1) await detail.promise;
    return { followUp: call === 1 ? catalog.promise.then(() => { events.push("catalog 1"); }) : Promise.resolve() };
  });

  let settled = false;
  const first = refresh("org/repo", 42).then(() => { settled = true; });
  refresh("org/repo", 42, "relay", "checks");
  detail.resolve();
  while (calls < 2) await Bun.sleep(1);
  expect(events).toEqual(["detail 1", "detail 2"]);
  // A signal after the detail phases starts its own refresh instead of joining the catalog wait.
  await Bun.sleep(1);
  expect(settled).toBe(false);
  await refresh("org/repo", 42);
  expect(calls).toBe(3);
  catalog.resolve();
  await first;
  expect(events).toEqual(["detail 1", "detail 2", "detail 3", "catalog 1"]);
});

test("attributes a trailing refresh to the latest trigger", async () => {
  const gate = Promise.withResolvers<void>();
  const sources: string[] = [];
  const refresh = createPrRefreshScheduler(async (_repo, _number, source) => {
    sources.push(source ?? "");
    if (sources.length === 1) await gate.promise;
  });

  const first = refresh("org/repo", 42, "background poll");
  const trailing = refresh("org/repo", 42, "relay");
  gate.resolve();
  await Promise.all([first, trailing]);

  expect(sources).toEqual(["background poll", "relay"]);
});

test("combines different trailing scopes into one full refresh", async () => {
  const gate = Promise.withResolvers<void>();
  const scopes: string[] = [];
  const refresh = createPrRefreshScheduler(async (_repo, _number, _source, scope) => {
    scopes.push(scope ?? "");
    if (scopes.length === 1) await gate.promise;
  });

  const first = refresh("org/repo", 42, "background poll", "checks");
  refresh("org/repo", 42, "relay", "review");
  refresh("org/repo", 42, "webhook", "checks");
  gate.resolve();
  await first;

  expect(scopes).toEqual(["checks", "all"]);
});
