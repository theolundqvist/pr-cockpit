import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubAppReadHealth, GithubCredentialQuota, GithubQuota, GithubQuotaResource } from "./github.ts";
import type { GithubGraphqlUsageEvent, GithubRestUsageEvent } from "./githubUsage.ts";

type Call = { path: string; token: string; method: string; etag?: string | null; query?: string | null };
type Report = GithubQuota & { identities: GithubCredentialQuota[] };
type Outcome = { status?: number; kind?: string; credential?: string; message?: string };

const githubUrl = new URL("./github.ts", import.meta.url).href;
const settingsUrl = new URL("./settings.ts", import.meta.url).href;
const usageUrl = new URL("./githubUsage.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;
const appUrl = new URL("./githubApp.ts", import.meta.url).href;
const setupUrl = new URL("./githubAppSetup.ts", import.meta.url).href;

// Imports inside the subprocess must follow transport isolation and settings initialization.
// Each caller types the JSON emitted by its own controlled fixture script.
async function scenario<T>(code: string, enabled = true): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-dual-quota-"));
  const configPath = join(directory, "app.json");
  const tokenPath = join(directory, "user-token");
  const gh = join(directory, "gh");
  writeFileSync(tokenPath, "personal-one\n");
  writeFileSync(gh, '#!/bin/sh\ncat "$COCKPIT_TEST_TOKEN_FILE"\n');
  chmodSync(gh, 0o755);
  if (enabled) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPath = join(directory, "private.pem");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({ appId: "123", privateKeyPath }), { mode: 0o600 });
  }
  const script = `
    import { unlinkSync } from "node:fs";
    const calls = [];
    const issuances = new Map();
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const headers = (resource = "core", used = 10, limit = 5000, resetAt = reset) => ({
      "x-ratelimit-resource": resource, "x-ratelimit-limit": String(limit),
      "x-ratelimit-used": String(used), "x-ratelimit-remaining": String(limit - used),
      "x-ratelimit-reset": String(resetAt),
    });
    const json = (value, resource = "core", used = 10, limit = 5000, resetAt = reset) =>
      Response.json(value, { headers: headers(resource, used, limit, resetAt) });
    const rateData = (used = 0, limit = 5000) => ({ resources: {
      core: { used, limit, remaining: limit - used, reset },
      graphql: { used: 0, limit: 5000, remaining: 5000, reset },
      search: { used: 0, limit: 30, remaining: 30, reset },
    } });
    const graphqlData = (repository, used = 10, limit = 5000) => json({ data: {
      repository,
      __prCockpitRateLimit: { cost: 1, used, remaining: limit - used, resetAt: new Date(reset * 1000).toISOString() },
    } }, "graphql", used, limit);
    const openPrs = { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    let respond = async () => { throw new Error("No scenario responder"); };
    let installationFailure = null;
    let issuanceFailure = null;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/github-app/quota") return setup.handleGithubAppSetup(request);
      const token = (request.headers.get("authorization") ?? "").replace(/^bearer /i, "");
      if (url.pathname.endsWith("/installation")) {
        calls.push({ path: url.pathname, token: "jwt", method: request.method });
        if (installationFailure) return installationFailure();
        if (url.pathname.includes("/outside/")) return new Response(null, { status: 404 });
        return Response.json({ id: url.pathname.includes("/two/") ? 42 : 41 });
      }
      const issuance = /^\\/app\\/installations\\/(\\d+)\\/access_tokens$/.exec(url.pathname);
      if (issuance) {
        const id = Number(issuance[1]);
        const count = (issuances.get(id) ?? 0) + 1;
        issuances.set(id, count);
        if (issuanceFailure) return issuanceFailure();
        return Response.json({ token: "app-" + id + "-" + count,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { contents: "read", pull_requests: "read", issues: "read", actions: "read", checks: "read" },
        });
      }
      const body = request.method === "POST" && request.headers.get("content-type")?.includes("json")
        ? await request.json() : null;
      calls.push({ path: url.pathname, token, method: request.method, etag: request.headers.get("if-none-match"), query: body?.query ?? null });
      return respond(request, token, url, body);
    } });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected external request: " + url.origin);
      return nativeFetch("http://127.0.0.1:" + server.port + url.pathname + url.search, options);
    };
    const settings = await import(${JSON.stringify(settingsUrl)});
    settings.writeSettings({ rest_usage_enabled: true, rest_fallback_enabled: false });
    const github = await import(${JSON.stringify(githubUrl)});
    const usage = await import(${JSON.stringify(usageUrl)});
    const setup = await import(${JSON.stringify(setupUrl)});
    const appStatus = async () => {
      const response = await nativeFetch(new URL("/api/github-app/quota", server.url));
      if (!response.ok) throw new Error("App status failed: " + response.status);
      return response.json();
    };
    const restEvents = [];
    const graphqlEvents = [];
    usage.setGithubRestUsageRecorder((event) => restEvents.push(event));
    usage.setGithubGraphqlUsageRecorder((event) => graphqlEvents.push(event));
    const capture = async (work) => {
      try { return { value: await work() }; }
      catch (error) { return { status: error.status, kind: error.kind, credential: error.credential, message: error.message }; }
    };
    try {
      ${code}
    } finally {
      server.stop(true);
      (await import(${JSON.stringify(dbUrl)})).db.close();
    }
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: {
        ...Bun.env, COCKPIT_DATA_DIR: directory, COCKPIT_GITHUB_APP_CONFIG: configPath,
        COCKPIT_GH_BIN: gh, COCKPIT_TEST_TOKEN_FILE: tokenPath, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("repository reads use independent installations while writes, viewer, permissions, and pending reviews remain personal", async () => {
  const result = await scenario<{ calls: Call[]; quota: Report; restEvents: GithubRestUsageEvent[]; graphqlEvents: GithubGraphqlUsageEvent[]; issuances: [number, number][] }>(`
    const actionsBoth = Promise.withResolvers();
    let actionsStarted = 0;
    respond = async (request, token, url, body) => {
      const app = token.startsWith("app-");
      const second = token.startsWith("app-42-");
      const used = app ? second ? 22 : 11 : 33;
      const limit = app ? second ? 7000 : 9000 : 5000;
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname === "/user") return json({ login: "viewer", id: 1 }, "core", used, limit);
      if (url.pathname === "/graphql") {
        if (body.query.includes("mutation")) return json({ data: { resolveReviewThread: { thread: { id: "T", isResolved: true } } } }, "graphql", 3);
        return graphqlData(openPrs, 44, 9000);
      }
      if (request.method === "POST") return json({ node_id: "comment-id" }, "core", used, limit);
      if (url.pathname.endsWith("/pulls/1")) return json({ state: "open", head: { repo: { full_name: "acme/one", permissions: { push: false } } }, base: { repo: { full_name: "acme/one" } } }, "core", used, limit);
      if (url.pathname.includes("/actions/")) {
        if (++actionsStarted === 2) actionsBoth.resolve();
        await actionsBoth.promise;
        return json({ workflows: [] }, "core", used, limit);
      }
      return json([], "core", used, limit);
    };
    await Promise.all([
      github.fetchActionWorkflows("acme/one"), github.fetchActionWorkflows("acme/two"),
      github.fetchRepositoryOpenPrs("acme/one"), github.getViewerLogin(),
      github.postIssueComment("acme/one", 1, "hello"), github.resolveReviewThread("T"),
      github.prHeadPushAccess("acme/one", 1), github.fetchPendingReview("acme/one", 1),
      github.fetchPrCommentsSince("acme/one", 1, "2026-01-01T00:00:00Z"),
    ]);
    const quota = await github.fetchGithubQuota();
    console.log(JSON.stringify({ calls, quota, restEvents, graphqlEvents, issuances: [...issuances] }));
  `);
  const dataCalls = result.calls.filter((call) => call.token !== "jwt");
  expect(dataCalls.filter((call) => call.path.includes("/actions/")).map((call) => call.token).sort()).toEqual(["app-41-1", "app-42-1"]);
  expect(dataCalls.filter((call) => call.method !== "GET" && !call.query?.trim().startsWith("query")).every((call) => call.token === "personal-one")).toBe(true);
  expect(dataCalls.find((call) => call.path === "/user")?.token).toBe("personal-one");
  expect(dataCalls.find((call) => call.path.endsWith("/pulls/1"))?.token).toBe("personal-one");
  expect(dataCalls.filter((call) => call.path.endsWith("/pulls/1/reviews")).map((call) => call.token).sort()).toEqual(["app-41-1", "personal-one"]);
  expect(dataCalls.find((call) => call.path.endsWith("/issues/1/comments") && call.method === "GET")?.token).toBe("app-41-1");
  expect(result.quota.rest.used).toBe(33);
  expect(result.quota.identities.find((item) => item.installationId === 41)).toMatchObject({ rest: { used: 11, limit: 9000 }, graphql: { used: 44, limit: 9000 }, repositories: ["acme/one"] });
  expect(result.quota.identities.find((item) => item.installationId === 42)).toMatchObject({ rest: { used: 22, limit: 7000 }, graphql: null, repositories: ["acme/two"] });
  expect(result.restEvents.filter((event) => event.credentialKind === "app").every((event) => event.credential?.startsWith("app:123:installation:"))).toBe(true);
  expect(result.graphqlEvents.find((event) => event.operation === "all PRs")?.credential).toBe("app:123:installation:41");
  expect(result.graphqlEvents.find((event) => event.operation === "resolve review thread")?.credential).toBe(result.quota.identity);
  expect(result.issuances.sort()).toEqual([[41, 1], [42, 1]]);
});

test("app primary exhaustion falls back once and user exhaustion cannot suppress another installation", async () => {
  const result = await scenario<{ calls: Call[]; quota: Report; write: Outcome; available: GithubQuotaResource }>(`
    let userExhausted = false;
    respond = async (request, token, url) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (token === "app-41-1" || (token === "personal-one" && userExhausted)) {
        return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: headers("core", 5000) });
      }
      return json({ workflows: [], node_id: "comment-id" }, "core", token.startsWith("app-42-") ? 7 : 20);
    };
    await github.fetchActionWorkflows("acme/one");
    await github.fetchActionWorkflows("acme/one");
    userExhausted = true;
    const write = await capture(() => github.postIssueComment("acme/one", 1, "hello"));
    await github.fetchActionWorkflows("acme/two");
    const available = await github.repositoryReadQuota("acme/two", "core");
    const quota = await github.fetchGithubQuota();
    console.log(JSON.stringify({ calls, write, available, quota }));
  `);
  expect(result.calls.filter((call) => call.token === "app-41-1")).toHaveLength(1);
  expect(result.calls.filter((call) => call.path === "/repos/acme/one/actions/workflows" && call.token === "personal-one")).toHaveLength(2);
  expect(result.write).toMatchObject({ status: 403, kind: "quota" });
  expect(result.available.remaining).toBe(4993);
  expect(result.quota.rest.remaining).toBe(0);
  expect(result.quota.identities.find((item) => item.installationId === 41)?.rest?.remaining).toBe(0);
});

test("secondary throttling blocks all identities and APIs without a fallback or token refresh", async () => {
  const result = await scenario<{ first: Outcome; second: Outcome; write: Outcome; count: number; finalCount: number; issuances: [number, number][] }>(`
    respond = async () => Response.json({ message: "secondary rate limit" }, {
      status: 403, headers: { ...headers("core", 20), "retry-after": "120" },
    });
    const first = await capture(() => github.fetchActionWorkflows("acme/one"));
    const count = calls.length;
    const second = await capture(() => github.fetchActionWorkflows("acme/two"));
    const write = await capture(() => github.resolveReviewThread("T"));
    console.log(JSON.stringify({ first, second, write, count, finalCount: calls.length, issuances: [...issuances] }));
  `);
  expect(result.first).toMatchObject({ status: 403, kind: "quota" });
  expect(result.second).toMatchObject({ status: 403, kind: "quota" });
  expect(result.write).toMatchObject({ status: 403, kind: "quota" });
  expect(result.finalCount).toBe(result.count);
  expect(result.issuances).toEqual([[41, 1]]);
});

test("expired app tokens refresh single-flight without resetting the installation's other budget", async () => {
  const result = await scenario<{ calls: Call[]; quota: Report; issuances: [number, number][] }>(`
    const rejectedBoth = Promise.withResolvers();
    let rejected = 0;
    respond = async (request, token, url, body) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname === "/graphql") return graphqlData(openPrs, 123, 9000);
      if (token === "app-41-1") {
        if (++rejected === 2) rejectedBoth.resolve();
        await rejectedBoth.promise;
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return json({ workflows: [] }, "core", 77, 9000);
    };
    await github.fetchRepositoryOpenPrs("acme/one");
    await Promise.all([github.fetchActionWorkflows("acme/one"), github.fetchActionWorkflows("acme/one")]);
    console.log(JSON.stringify({ calls, quota: await github.fetchGithubQuota(), issuances: [...issuances] }));
  `);
  expect(result.issuances).toEqual([[41, 2]]);
  expect(result.calls.filter((call) => call.path.includes("/actions/") && call.token === "app-41-2")).toHaveLength(2);
  expect(result.calls.some((call) => call.path.includes("/actions/") && call.token === "personal-one")).toBe(false);
  expect(result.quota.identities.find((item) => item.kind === "app")).toMatchObject({ identity: "app:123:installation:41", rest: { used: 77 }, graphql: { used: 123 } });
});

test("permission fallback never reuses another identity's conditional body and missing installations stay personal", async () => {
  const result = await scenario<{ first: { id: number }[]; second: { id: number }[]; cached: { id: number }[]; outside: { id: number }[]; calls: Call[] }>(`
    let phase = "personal";
    respond = async (request, token, url) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname.endsWith("/actions/workflows")) {
        if (phase === "personal" && token.startsWith("app-")) return new Response("Resource not accessible by integration", { status: 403 });
        const id = token.startsWith("app-") ? 41 : 1;
        if (request.headers.has("if-none-match")) return new Response(null, { status: 304, headers: headers() });
        return Response.json({ workflows: [{ id }] }, { headers: { ...headers(), etag: '"' + id + '"' } });
      }
      throw new Error("Unexpected endpoint");
    };
    const first = await github.fetchActionWorkflows("acme/one");
    phase = "app";
    const second = await github.fetchActionWorkflows("acme/one");
    const cached = await github.fetchActionWorkflows("acme/one");
    const outside = await github.fetchActionWorkflows("acme/outside");
    console.log(JSON.stringify({ first, second, cached, outside, calls }));
  `);
  expect(result.first).toEqual([{ id: 1 }]);
  expect(result.second).toEqual([{ id: 41 }]);
  expect(result.cached).toEqual([{ id: 41 }]);
  expect(result.outside).toEqual([{ id: 1 }]);
  const appCalls = result.calls.filter((call) => call.path.endsWith("/actions/workflows") && call.token === "app-41-1");
  expect(appCalls.map((call) => call.etag)).toEqual([null, null, '"41"']);
  expect(result.calls.find((call) => call.path === "/repos/acme/outside/actions/workflows")?.token).toBe("personal-one");
});

test("GraphQL primary and permission fallbacks are bounded and transport or repeated bad credentials stay explicit", async () => {
  const result = await scenario<{ calls: Call[]; invalid: Outcome; invalidCalls: Call[]; transport: Outcome; transportCalls: Call[] }>(`
    let phase = "primary";
    respond = async (request, token, url) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname === "/graphql") {
        if (token.startsWith("app-41-") && phase === "primary") return Response.json({
          data: { repository: null, __prCockpitRateLimit: { cost: 0, used: 9000, remaining: 0, resetAt: new Date(reset * 1000).toISOString() } },
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }, { headers: headers("graphql", 9000, 9000) });
        if (token.startsWith("app-42-") && phase === "permission") return Response.json({ data: { repository: null }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] });
        return graphqlData(openPrs);
      }
      if (phase === "invalid") return new Response("Bad credentials", { status: 401 });
      return json({ workflows: [] });
    };
    await github.fetchRepositoryOpenPrs("acme/one");
    await github.fetchRepositoryOpenPrs("acme/one");
    phase = "permission";
    await github.fetchRepositoryOpenPrs("acme/two");
    phase = "invalid";
    const invalidStart = calls.length;
    const invalid = await capture(() => github.fetchActionWorkflows("acme/two"));
    const invalidCalls = calls.slice(invalidStart);
    server.stop(true);
    const transportStart = calls.length;
    const transport = await capture(() => github.fetchActionWorkflows("acme/two"));
    console.log(JSON.stringify({ calls, invalid, invalidCalls, transport, transportCalls: calls.slice(transportStart) }));
  `);
  expect(result.calls.filter((call) => call.path === "/graphql" && call.token.startsWith("app-41-"))).toHaveLength(1);
  expect(result.calls.filter((call) => call.path === "/graphql" && call.token === "personal-one")).toHaveLength(3);
  expect(result.invalid).toMatchObject({ status: 401, kind: "http" });
  expect(result.invalidCalls).toHaveLength(2);
  expect(result.invalidCalls.every((call) => call.token.startsWith("app-42-"))).toBe(true);
  expect(result.transport).toMatchObject({ status: 503, kind: "transport" });
  expect(result.transportCalls).toHaveLength(0);
});

test("switching personal tokens isolates live limits without splitting personal usage history", async () => {
  const ghScript = String.raw`#!/bin/sh
