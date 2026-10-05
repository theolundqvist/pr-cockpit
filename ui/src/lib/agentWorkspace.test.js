import { describe, expect, test } from "bun:test";
import {
  agentsHref,
  canonicalAgentsRoute,
  groupSessionEntries,
  isAgentsHash,
  matchSnippet,
  parseAgentsRoute,
  resolveAgentsSelection,
  sessionEntries,
  sessionStatusRow,
  workspaceStatus,
} from "./agentWorkspace.js";

const run = (id, repo, number, fields = {}) => ({
  id,
  repo,
  number,
  kind: "prompt",
  agent_id: "",
  state: "exited",
  started_at: `2026-10-0${id % 9 || 1}T10:00:00.000Z`,
  ended_at: null,
  brief: "",
  exit_reason: null,
  ...fields,
});

const conversations = [
  {
    repo: "acme/storefront",
    number: 482,
    title: "fix(checkout): keep the promo code applied",
    agent: { repo: "acme/storefront", number: 482, state: "running", started_at: "2026-10-05T10:00:00.000Z", exit_reason: null, kind: "fixer", agent_id: "" },
    runs: [
      run(3, "acme/storefront", 482, { state: "running", kind: "fixer", started_at: "2026-10-05T10:00:00.000Z", brief: "auto-merge fixer: merge this approved PR safely" }),
      run(2, "acme/storefront", 482, { state: "died", started_at: "2026-10-04T10:00:00.000Z", brief: "The e2e failure is a race, not a flake: the address form re-prices the cart." }),
    ],
  },
  {
    repo: "acme/billing-api",
    number: 1198,
    title: null,
    agent: null,
    runs: [run(11, "acme/billing-api", 1198, { exit_reason: "green", kind: "autofix", brief: "auto-fix: get this PR green" })],
  },
  {
    repo: "acme/deploy-kit",
    number: 294,
    title: "docs: rollout process",
    agent: { repo: "acme/deploy-kit", number: 294, state: "died", started_at: "2026-09-28T10:00:00.000Z", exit_reason: null, kind: "custom", agent_id: "notes" },
    runs: [],
  },
];

const labelOf = (row) => ({ fixer: "Auto-merge fixer", autofix: "Auto-fix", prompt: "Prompt", custom: "Release notes" })[row.kind];

describe("Agents routes", () => {
  test("only the Agents hash, with or without a query, belongs to the workspace", () => {
    expect(isAgentsHash("#/agents")).toBe(true);
    expect(isAgentsHash("#/agents?repo=a%2Fb&pr=1")).toBe(true);
    expect(isAgentsHash("#/agentsx")).toBe(false);
    expect(isAgentsHash("#/pr/acme/storefront/482/agents")).toBe(false);
    expect(parseAgentsRoute("#/pr/acme/storefront/482/agents")).toBeNull();
  });

  test("links round-trip through URLSearchParams", () => {
    const href = agentsHref("acme/storefront", 482, 3);
    expect(href).toBe("#/agents?repo=acme%2Fstorefront&pr=482&run=3");
    expect(parseAgentsRoute(href)).toEqual({ kind: "session", repo: "acme/storefront", number: 482, runId: 3 });
    expect(parseAgentsRoute(agentsHref("acme/storefront", 482))).toEqual({ kind: "session", repo: "acme/storefront", number: 482, runId: null });
  });

  test("bare links ask for the latest session; malformed ones stay invalid instead of guessing", () => {
    expect(parseAgentsRoute("#/agents")).toEqual({ kind: "latest" });
    expect(parseAgentsRoute("#/agents?")).toEqual({ kind: "latest" });
    for (const hash of [
      "#/agents?repo=acme&pr=1",
      "#/agents?repo=acme%2Fstorefront&pr=abc",
      "#/agents?repo=acme%2Fstorefront&pr=0",
      "#/agents?repo=acme%2Fstorefront",
      "#/agents?pr=482",
      "#/agents?run=3",
      "#/agents?repo=acme%2Fstorefront&pr=482&run=",
      "#/agents?repo=acme%2Fstorefront&pr=482&run=3x",
      "#/agents?repo=acme%2Fstorefront&pr=9007199254740993",
      "#/agents?repo=acme%2Fstorefront&pr=482&run=9007199254740993",
    ]) {
      expect(parseAgentsRoute(hash)).toEqual({ kind: "invalid" });
    }
  });

  test("canonicalization picks the first backend session and its newest run, and leaves explicit runs alone", () => {
    expect(canonicalAgentsRoute({ kind: "latest" }, conversations)).toEqual({ kind: "session", repo: "acme/storefront", number: 482, runId: 3 });
    expect(canonicalAgentsRoute({ kind: "latest" }, [])).toBeNull();
    expect(canonicalAgentsRoute({ kind: "session", repo: "acme/billing-api", number: 1198, runId: null }, conversations)).toEqual({
      kind: "session",
      repo: "acme/billing-api",
      number: 1198,
      runId: 11,
    });
    expect(canonicalAgentsRoute({ kind: "session", repo: "acme/storefront", number: 482, runId: 2 }, conversations)).toBeNull();
    expect(canonicalAgentsRoute({ kind: "session", repo: "acme/deploy-kit", number: 294, runId: null }, conversations)).toBeNull();
    expect(canonicalAgentsRoute({ kind: "session", repo: "acme/nope", number: 1, runId: null }, conversations)).toBeNull();
    expect(canonicalAgentsRoute({ kind: "invalid" }, conversations)).toBeNull();
  });

  test("selection never falls back to another session or run", () => {
    expect(resolveAgentsSelection({ kind: "session", repo: "acme/storefront", number: 482, runId: 2 }, conversations)).toMatchObject({ status: "ready", runId: 2 });
    expect(resolveAgentsSelection({ kind: "session", repo: "acme/nope", number: 9, runId: 3 }, conversations)).toMatchObject({ status: "missing-session", conversation: null });
    expect(resolveAgentsSelection({ kind: "session", repo: "acme/deploy-kit", number: 294, runId: null }, conversations)).toMatchObject({ status: "no-runs" });
    expect(resolveAgentsSelection({ kind: "session", repo: "acme/storefront", number: 482, runId: null }, conversations)).toMatchObject({ status: "choose-run", runId: null });
    expect(resolveAgentsSelection({ kind: "latest" }, conversations)).toMatchObject({ status: "none" });
    expect(resolveAgentsSelection({ kind: "invalid" }, conversations)).toMatchObject({ status: "invalid" });
  });

  test("a run from another session is reported as missing, naming its owner without opening it", () => {
    const selection = resolveAgentsSelection({ kind: "session", repo: "acme/storefront", number: 482, runId: 11 }, conversations);
    expect(selection.status).toBe("missing-run");
    expect(selection.conversation.number).toBe(482);
    expect(selection.owner.number).toBe(1198);
    expect(resolveAgentsSelection({ kind: "session", repo: "acme/storefront", number: 482, runId: 999 }, conversations).owner).toBeNull();
  });
});

