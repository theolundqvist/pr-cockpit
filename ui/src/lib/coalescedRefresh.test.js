import { expect, test } from "bun:test";
import { coalescedRefresh } from "./coalescedRefresh.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test("serializes refreshes and applies snapshots throughout sustained invalidations", async () => {
  const requests = [];
  const shown = [];
  let active = 0;
  let maxActive = 0;
  const refresh = coalescedRefresh(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    const request = deferred();
    requests.push(request);
    shown.push(await request.promise);
    active--;
  });

  const completion = refresh();
  await flush();
  for (let i = 0; i < 20; i++) expect(refresh()).toBe(completion);
  expect(requests).toHaveLength(1);

  requests[0].resolve("first snapshot");
  await flush();
  expect(shown).toEqual(["first snapshot"]);
  expect(requests).toHaveLength(2);

  for (let i = 0; i < 20; i++) refresh();
  requests[1].resolve("second snapshot");
  await flush();
  expect(shown).toEqual(["first snapshot", "second snapshot"]);
  expect(requests).toHaveLength(3);

  requests[2].resolve("latest snapshot");
  await completion;
  expect(shown).toEqual(["first snapshot", "second snapshot", "latest snapshot"]);
  expect(maxActive).toBe(1);
  expect(requests).toHaveLength(3);
});

test("an idle refresh starts again and a handled failure retains its queued retry", async () => {
  const requests = [];
  const shown = [];
  const errors = [];
  const refresh = coalescedRefresh(async () => {
    const request = deferred();
    requests.push(request);
    try {
      shown.push(await request.promise);
    } catch (error) {
      errors.push(error.message);
    }
  });
  const completion = refresh();
  await flush();
  refresh();
  requests[0].reject(new Error("temporarily unavailable"));
  await flush();
  expect(errors).toEqual(["temporarily unavailable"]);
  expect(requests).toHaveLength(2);
  requests[1].resolve("recovered");
  await completion;

  const next = refresh();
  await flush();
  expect(requests).toHaveLength(3);
  requests[2].resolve("next snapshot");
  await next;
  expect(shown).toEqual(["recovered", "next snapshot"]);
});

test("an unexpected rejection releases the next refresh", async () => {
  let attempts = 0;
  const refresh = coalescedRefresh(async () => {
    if (++attempts === 1) throw new Error("unexpected failure");
    return "recovered";
  });
  await expect(refresh()).rejects.toThrow("unexpected failure");
  await refresh();
  expect(attempts).toBe(2);
});