case "$2" in
  status)
    if [ -f "$COCKPIT_TEST_TOKEN_FILE.pending" ]; then
      printf '%s\n' '{"hosts":{}}'
    else
      printf '%s\n' '{"hosts":{"github.com":[{"active":true,"login":"fixture","scopes":"repo, workflow","state":"success"}]}}'
    fi ;;
  token)
    test ! -f "$COCKPIT_TEST_TOKEN_FILE.pending" || exit 1
    cat "$COCKPIT_TEST_TOKEN_FILE" ;;
  login)
    rm "$COCKPIT_TEST_TOKEN_FILE.pending" ;;
  *) exit 1 ;;
esac
`;
  const result = await scenario<{ current: GithubQuota; afterOld: GithubQuota; rejected: Outcome; again: Outcome; transport: Outcome; inFlightAfterFailure: number; inFlightAtEnd: number; calls: Call[]; restEvents: GithubRestUsageEvent[] }>(`
    await Bun.write(process.env.COCKPIT_GH_BIN, ${JSON.stringify(ghScript)});
    const switchUser = async (token) => {
      await Bun.write(process.env.COCKPIT_TEST_TOKEN_FILE, token + "\\n");
      await Bun.write(process.env.COCKPIT_TEST_TOKEN_FILE + ".pending", "");
      await github.startGithubSetup();
      for (let attempt = 0; attempt < 10; attempt++) {
        await github.githubAuthStatus();
        if (await github.ghToken() === token) return;
      }
      throw new Error("Personal authorization did not finish");
    };
    const held = Promise.withResolvers();
    const started = Promise.withResolvers();
    let holdOld = false;
    respond = async (request, token, url) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname === "/user") return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: headers("core", 5000) });
      if (token === "personal-one" && holdOld) {
        started.resolve();
        await held.promise;
        return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: headers("core", 5000) });
      }
      return json({ node_id: "comment-id" }, "core", token === "personal-one" ? 10 : 12);
    };
    await github.postIssueComment("acme/one", 1, "before reauthorization");
    holdOld = true;
    const old = capture(() => github.postIssueComment("acme/one", 1, "old"));
    await started.promise;
    await switchUser("personal-two");
    await github.postIssueComment("acme/one", 1, "new");
    const current = await github.fetchGithubQuota();
    const dispatch = globalThis.fetch;
    globalThis.fetch = () => { throw new TypeError("Synchronous transport failure"); };
    const transport = await capture(() => github.postIssueComment("acme/one", 1, "offline"));
    globalThis.fetch = dispatch;
    const inFlightAfterFailure = usage.githubRestRequestsInFlight("user");
    held.resolve();
    const rejected = await old;
    const afterOld = await github.fetchGithubQuota();
    await switchUser("personal-one");
    const again = await capture(() => github.postIssueComment("acme/one", 1, "retry"));
    console.log(JSON.stringify({ current, afterOld, rejected, again, transport, inFlightAfterFailure,
      inFlightAtEnd: usage.githubRestRequestsInFlight("user"), calls, restEvents }));
  `, false);
  expect(result.current.rest.used).toBe(12);
  expect(result.afterOld.rest.used).toBe(12);
  expect(result.current.identity).toBe("user");
  expect(result.again).toMatchObject({ kind: "quota", credential: result.rejected.credential });
  expect(result.transport).toMatchObject({ kind: "transport", credential: "user" });
  expect(result.inFlightAfterFailure).toBe(1);
  expect(result.inFlightAtEnd).toBe(0);
  expect(result.calls.filter((call) => call.method === "POST" && call.token === "personal-one")).toHaveLength(2);
  expect(result.restEvents.filter((event) => event.method === "POST").map((event) => event.used)).toEqual([10, 12]);
  expect(new Set(result.restEvents.map((event) => event.credential))).toEqual(new Set(["user"]));
});

test("absent app configuration adds no authentication traffic or installation UI state", async () => {
  const result = await scenario<{ calls: Call[]; quota: GithubQuota; issuances: [number, number][] }>(`
    respond = async (request, token, url) => url.pathname === "/rate_limit" ? Response.json(rateData()) : json({ workflows: [] });
    await github.fetchActionWorkflows("acme/one");
    const quota = await github.fetchGithubQuota();
    console.log(JSON.stringify({ calls, quota, issuances: [...issuances] }));
  `, false);
  expect(result.calls.map((call) => call.path)).toEqual(["/repos/acme/one/actions/workflows", "/rate_limit"]);
  expect(result.calls.every((call) => call.token === "personal-one")).toBe(true);
  expect(result.quota.identities).toBeUndefined();
  expect(result.issuances).toEqual([]);
});

test("personal GraphQL exhaustion leaves repository GraphQL reads on the app budget", async () => {
  const result = await scenario<{ failure: Outcome; calls: Call[]; quota: Report }>(`
    respond = async (request, token, url, body) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (token === "personal-one") return Response.json({ message: "API rate limit exceeded" }, {
        status: 403, headers: headers("graphql", 5000),
      });
      return graphqlData(openPrs, 25, 9000);
    };
    const failure = await capture(() => github.searchOpenPrs(["acme/one"]));
    await github.fetchRepositoryOpenPrs("acme/one");
    console.log(JSON.stringify({ failure, calls, quota: await github.fetchGithubQuota() }));
  `);
  expect(result.failure).toMatchObject({ kind: "quota", status: 403 });
  expect(result.calls.filter((call) => call.path === "/graphql").map((call) => call.token)).toEqual(["personal-one", "app-41-1"]);
  expect(result.quota.graphql.remaining).toBe(0);
  expect(result.quota.identities.find((item) => item.kind === "app")?.graphql?.remaining).toBe(8975);
});


test("numeric repository pagination preserves the requested repository and credential", async () => {
  const result = await scenario<{ labels: string[][]; pages: string[]; calls: Call[] }>(`
    const pages = [];
    respond = async (request, token, url) => {
      pages.push(url.pathname + url.search);
      if (!url.pathname.endsWith("/labels")) throw new Error("Unexpected label endpoint");
      const page = url.searchParams.get("page") ?? "1";
      const responseHeaders = headers();
      if (page === "1") responseHeaders.link = '<https://api.github.com/repositories/123/labels?per_page=100&page=2>; rel="next"';
      return Response.json([{ name: page === "1" ? "bug" : "feature", color: "ffffff" }], { headers: responseHeaders });
    };
    const labels = [];
    for (const repo of ["acme/one", "outside/repo"]) {
      labels.push((await github.fetchRepoLabels(repo)).map(label => label.name));
    }
    console.log(JSON.stringify({ labels, pages, calls }));
  `);
  expect(result.labels).toEqual([["bug", "feature"], ["bug", "feature"]]);
  expect(result.pages).toEqual([
    "/repos/acme/one/labels?per_page=100", "/repos/acme/one/labels?per_page=100&page=2",
    "/repos/outside/repo/labels?per_page=100", "/repos/outside/repo/labels?per_page=100&page=2",
  ]);
  expect(result.calls.filter(call => call.path.endsWith("/labels")).map(call => call.token))
    .toEqual(["app-41-1", "app-41-1", "personal-one", "personal-one"]);
});

test("personal quota reporting survives broken optional App configuration", async () => {
  const result = await scenario<{ quota: Report; failure: Outcome; calls: Call[] }>(`
    respond = async (request, token, url) => url.pathname === "/rate_limit" ? Response.json(rateData()) : json({ workflows: [] });
    await github.fetchActionWorkflows("acme/one");
    await Bun.write(process.env.COCKPIT_GITHUB_APP_CONFIG, "{");
    (await import(${JSON.stringify(appUrl)})).invalidateGithubAppConfig();
    const quota = await github.fetchGithubQuota();
    const failure = await capture(() => github.fetchActionWorkflows("acme/one"));
    console.log(JSON.stringify({ quota, failure, calls }));
  `);
  expect(result.quota.rest.remaining).toBe(5000);
  expect(result.quota.identities.find(identity => identity.kind === "app")?.rest?.remaining).toBe(4990);
  expect(result.failure).toMatchObject({ kind: "http", status: 502, credential: "app" });
  expect(result.calls.filter(call => call.path.endsWith("/actions/workflows"))).toHaveLength(1);
});

test("secondary limits during App authentication stop personal requests too", async () => {
  const result = await scenario<{ failure: Outcome; write: Outcome; calls: Call[] }>(`
    installationFailure = () => Response.json({ message: "Secondary rate limit" }, {
      status: 403, headers: { "retry-after": "60" },
    });
    const failure = await capture(() => github.fetchActionWorkflows("acme/one"));
    const write = await capture(() => github.postIssueComment("acme/one", 1, "blocked"));
    console.log(JSON.stringify({ failure, write, calls }));
  `);
  expect(result.failure).toMatchObject({ kind: "quota", credential: "app" });
  expect(result.write).toMatchObject({ kind: "quota" });
  expect(result.calls.map(call => call.path)).toEqual(["/repos/acme/one/installation"]);
});

test("disabled-App background reads do not wait for a quota refresh after a quiet minute", async () => {
  const result = await scenario<{ remaining: number; requests: number; installationRequired: boolean }>(`
    let now = Date.now();
    Date.now = () => now;
    let requests = 0;
    const refreshStarted = Promise.withResolvers();
    const release = Promise.withResolvers();
    respond = async (request, token, url) => {
      if (url.pathname !== "/rate_limit") throw new Error("Unexpected quota request");
      requests++;
      if (requests > 1) {
        refreshStarted.resolve();
        await release.promise;
      }
      return Response.json(rateData());
    };
    await github.fetchGithubQuota();
    now += 61000;
    const quota = await github.repositoryReadQuota("acme/one", "core");
    const installationRequired = await github.repositoryReadQuota("acme/one", "core", true) === undefined;
    await refreshStarted.promise;
    release.resolve();
    await github.fetchGithubQuota();
    console.log(JSON.stringify({ remaining: quota.remaining, requests, installationRequired }));
  `, false);
  expect(result).toEqual({ remaining: 5000, requests: 2, installationRequired: true });
});

test("background reads use healthy personal quota when an installation reaches its reserve", async () => {
  const result = await scenario<{ remaining: number; installationOnly: boolean; tokens: string[] }>(`
    respond = async (request, token, url) => url.pathname === "/rate_limit"
      ? Response.json(rateData())
      : json({ workflows: [] }, "core", token.startsWith("app-") ? 4900 : 10);
    await github.fetchActionWorkflows("acme/one");
    await github.fetchGithubQuota();
    const installationOnly = await github.repositoryReadQuota("acme/one", "core", true) === undefined;
    const available = await github.repositoryReadQuota("acme/one", "core");
    await usage.withGithubUsageSource("background poll", () => github.fetchActionWorkflows("acme/one"));
    await github.fetchActionWorkflows("acme/one");
    console.log(JSON.stringify({ remaining: available.remaining, installationOnly,
      tokens: calls.filter(call => call.path.endsWith("/actions/workflows")).map(call => call.token) }));
  `);
  expect(result).toEqual({ remaining: 5000, installationOnly: true, tokens: ["app-41-1", "personal-one", "app-41-1"] });
});

test("uninstalling an App preserves PR lookup through personal authentication", async () => {
  const result = await scenario<{ lookups: unknown[]; identities?: unknown[]; issuances: [number, number][]; calls: Call[] }>(`
    respond = async (request, token, url) => {
      if (url.pathname === "/rate_limit") return Response.json(rateData());
      if (url.pathname === "/graphql") return graphqlData({ pr0: {
        number: 7, title: "Existing PR", state: "OPEN", isDraft: false,
        createdAt: "2026-09-01T09:00:00Z", updatedAt: "2026-09-01T10:00:00Z", author: { login: "author" },
      } });
      return json({ workflows: [] });
    };
    await github.fetchActionWorkflows("acme/one");
    (await import(${JSON.stringify(appUrl)})).invalidateGithubAppToken("app:123:installation:41");
    issuanceFailure = () => Response.json({ message: "Not Found" }, { status: 404 });
    const lookups = [await github.lookupPr("acme/one", 7), await github.lookupPr("acme/one", 7)];
    const quota = await github.fetchGithubQuota();
    console.log(JSON.stringify({ lookups, identities: quota.identities, issuances: [...issuances], calls }));
  `);
  expect(result.lookups).toEqual([
    { repo: "acme/one", number: 7, title: "Existing PR", state: "OPEN" },
    { repo: "acme/one", number: 7, title: "Existing PR", state: "OPEN" },
  ]);
  expect(result.calls.filter(call => call.path === "/graphql").map(call => call.token)).toEqual(["personal-one", "personal-one"]);
  expect(result.issuances).toEqual([[41, 2]]);
  expect(result.identities).toBeUndefined();
});

test("quota App status is passive and only completed repository reads establish success", async () => {
  const result = await scenario<{
    before: GithubAppReadHealth; issued: GithubAppReadHealth; working: GithubAppReadHealth;
    statusTraffic: number[]; issuanceCounts: number[]; firstReadAt: string; secondReadAt: string;
  }>(`
    let now = Date.now();
    Date.now = () => now;
    respond = async (_request, _token, url) => url.pathname === "/graphql"
      ? graphqlData(openPrs) : json({ workflows: [] });
    const statusTraffic = [];
    const issuanceCounts = [];
    const snapshot = async () => {
      const beforeCalls = calls.length;
      const beforeTokens = [...issuances.values()].reduce((sum, value) => sum + value, 0);
      const health = (await appStatus()).app.health;
      await appStatus();
      statusTraffic.push(calls.length - beforeCalls);
      issuanceCounts.push([...issuances.values()].reduce((sum, value) => sum + value, 0) - beforeTokens);
      return health;
    };
    const before = await snapshot();
    await github.repositoryReadQuota("acme/one", "core", true);
    const issued = await snapshot();
    const firstReadAt = new Date(now).toISOString();
    await github.fetchRepositoryOpenPrs("acme/one");
    now += 1000;
    const secondReadAt = new Date(now).toISOString();
    await github.fetchActionWorkflows("acme/two");
    const working = await snapshot();
    console.log(JSON.stringify({ before, issued, working, statusTraffic, issuanceCounts, firstReadAt, secondReadAt }));
  `);
  expect(result.before).toEqual({ repositories: [], cooldownUntil: null });
  expect(result.issued).toEqual(result.before);
  expect(result.working).toEqual({
    repositories: [
      { repo: "acme/one", lastSuccessAt: result.firstReadAt, error: null },
      { repo: "acme/two", lastSuccessAt: result.secondReadAt, error: null },
    ],
    cooldownUntil: null,
  });
  expect(result.statusTraffic).toEqual([0, 0, 0]);
  expect(result.issuanceCounts).toEqual([0, 0, 0]);
});

test("personal fallback cannot report App success and GraphQL body failures retain the last actual success", async () => {
  const result = await scenario<{
    fallback: GithubAppReadHealth; recovered: GithubAppReadHealth; malformed: GithubAppReadHealth[];
    failures: Outcome[]; tokens: string[]; quota: GithubAppReadHealth; exposed: string;
  }>(`
    let phase = "forbidden";
    respond = async (_request, token, url) => {
      if (!token.startsWith("app-")) return graphqlData(openPrs);
      if (phase === "forbidden") return Response.json({
        data: { repository: openPrs }, errors: [{ type: "FORBIDDEN", message: "private-secret" }],
      });
      if (phase === "quota") return Response.json({
        data: { repository: openPrs }, errors: [{ type: "RATE_LIMITED", message: "private-secret" }],
      }, { headers: headers("graphql", 5000) });
      if (phase === "array") return Response.json({ data: [] });
      if (phase === "errors") return Response.json({ data: { repository: openPrs }, errors: {} });
      if (phase === "json") return new Response("private-secret");
      return graphqlData(openPrs);
    };
    await github.fetchRepositoryOpenPrs("acme/one");
    const fallback = (await appStatus()).app.health;
    phase = "healthy";
    await github.fetchRepositoryOpenPrs("acme/one");
    const recovered = (await appStatus()).app.health;
    const malformed = [];
    const failures = [];
    for (phase of ["array", "errors", "json"]) {
      failures.push(await capture(() => github.fetchRepositoryOpenPrs("acme/one")));
      malformed.push((await appStatus()).app.health);
    }
    phase = "quota";
    await github.fetchRepositoryOpenPrs("acme/two");
    const quota = (await appStatus()).app.health;
    const exposed = JSON.stringify({ fallback, recovered, malformed, quota });
    console.log(JSON.stringify({ fallback, recovered, malformed, failures, quota, exposed,
      tokens: calls.filter(call => call.path === "/graphql").map(call => call.token) }));
  `);
  expect(result.fallback.repositories).toEqual([
    { repo: "acme/one", lastSuccessAt: null, error: { at: expect.any(String), kind: "access", resetAt: null } },
  ]);
  const success = result.recovered.repositories[0]!;
  expect(success).toMatchObject({ repo: "acme/one", lastSuccessAt: expect.any(String), error: null });
  expect(result.failures).toHaveLength(3);
  expect(result.failures.every((failure) => typeof failure.message === "string")).toBe(true);
  for (const health of result.malformed) {
    expect(health.repositories[0]).toMatchObject({ lastSuccessAt: success.lastSuccessAt, error: { kind: "request" } });
  }
  expect(result.quota.repositories.find((repo) => repo.repo === "acme/two")).toMatchObject({
    lastSuccessAt: null, error: { kind: "quota", resetAt: expect.any(String) },
  });
  expect(result.tokens.slice(0, 3)).toEqual(["app-41-1", "personal-one", "app-41-1"]);
  expect(result.tokens.slice(-2)).toEqual(["app-42-1", "personal-one"]);
  expect(result.exposed).not.toContain("private-secret");
});

test("discovery and issuance failures are visible before the first App credential without status probes", async () => {
  const result = await scenario<{
    health: GithubAppReadHealth[]; passive: boolean; exposed: string;
  }>(`
    const provider = await import(${JSON.stringify(appUrl)});
    const health = [];
    let passive = true;
    respond = async () => json({ workflows: [] });
    const snapshot = async () => {
      const before = calls.length;
      const issued = JSON.stringify([...issuances]);
      health.push((await appStatus()).app.health);
      passive &&= calls.length === before && JSON.stringify([...issuances]) === issued;
    };
    installationFailure = () => new Response("private-secret", { status: 401 });
    await capture(() => github.fetchActionWorkflows("acme/one"));
    await snapshot();
    provider.invalidateGithubAppConfig();
    installationFailure = () => new Response("private-secret", { status: 403 });
    await github.fetchActionWorkflows("acme/two");
    await snapshot();
    provider.invalidateGithubAppConfig();
    installationFailure = null;
    issuanceFailure = () => new Response("private-secret", { status: 401 });
    await capture(() => github.fetchActionWorkflows("acme/three"));
    await snapshot();
    provider.invalidateGithubAppConfig();
    const dispatch = globalThis.fetch;
    globalThis.fetch = () => { throw new TypeError("private-secret connection"); };
    await capture(() => github.fetchActionWorkflows("acme/four"));
    globalThis.fetch = dispatch;
    await snapshot();
    console.log(JSON.stringify({ health, passive, exposed: JSON.stringify(health) }));
  `);
  expect(result.health[0]?.repositories[0]).toMatchObject({ repo: "acme/one", lastSuccessAt: null, error: { kind: "authentication" } });
  expect(result.health[1]?.repositories.find((repo) => repo.repo === "acme/two")).toMatchObject({ lastSuccessAt: null, error: { kind: "access" } });
  expect(result.health[2]?.repositories.find((repo) => repo.repo === "acme/three")).toMatchObject({ lastSuccessAt: null, error: { kind: "authentication" } });
  expect(result.health[3]?.repositories.find((repo) => repo.repo === "acme/four")).toMatchObject({ lastSuccessAt: null, error: { kind: "connection" } });
  expect(result.passive).toBe(true);
  expect(result.exposed).not.toContain("private-secret");
});

test("renewal errors preserve the last App success and a recovered 401 clears its temporary issue", async () => {
  const result = await scenario<{
    first: GithubAppReadHealth; failed: GithubAppReadHealth; renewed: GithubAppReadHealth;
    rejected: Outcome; tokens: string[]; issuances: [number, number][];
  }>(`
    const provider = await import(${JSON.stringify(appUrl)});
    let phase = "healthy";
    respond = async (_request, token) => phase === "rejected" && token === "app-41-3"
      ? new Response("private-secret", { status: 401 }) : json({ workflows: [] });
    await github.fetchActionWorkflows("acme/one");
    const first = (await appStatus()).app.health;
    provider.invalidateGithubAppToken("app:123:installation:41");
    issuanceFailure = () => new Response("private-secret", { status: 401 });
    const rejected = await capture(() => github.fetchActionWorkflows("acme/one"));
    const failed = (await appStatus()).app.health;
    provider.invalidateGithubAppConfig();
    issuanceFailure = null;
    phase = "rejected";
    await github.fetchActionWorkflows("acme/one");
    const renewed = (await appStatus()).app.health;
    console.log(JSON.stringify({ first, failed, renewed, rejected, issuances: [...issuances],
      tokens: calls.filter(call => call.path.endsWith("/actions/workflows")).map(call => call.token) }));
  `);
  expect(result.rejected).toMatchObject({ status: 401 });
  expect(result.failed.repositories[0]).toMatchObject({
    lastSuccessAt: result.first.repositories[0]!.lastSuccessAt, error: { kind: "authentication" },
  });
  expect(result.renewed.repositories[0]).toMatchObject({ lastSuccessAt: expect.any(String), error: null });
  expect(result.tokens).toEqual(["app-41-1", "app-41-3", "app-41-4"]);
  expect(result.issuances).toEqual([[41, 4]]);
});

test("missing installations clear stale success and replaced or removed configuration cannot expose it", async () => {
  const result = await scenario<{
    missing: GithubAppReadHealth; replaced: GithubAppReadHealth; removed: { app: null };
    before: number; after: number; missingTokens: string[];
  }>(`
    let now = Date.now();
    Date.now = () => now;
    respond = async () => json({ workflows: [] });
    await github.fetchActionWorkflows("acme/one");
    now += 300001;
    installationFailure = () => new Response("private-secret", { status: 404 });
    await github.fetchActionWorkflows("acme/one");
    const missing = (await appStatus()).app.health;
    const config = await Bun.file(process.env.COCKPIT_GITHUB_APP_CONFIG).json();
    await Bun.write(process.env.COCKPIT_GITHUB_APP_CONFIG, JSON.stringify({ ...config, appId: "replacement" }));
    const before = calls.length;
    const replaced = (await appStatus()).app.health;
    unlinkSync(process.env.COCKPIT_GITHUB_APP_CONFIG);
    const removed = await appStatus();
    console.log(JSON.stringify({ missing, replaced, removed, before, after: calls.length,
      missingTokens: calls.filter(call => call.path.endsWith("/actions/workflows")).map(call => call.token) }));
  `);
  expect(result.missing.repositories).toEqual([
    { repo: "acme/one", lastSuccessAt: null, error: { at: expect.any(String), kind: "access", resetAt: null } },
  ]);
  expect(result.missingTokens).toEqual(["app-41-1", "personal-one"]);
  expect(result.replaced).toEqual({ repositories: [], cooldownUntil: null });
  expect(result.removed).toEqual({ app: null });
  expect(result.after).toBe(result.before);
});

test("global secondary cooldown is reported over a prior App success without status traffic", async () => {
  const result = await scenario<{ health: GithubAppReadHealth; before: number; after: number }>(`
    respond = async (request) => request.method === "POST"
      ? new Response("private-secret", { status: 403, headers: { "retry-after": "120" } })
      : json({ workflows: [] });
    await github.fetchActionWorkflows("acme/one");
    await capture(() => github.postIssueComment("acme/one", 1, "blocked"));
    const before = calls.length;
    const health = (await appStatus()).app.health;
    await appStatus();
    console.log(JSON.stringify({ health, before, after: calls.length }));
  `);
  expect(result.health.repositories[0]).toMatchObject({ lastSuccessAt: expect.any(String), error: null });
  expect(result.health.cooldownUntil).toEqual(expect.any(String));
  expect(result.after).toBe(result.before);
});

test("App response headers are not success until the repository body finishes, and failed bodies retain the prior success", async () => {
  const result = await scenario<{
    pending: GithubAppReadHealth; complete: GithubAppReadHealth; failed: GithubAppReadHealth;
    diff: string; failure: Outcome;
  }>(`
    let headersReceived = Promise.withResolvers();
    let release = Promise.withResolvers();
    let failBody = false;
    respond = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("diff fixture"));
        release.promise.then(() => {
          if (failBody) controller.error(new Error("private-secret body failure"));
          else controller.close();
        });
      },
    }), { headers: headers() });
    const dispatch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
      const response = await dispatch(input, options);
      if (new URL(String(input)).pathname.endsWith("/pulls/1")) headersReceived.resolve();
      return response;
    };
    const read = github.fetchDiff("acme/one", 1);
    await headersReceived.promise;
    const pending = (await appStatus()).app.health;
    release.resolve();
    const diff = await read;
    const complete = (await appStatus()).app.health;
    failBody = true;
    headersReceived = Promise.withResolvers();
    release = Promise.withResolvers();
    const rejected = capture(() => github.fetchDiff("acme/one", 1));
    await headersReceived.promise;
    release.resolve();
    const failure = await rejected;
    const failed = (await appStatus()).app.health;
    console.log(JSON.stringify({ pending, complete, failed, diff, failure }));
  `);
  expect(result.pending.repositories).toEqual([]);
  expect(result.diff).toBe("diff fixture");
  expect(result.complete.repositories[0]).toMatchObject({ lastSuccessAt: expect.any(String), error: null });
  expect(result.failure.message).toEqual(expect.any(String));
  expect(result.failed.repositories[0]).toMatchObject({
    lastSuccessAt: result.complete.repositories[0]!.lastSuccessAt, error: { kind: "connection" },
  });
});

test("successful reads that drain an installation pool expose a passive quota issue on every observed repository", async () => {
  for (const resource of ["core", "graphql"] as const) {
    const result = await scenario<{
      drained: GithubAppReadHealth; fallback: GithubAppReadHealth; expired: GithubAppReadHealth;
      resetAt: string; before: number; after: number; tokens: string[];
    }>(`
      let now = Date.now();
      Date.now = () => now;
      const resource = ${JSON.stringify(resource)};
      let drain = false;
      const read = (repo) => resource === "core"
        ? github.fetchActionWorkflows(repo) : github.fetchRepositoryOpenPrs(repo);
      respond = async (_request, token) => {
        const used = drain && token.startsWith("app-") ? 5000 : 10;
        return resource === "core" ? json({ workflows: [] }, "core", used) : graphqlData(openPrs, used);
      };
      await read("acme/one");
      await read("acme/another");
      drain = true;
      await read("acme/one");
      const before = calls.length;
      const drained = (await appStatus()).app.health;
      await appStatus();
      const after = calls.length;
      await read("acme/one");
      await read("acme/another");
      const fallback = (await appStatus()).app.health;
      now = reset * 1000 + 1;
      const expired = (await appStatus()).app.health;
      console.log(JSON.stringify({ drained, fallback, expired, before, after,
        resetAt: new Date(reset * 1000).toISOString(),
        tokens: calls.filter(call => call.token !== "jwt").map(call => call.token) }));
    `);
    for (const health of [result.drained, result.fallback]) {
      expect(health.repositories).toHaveLength(2);
      for (const repo of health.repositories) {
        expect(repo).toMatchObject({ lastSuccessAt: expect.any(String), error: { kind: "quota", resetAt: result.resetAt } });
      }
    }
    for (const repo of result.expired.repositories) expect(repo.error).toBeNull();
    expect(result.tokens).toEqual(["app-41-1", "app-41-1", "app-41-1", "personal-one", "personal-one"]);
    expect(result.after).toBe(result.before);
  }
});

test("an older delayed success cannot clear a newer request failure, provider failure, or missing installation", async () => {
  const result = await scenario<{ before: GithubAppReadHealth[]; after: GithubAppReadHealth[] }>(`
    const provider = await import(${JSON.stringify(appUrl)});
    const before = [];
    const after = [];
    let hold = false;
    let accessFailure = false;
    let started;
    let release;
    respond = async (_request, token) => {
      if (token.startsWith("app-") && hold) {
        started.resolve();
        await release.promise;
        return json({ workflows: [] });
      }
      if (token.startsWith("app-") && accessFailure) return new Response("private-secret", { status: 403 });
      return json({ workflows: [] });
    };
    for (const mode of ["request", "provider", "missing"]) {
      provider.invalidateGithubAppConfig();
      installationFailure = null;
      accessFailure = false;
      await github.fetchActionWorkflows("acme/one");
      started = Promise.withResolvers();
      release = Promise.withResolvers();
      hold = true;
      const older = github.fetchActionWorkflows("acme/one");
      await started.promise;
      hold = false;
      if (mode === "request") accessFailure = true;
      else {
        provider.invalidateGithubAppConfig();
        installationFailure = () => new Response("private-secret", { status: mode === "missing" ? 404 : 401 });
      }
      await capture(() => github.fetchActionWorkflows("acme/one"));
      before.push((await appStatus()).app.health);
      release.resolve();
      await older;
      after.push((await appStatus()).app.health);
    }
    console.log(JSON.stringify({ before, after }));
  `);
  expect(result.after).toEqual(result.before);
  for (const [index, kind] of (["access", "authentication", "access"] as const).entries()) {
    expect(result.after[index]?.repositories[0]?.error?.kind).toBe(kind);
  }
  expect(result.after[0]?.repositories[0]?.lastSuccessAt).toEqual(expect.any(String));
  expect(result.after[1]?.repositories[0]?.lastSuccessAt).toEqual(expect.any(String));
  expect(result.after[2]?.repositories[0]?.lastSuccessAt).toBeNull();
});

test("missing PR aliases establish App access without changing the existing personal fallback", async () => {
  const result = await scenario<{ lookup: unknown; health: GithubAppReadHealth; tokens: string[] }>(`
    respond = async () => Response.json({
      data: { repository: { pr0: null } },
      errors: [{ type: "NOT_FOUND", message: "private-secret", path: ["repository", "pr0"] }],
    });
    const lookup = await github.lookupPr("acme/one", 7);
    const health = (await appStatus()).app.health;
    console.log(JSON.stringify({ lookup, health, tokens: calls.filter(call => call.path === "/graphql").map(call => call.token) }));
  `);
  expect(result.lookup).toBeNull();
  expect(result.health.repositories).toEqual([
    { repo: "acme/one", lastSuccessAt: expect.any(String), error: null },
  ]);
  expect(result.tokens).toEqual(["app-41-1", "personal-one"]);
});

test("missing installations on untracked links stay out of health while tracked misses and real provider failures remain visible", async () => {
  const result = await scenario<{ untracked: GithubAppReadHealth; tracked: GithubAppReadHealth; failed: GithubAppReadHealth }>(`
    settings.writeSettings({ repos: "outside/tracked" });
    respond = async () => Response.json({
      data: { repository: { pr0: null } },
      errors: [{ type: "NOT_FOUND", message: "private-secret", path: ["repository", "pr0"] }],
    });
    await github.lookupPr("outside/untracked", 7);
    const untracked = (await appStatus()).app.health;
    await github.lookupPr("outside/tracked", 7);
    const tracked = (await appStatus()).app.health;
    (await import(${JSON.stringify(appUrl)})).invalidateGithubAppConfig();
    installationFailure = () => new Response("private-secret", { status: 401 });
    await capture(() => github.lookupPr("linked/project", 7));
    const failed = (await appStatus()).app.health;
    console.log(JSON.stringify({ untracked, tracked, failed }));
  `);
  expect(result.untracked.repositories).toEqual([]);
  expect(result.tracked.repositories).toEqual([
    { repo: "outside/tracked", lastSuccessAt: null, error: { at: expect.any(String), kind: "access", resetAt: null } },
  ]);
  expect(result.failed.repositories.map((repo) => repo.repo)).toEqual(["linked/project", "outside/tracked"]);
  expect(result.failed.repositories[0]?.error?.kind).toBe("authentication");
});

test("a binary contents payload remains a successful App read even when text decoding rejects it", async () => {
  const result = await scenario<{ failure: Outcome; health: GithubAppReadHealth; tokens: string[] }>(`
    respond = async () => json({ encoding: "base64", content: Buffer.from([255, 254]).toString("base64") });
    const failure = await capture(() => github.fetchFileContents("acme/one", "image.bin", "fixture-sha"));
    const health = (await appStatus()).app.health;
    console.log(JSON.stringify({ failure, health, tokens: calls.filter(call => call.path.includes("/contents/")).map(call => call.token) }));
  `);
  expect(result.failure.message).toEqual(expect.any(String));
  expect(result.health.repositories).toEqual([
    { repo: "acme/one", lastSuccessAt: expect.any(String), error: null },
  ]);
  expect(result.tokens).toEqual(["app-41-1"]);
});