describe("workspace status", () => {
  const status = (fields) => {
    const { label, group, reason } = workspaceStatus({ state: "exited", exit_reason: null, ...fields });
    return [label, group, reason];
  };

  test("maps run and agent rows to one human status and sidebar group", () => {
    expect(status({ state: "running" })).toEqual(["Working", "working", null]);
    expect(status({ state: "died" })).toEqual(["Needs attention", "attention", "stopped unexpectedly"]);
    expect(status({ exit_reason: "gave-up" })).toEqual(["Needs attention", "attention", "gave up"]);
    expect(status({ exit_reason: "merge-refused" })).toEqual(["Needs attention", "attention", "merge refused"]);
    expect(status({ exit_reason: "merge-unavailable" })).toEqual(["Needs attention", "attention", "merge unavailable"]);
    expect(status({ state: "killed" })).toEqual(["Stopped", "recent", null]);
    expect(status({ exit_reason: "merged" })).toEqual(["Merged", "recent", null]);
    expect(status({ exit_reason: "green" })).toEqual(["Completed", "recent", "checks green"]);
    expect(status({ exit_reason: "done" })).toEqual(["Completed", "recent", null]);
    expect(status({ exit_reason: "waiting-review" })).toEqual(["Finished", "recent", "waiting on review"]);
    expect(status({ exit_reason: "no-op" })).toEqual(["Finished", "recent", "no changes needed"]);
    expect(status({})).toEqual(["Finished", "recent", null]);
    expect(status({ exit_reason: "toString" })).toEqual(["Finished", "recent", "toString"]);
  });

  test("the newer of the agent row and the newest run decides a session's state", () => {
    expect(sessionStatusRow(conversations[0]).id).toBe(3);
    expect(sessionStatusRow(conversations[2]).state).toBe("died");
    const relaunched = { ...conversations[1], agent: { state: "running", started_at: "2026-10-06T00:00:00.000Z" } };
    expect(sessionStatusRow(relaunched).state).toBe("running");
  });
});

describe("session search and grouping", () => {
  const keys = (query) => sessionEntries(conversations, query, labelOf).map((entry) => entry.key);

  test("matches title, repo#number, agent labels and every run brief, all terms required", () => {
    expect(keys("")).toEqual(["acme/storefront#482", "acme/billing-api#1198", "acme/deploy-kit#294"]);
    expect(keys("PROMO")).toEqual(["acme/storefront#482"]);
    expect(keys("billing-api#1198")).toEqual(["acme/billing-api#1198"]);
    expect(keys("#294")).toEqual(["acme/deploy-kit#294"]);
    expect(keys("release notes")).toEqual(["acme/deploy-kit#294"]);
    expect(keys("auto-fix")).toEqual(["acme/billing-api#1198"]);
    expect(keys("race flake")).toEqual(["acme/storefront#482"]);
    expect(keys("race billing")).toEqual([]);
  });

  test("a term found only in a brief shows that brief's excerpt", () => {
    const [entry] = sessionEntries(conversations, "race", labelOf);
    expect(entry.snippet).toBe("The e2e failure is a race, not a flake: the address form re-prices the cart.");
    expect(sessionEntries(conversations, "promo", labelOf)[0].snippet).toBeNull();
    expect(matchSnippet(`${"x".repeat(40)} needle ${"y".repeat(200)}`, "needle")).toMatch(/^…x+ needle y+…$/);
    expect(matchSnippet("no match here", "needle")).toBeNull();
  });

  test("groups come from row status in Working, Needs attention, Recent order and keep backend order", () => {
    const groups = groupSessionEntries(sessionEntries(conversations, "", labelOf));
    expect(groups.map((group) => [group.label, group.entries.map((entry) => entry.key)])).toEqual([
      ["Working", ["acme/storefront#482"]],
      ["Needs attention", ["acme/deploy-kit#294"]],
      ["Recent", ["acme/billing-api#1198"]],
    ]);
    expect(groupSessionEntries(sessionEntries(conversations, "promo", labelOf)).map((group) => group.id)).toEqual(["working"]);
  });
});
