import { expect, test } from "bun:test";

// The child installs its GraphQL transport before loading the module and keeps the global fetch override isolated.
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
// db.ts must initialize before github.ts: github -> settings -> db -> github (SCHEMA_EPOCH) is
// cycle-safe only when db.ts is not entered mid-way through github.ts evaluation.
const dbModuleUrl = new URL("./db.ts", import.meta.url).href;

test("queries the requested base and paginates to the 180-day cutoff", async () => {
  const script = `
    const calls = [];
    const now = Date.now();
    const mergedAt = (daysAgo) => new Date(now - daysAgo * 24 * 60 * 60_000).toISOString();
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const page = request.variables.cursor;
      const pullRequests = page === "page-3" ? {
        nodes: [
          { number: 1, title: "Outside capped window", url: "https://github.com/acme/widgets/pull/1", mergedAt: mergedAt(181), updatedAt: mergedAt(181), author: null },
        ],
        pageInfo: { hasNextPage: true, endCursor: "unused" },
      } : page === "page-2" ? {
        nodes: [
          { number: 2, title: "Inside capped window", url: "https://github.com/acme/widgets/pull/2", mergedAt: mergedAt(179), updatedAt: mergedAt(179), author: { login: "hubot" } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "page-3" },
      } : {
        nodes: [
          { number: 3, title: "Recent merge", url: "https://github.com/acme/widgets/pull/3", mergedAt: mergedAt(1), updatedAt: mergedAt(1), author: { login: "octocat" } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "page-2" },
      };
      return Response.json({
        data: {
          repository: { pullRequests },
        },
      });
    };
    await import(${JSON.stringify(dbModuleUrl)});
    const { fetchMergedPrAnalytics } = await import(${JSON.stringify(githubModuleUrl)});
    const first = await fetchMergedPrAnalytics("acme/widgets", "release/v2");
    console.log(JSON.stringify({ calls, first }));
  `;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_GH_BIN: "/bin/echo", COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);

  const result = JSON.parse(stdout) as {
    calls: Array<{ query: string; variables: Record<string, unknown> }>;
    first: {
      repo: string;
      base: string;
      asOf: string;
      pullRequests: Array<{ number: number; title: string; url: string; author: string; mergedAt: string }>;
    };
  };
  expect(result.calls).toHaveLength(3);
  expect(result.calls[0]!.query).toContain("baseRefName: $base");
  expect(result.calls.map((call) => call.variables)).toEqual([
    { owner: "acme", name: "widgets", base: "release/v2", cursor: null },
    { owner: "acme", name: "widgets", base: "release/v2", cursor: "page-2" },
    { owner: "acme", name: "widgets", base: "release/v2", cursor: "page-3" },
  ]);
  expect(result.first).toMatchObject({
    repo: "acme/widgets",
    base: "release/v2",
    pullRequests: [
      { number: 3, title: "Recent merge", url: "https://github.com/acme/widgets/pull/3", author: "octocat" },
      { number: 2, title: "Inside capped window", url: "https://github.com/acme/widgets/pull/2", author: "hubot" },
    ],
  });
  expect(new Date(result.first.asOf).toString()).not.toBe("Invalid Date");
});

test("returns deterministic merged pull requests without live GitHub in mock mode", async () => {
  const script = `
    await import(${JSON.stringify(dbModuleUrl)});
    const { fetchMergedPrAnalytics } = await import(${JSON.stringify(githubModuleUrl)});
    const main = await fetchMergedPrAnalytics("fixture/cockpit", "main");
    const other = await fetchMergedPrAnalytics("fixture/cockpit", "release");
    console.log(JSON.stringify({ main, other }));
  `;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  expect(await process.exited, stderr).toBe(0);

  const result = JSON.parse(stdout);
  expect(result.main).toEqual({
    repo: "fixture/cockpit",
    base: "main",
    asOf: "2026-07-15T10:00:00.000Z",
    pullRequests: [{
      number: 106,
      title: "Retire the legacy polling path after webhook rollout",
      url: "https://github.com/fixture/cockpit/pull/106",
      author: "theolundqvist",
      mergedAt: "2026-07-15T08:30:00.000Z",
    }],
  });
  expect(result.other).toEqual({
    repo: "fixture/cockpit",
    base: "release",
    asOf: "2026-07-15T10:00:00.000Z",
    pullRequests: [],
  });
});
