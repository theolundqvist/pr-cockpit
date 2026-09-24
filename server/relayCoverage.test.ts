import { describe, expect, test } from "bun:test";
import { createRelayCoverage } from "./relayCoverage.ts";

describe("relay coverage", () => {
  test("reuses full coverage briefly and rechecks partial coverage every time", async () => {
    let clock = 0;
    const lookups: string[][] = [];
    let covered = false;
    const coverage = createRelayCoverage(async (_url, repos) => {
      lookups.push(repos);
      return Object.fromEntries(repos.map((repo) => [repo, repo === "acme/one" || covered]));
    }, () => clock);

    expect(await coverage(["acme/one", "acme/two"], "https://relay")).toEqual({ "acme/one": true, "acme/two": false });
    expect(await coverage(["acme/one", "acme/two"], "https://relay")).toEqual({ "acme/one": true, "acme/two": false });
    expect(lookups).toHaveLength(2);

    covered = true;
    expect(await coverage(["acme/two", "acme/one"], "https://relay")).toEqual({ "acme/one": true, "acme/two": true });
    clock += 60_000;
    expect(await coverage(["acme/one", "acme/two"], "https://relay")).toEqual({ "acme/one": true, "acme/two": true });
    expect(lookups).toHaveLength(3);

    await coverage(["acme/one"], "https://relay");
    await coverage(["acme/one", "acme/two"], "https://other-relay");
    expect(lookups).toHaveLength(5);

    clock += 5 * 60_000;
    await coverage(["acme/one", "acme/two"], "https://other-relay");
    expect(lookups).toHaveLength(6);
  });
});
