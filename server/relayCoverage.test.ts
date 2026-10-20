import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RelayAnchors, type AnchorGithub, type RelaySettings } from "./relayAnchors.ts";
import { createRelayCoverage, createRelayCoverageLookup } from "./relayCoverage.ts";

const APP_PUSH = "a".repeat(40);
const TOOLS_PUSH = "c".repeat(40);
const anchorIdOf = (repo: string, repoId: number, after: string) =>
  createHash("sha256").update(`pr-cockpit-relay anchor\n${repo}\n${repoId}\n${after}`).digest("hex");

function relayFixture(capabilities: Record<string, unknown>) {
  const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const githubCalls: string[] = [];
  let tokenRequests = 0;
  const stored = new Map<string, string>();
  const settings: RelaySettings = { get: (key) => stored.get(key) ?? null, set: (key, value) => void stored.set(key, value) };
  const github: AnchorGithub = {
    repository: async (repo) => ({ id: repo === "acme/app" ? 101 : 202, defaultBranch: "main" }),
    activity: async (repo) => {
      githubCalls.push(`activity ${repo}`);
      return [{ after: repo === "acme/app" ? APP_PUSH : TOOLS_PUSH, activity_type: "push" }];
    },
    tree: async (repo) => {
      githubCalls.push(`tree ${repo}`);
      return "e".repeat(40);
    },
  };
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url: url.host + url.pathname, authorization: new Headers(init.headers).get("authorization"), body });
    if (url.pathname === "/capabilities") {
      const answer = capabilities[url.host];
      return answer === undefined ? new Response("", { status: 404 }) : Response.json(answer);
    }
    if (url.pathname === "/anchors") return Response.json({ repos: { "acme/app": anchorIdOf("acme/app", 101, APP_PUSH), "acme/tools": null } });
    return Response.json({ repos: { "acme/app": true } });
  };
  let clock = 0;
  const lookup = () => createRelayCoverageLookup({
    fetcher: fetcher as typeof fetch,
    token: async () => {
      tokenRequests++;
      return "github-secret";
    },
    anchors: new RelayAnchors({ fetcher: fetcher as typeof fetch, github, now: () => clock }),
    settings,
  });
  return { requests, githubCalls, lookup, tokenRequests: () => tokenRequests, advance: (ms: number) => { clock += ms; } };
}

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

describe("anchor relay coverage", () => {
  test("matches anchors without the token or a commit read, and reuses activity for ten minutes", async () => {
    const relay = relayFixture({ "relay.test": { stream: "websocket-v1", anchors: "v1" } });
    const lookup = relay.lookup();

    expect(await lookup("https://relay.test", ["acme/app", "acme/tools"])).toEqual({ "acme/app": true, "acme/tools": false });
    relay.advance(5 * 60_000);
    expect(await lookup("https://relay.test", ["acme/app", "acme/tools"])).toEqual({ "acme/app": true, "acme/tools": false });
    relay.advance(5 * 60_000);
    await lookup("https://relay.test", ["acme/app", "acme/tools"]);

    expect(relay.tokenRequests()).toBe(0);
    expect(relay.requests.every((request) => request.authorization === null)).toBe(true);
    expect(relay.requests.map((request) => request.url)).toEqual([
      "relay.test/capabilities",
      "relay.test/anchors",
      "relay.test/anchors",
      "relay.test/anchors",
    ]);
    expect(relay.requests[1]!.body).toEqual({ repos: {
      "acme/app": [anchorIdOf("acme/app", 101, APP_PUSH)],
      "acme/tools": [anchorIdOf("acme/tools", 202, TOOLS_PUSH)],
    } });
    expect(relay.githubCalls).toEqual(["activity acme/app", "activity acme/tools", "activity acme/app", "activity acme/tools"]);
  });

  test("a relay that once offered anchors never gets the token for coverage; others still do", async () => {
    const capabilities: Record<string, unknown> = { "relay.test": { stream: "websocket-v1", anchors: "v1" }, "self.test": { stream: "websocket-v1" } };
    const relay = relayFixture(capabilities);
    await relay.lookup()("https://relay.test", ["acme/app"]);

    capabilities["relay.test"] = { stream: "websocket-v1" };
    await expect(relay.lookup()("https://relay.test", ["acme/app"])).rejects.toThrow("relay no longer advertises token-free access");
    delete capabilities["relay.test"];
    await expect(relay.lookup()("https://relay.test", ["acme/app"])).rejects.toThrow("relay capabilities responded 404");
    await expect(relay.lookup()("https://relay.prcockpit.com", ["acme/app"])).rejects.toThrow("relay capabilities responded 404");
    expect(relay.tokenRequests()).toBe(0);

    expect(await relay.lookup()("https://self.test", ["acme/app"])).toEqual({ "acme/app": true });
    expect(relay.tokenRequests()).toBe(1);
    expect(relay.requests.filter((request) => request.authorization !== null).map((request) => request.url)).toEqual(["self.test/coverage"]);
  });
});

test("anchor ids and proofs match the vector the relay asserts", async () => {
  const sent: unknown[] = [];
  const anchorId = "3d248f6cb2f988aa39149cce10010a3c6b1fb83ce29332490104b3ea95cc1b01";
  const anchors = new RelayAnchors({
    github: {
      repository: async () => ({ id: 42, defaultBranch: "main" }),
      activity: async () => [{ after: "a".repeat(40), activity_type: "push" }],
      tree: async () => "b".repeat(40),
    },
    fetcher: (async (_input: string | URL | Request, init: RequestInit = {}) => {
      sent.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
      return Response.json({ repos: { "Acme/App": anchorId } });
    }) as typeof fetch,
  });

  expect(await anchors.proofs("https://relay.test", ["Acme/App"])).toEqual({
    "Acme/App": "e1acac39635db6c6e8bda37aaea97b6ab30916391393d0524ff73c6a413074c1",
  });
  expect(sent).toEqual([{ repos: { "Acme/App": [anchorId] } }]);
});
