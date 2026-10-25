import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const providerUrl = new URL("./githubApp.ts", import.meta.url).href;

// Separate processes keep HOME, the clock, and credential caches isolated from other GitHub tests.
async function providerScenario(body: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pr-cockpit-github-app-"));
  const script = `
    import assert from "node:assert/strict";
    import { generateKeyPairSync, verify } from "node:crypto";
    import { mkdirSync, writeFileSync, rmSync } from "node:fs";
    import { join } from "node:path";
    import {
      githubAppAuthentication as authenticate, invalidateGithubAppToken as invalidate,
      invalidateGithubAppConfig as invalidateConfig, GithubAppError,
    } from ${JSON.stringify(providerUrl)};
    const root = process.env.HOME;
    const configPath = process.env.COCKPIT_GITHUB_APP_CONFIG;
    const keyPath = join(root, "app.pem");
    let appId = "12345";
    let keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    function writeKey() {
      writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
    }
    function writeConfig(privateKeyPath = keyPath) {
      writeFileSync(configPath, JSON.stringify({ appId, privateKeyPath }), { mode: 0o600 });
    }
    writeKey();
    writeConfig();
    let now = Date.now();
    Date.now = () => now;
    let tokens = 0;
    const calls = [];
    let serverError;
    let handler = async (request, path) => {
      if (path.endsWith("/installation")) return Response.json({ id: path.includes("/other/") ? 22 : 11 });
      if (path.endsWith("/access_tokens")) return tokenResponse();
      throw new Error("Unexpected mock GitHub path " + path);
    };
    function tokenResponse(extra = {}) {
      return Response.json({
        token: "ghs_fixture_" + (++tokens),
        expires_at: new Date(now + 3_600_000).toISOString(),
        permissions: { contents: "read", pull_requests: "read", actions: "read" },
        ...extra,
      }, { status: 201 });
    }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        const path = new URL(request.url).pathname;
        calls.push({ path, method: request.method });
        const authorization = request.headers.get("authorization");
        assert.ok(authorization?.startsWith("Bearer "));
        const [header, payload, signature] = authorization.slice(7).split(".");
        assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
        const claims = JSON.parse(Buffer.from(payload, "base64url"));
        assert.equal(claims.iss, appId);
        assert.ok(claims.iat <= Math.floor(now / 1000) - 60);
        assert.ok(claims.exp > Math.floor(now / 1000));
        assert.ok(claims.exp <= Math.floor(now / 1000) + 600);
        assert.ok(verify("RSA-SHA256", Buffer.from(header + "." + payload), keys.publicKey, Buffer.from(signature, "base64url")));
        assert.equal(request.headers.get("accept"), "application/vnd.github+json");
        assert.equal(request.headers.get("x-github-api-version"), "2026-03-10");
        if (path.endsWith("/installation")) assert.equal(request.method, "GET");
        else assert.equal(request.method, "POST");
        return await handler(request, path);
      } catch (error) {
        serverError = error;
        return new Response("mock assertion failed", { status: 500 });
      }
    } });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return nativeFetch(new URL(url.pathname, server.url), init);
    };
    try {
      ${body}
      assert.equal(serverError, undefined);
    } finally {
      server.stop(true);
    }
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...process.env, HOME: root, COCKPIT_GITHUB_APP_CONFIG: join(root, "github-app.json") },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("configuration presence and credentials are cached briefly, with explicit setup invalidation", async () => {
  await providerScenario(`
    rmSync(configPath);
    assert.equal(await authenticate("not a repository"), null);
    writeConfig();
    assert.equal(await authenticate("example/project"), null);
    assert.equal(calls.length, 0);
    invalidateConfig();
    const first = await authenticate("example/project");
    assert.equal(first.installationId, 11);
    rmSync(configPath);
    assert.equal((await authenticate("example/project")).token, first.token);
    now += 30_001;
    assert.equal(await authenticate("example/project"), null);
    assert.equal(calls.length, 2);
    delete process.env.COCKPIT_GITHUB_APP_CONFIG;
    assert.equal(await authenticate("example/project"), null);
    mkdirSync(join(root, ".config/pr-cockpit"), { recursive: true });
    writeFileSync(join(root, ".config/pr-cockpit/github-app.json"), JSON.stringify({ appId, privateKeyPath: "~/app.pem" }));
    assert.equal(await authenticate("example/project"), null);
    now += 30_001;
    assert.equal((await authenticate("example/project")).installationId, 11);
    rmSync(join(root, ".config/pr-cockpit/github-app.json"));
    now += 30_001;
    assert.equal(await authenticate("example/project"), null);
    assert.equal(calls.length, 4);
    process.env.COCKPIT_GITHUB_APP_CONFIG = configPath;
    writeConfig("app.pem");
    assert.ok(await authenticate("example/project"));
    assert.equal(calls.length, 6);
  `);
});

test("signed JWT discovery and issuance single-flight without conflating installations", async () => {
  await providerScenario(`
    const first = await Promise.all(Array.from({ length: 30 }, () => authenticate("Example/Project")));
    assert.equal(calls.length, 2);
    assert.equal(tokens, 1);
    assert.deepEqual(first[0], {
      token: "ghs_fixture_1", identity: "app:12345:installation:11", installationId: 11,
      permissions: { contents: "read", pull_requests: "read", actions: "read" },
    });
    assert.ok(first.every((entry) => entry.token === first[0].token));
    first[0].permissions.contents = "write";
    assert.equal((await authenticate("example/project")).permissions.contents, "read");
    assert.equal((await authenticate("example/another")).token, "ghs_fixture_1");
    const other = await authenticate("other/project");
    assert.equal(other.identity, "app:12345:installation:22");
    assert.equal(other.token, "ghs_fixture_2");
    assert.equal((await authenticate("example/project")).token, "ghs_fixture_1");
    assert.equal(calls.length, 5);
  `);
});

test("tokens refresh early once, retain identity, and invalidation evicts only that installation", async () => {
  await providerScenario(`
    const first = await authenticate("example/project");
    const other = await authenticate("other/project");
    now += 3_550_000;
    const refreshed = await Promise.all(Array.from({ length: 20 }, () => authenticate("example/project")));
    assert.equal(tokens, 3);
    assert.ok(refreshed.every((entry) => entry.token === "ghs_fixture_3" && entry.identity === first.identity));
    invalidate(first.identity);
    assert.equal((await authenticate("example/project")).token, "ghs_fixture_4");
    assert.equal(tokens, 4);
    // Refresh the second installation, then invalidating the first leaves it untouched.
    const currentOther = await authenticate("other/project");
    assert.equal(currentOther.identity, other.identity);
    invalidate(first.identity);
    assert.equal((await authenticate("other/project")).token, currentOther.token);
    assert.equal(tokens, 5);
  `);
});

test("invalidation during issuance cannot replace the new cached token with an old one", async () => {
  await providerScenario(`
    const first = await authenticate("example/project");
    invalidate(first.identity);
    const { promise: started, resolve: oldStarted } = Promise.withResolvers();
    const { promise: oldGate, resolve: releaseOld } = Promise.withResolvers();
    let issuance = 0;
    handler = async (_request, path) => {
      assert.ok(path.endsWith("/access_tokens"));
      const response = tokenResponse();
      if (++issuance === 1) { oldStarted(); await oldGate; }
      return response;
    };
    const old = authenticate("example/project");
    await started;
    invalidate(first.identity);
    const fresh = await authenticate("example/project");
    releaseOld();
    assert.notEqual((await old).token, fresh.token);
    assert.equal((await authenticate("example/project")).token, fresh.token);
    assert.equal(tokens, 3);
  `);
});

test("discovery caches missing installations briefly and rechecks positive repository scope", async () => {
  await providerScenario(`
    let installed = false;
    let installationId = 11;
    handler = async (_request, path) => path.endsWith("/installation")
      ? installed ? Response.json({ id: installationId }) : new Response("not installed", { status: 404 })
      : tokenResponse();
    assert.equal(await authenticate("example/project"), null);
    installed = true;
    assert.equal(await authenticate("example/project"), null);
    assert.equal(calls.length, 1);
    now += 60_001;
    assert.equal((await authenticate("example/project")).installationId, 11);
    installationId = 22;
    assert.equal((await authenticate("example/project")).installationId, 11);
    now += 300_001;
    assert.equal((await authenticate("example/project")).installationId, 22);
    assert.equal(tokens, 2);
  `);
});

test("manual configuration and key rotation reload within the metadata TTL and discard old caches", async () => {
  await providerScenario(`
    const first = await authenticate("example/project");
    keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeKey();
    assert.equal((await authenticate("example/project")).token, first.token);
    now += 30_001;
    assert.equal((await authenticate("example/project")).token, "ghs_fixture_2");
    appId = "678901";
    writeConfig();
    assert.equal((await authenticate("example/project")).token, "ghs_fixture_2");
    now += 30_001;
    const changed = await authenticate("example/project");
    assert.notEqual(changed.identity, first.identity);
    assert.equal(changed.identity, "app:678901:installation:11");
    assert.equal(tokens, 3);
    writeFileSync(configPath, "invalid JSON with a private secret");
    assert.equal((await authenticate("example/project")).token, changed.token);
    now += 30_001;
    const failure = await authenticate("example/project").catch((error) => error);
    assert.ok(failure instanceof GithubAppError);
    assert.match(failure.message, /configuration/);
    assert.ok(!failure.message.includes("private secret"));
    writeConfig();
    await assert.rejects(authenticate("example/project"), (error) => error === failure);
    assert.equal(tokens, 3);
    invalidateConfig();
    assert.equal((await authenticate("example/project")).token, "ghs_fixture_4");
  `);
});

test("bad configuration, malformed repository names, and invalid keys fail without network", async () => {
  await providerScenario(`
    for (const config of [null, {}, { appId: 12345, privateKeyPath: keyPath }, { appId: "12345", privateKeyPath: "" }]) {
      writeFileSync(configPath, JSON.stringify(config));
      invalidateConfig();
      await assert.rejects(authenticate("example/project"), /configuration/);
    }
    writeConfig();
    invalidateConfig();
    for (const repo of ["example", "../project", "example/..", "example/project/extra", "example/project?token=secret"]) {
      await assert.rejects(authenticate(repo), new RegExp("owner/repository"));
    }
    writeFileSync(keyPath, "private-secret-not-a-key");
    invalidateConfig();
    const badKey = await authenticate("example/project").catch((error) => error);
    assert.match(badKey.message, /RSA privateKeyPath/);
    assert.ok(!badKey.message.includes("private-secret"));
    assert.equal(calls.length, 0);
    writeKey();
    rmSync(keyPath);
    invalidateConfig();
    await assert.rejects(authenticate("example/project"), /configuration/);
    assert.equal(calls.length, 0);
  `);
});

test("HTTP, transport, and malformed discovery failures are explicit and briefly cached without retries", async () => {
  await providerScenario(`
    for (const status of [401, 403, 429, 500]) {
      handler = async () => new Response("private-secret", { status });
      const before = calls.length;
      const failure = await authenticate("example/project").catch((error) => error);
      assert.ok(failure instanceof GithubAppError);
      assert.equal(failure.status, status);
      assert.equal(failure.installationId, undefined);
      assert.match(failure.message, new RegExp("HTTP " + status));
      assert.ok(!failure.message.includes("private-secret"));
      await Promise.all(Array.from({ length: 20 }, () =>
        assert.rejects(authenticate("example/project"), (error) => error === failure)));
      assert.equal(calls.length, before + 1);
      now += 30_001;
    }
    for (const value of [null, {}, { id: 0 }, { id: "11" }, { id: -1 }]) {
      handler = async () => Response.json(value);
      const before = calls.length;
      await assert.rejects(authenticate("example/project"), /invalid response/);
      await assert.rejects(authenticate("example/project"), /invalid response/);
      assert.equal(calls.length, before + 1);
      now += 30_001;
    }
    const routedFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error("private-secret transport"); };
    const failure = await authenticate("example/project").catch((error) => error);
    assert.ok(failure instanceof GithubAppError);
    assert.equal(failure.status, undefined);
    assert.equal(failure.message, "GitHub App authentication request failed or timed out.");
    await assert.rejects(authenticate("other/project"), (error) => error === failure);
    assert.equal(attempts, 1);
    globalThis.fetch = routedFetch;
    now += 30_001;
    const nativeTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      assert.equal(ms, 10_000);
      return AbortSignal.abort();
    };
    await assert.rejects(authenticate("example/project"), /failed or timed out/);
    AbortSignal.timeout = nativeTimeout;
    now += 30_001;
    handler = async (_request, path) => path.endsWith("/installation") ? Response.json({ id: 11 }) : tokenResponse();
    assert.ok(await authenticate("example/project"));
  `);
});

test("issuance failures and unusable tokens stay errors and are cached only briefly", async () => {
  await providerScenario(`
    let tokenHandler;
    handler = async (_request, path) => path.endsWith("/installation") ? Response.json({ id: 11 }) : tokenHandler();
    tokenHandler = () => new Response("private-secret", { status: 404 });
    const missing = await authenticate("example/project").catch((error) => error);
    assert.ok(missing instanceof GithubAppError);
    assert.equal(missing.status, 404);
    assert.equal(missing.installationId, 11);
    await assert.rejects(authenticate("example/project"), (error) => error === missing);
    assert.equal(calls.length, 2);
    now += 30_001;
    for (const value of [null, {}, { token: "fixture", expires_at: "invalid", permissions: {} },
      { token: "fixture", expires_at: new Date(now + 60_000).toISOString(), permissions: {} },
      { token: "fixture", expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 1 } },
      { token: "fixture", expires_at: new Date(now + 3_600_000).toISOString(), permissions: [] }]) {
      tokenHandler = () => Response.json(value);
      const before = calls.length;
      await assert.rejects(authenticate("example/project"), /invalid response|expiring token/);
      await assert.rejects(authenticate("example/project"), /invalid response|expiring token/);
      const discovery = calls.slice(before).filter((call) => call.path.endsWith("/installation")).length;
      assert.equal(calls.length, before + discovery + 1);
      now += 30_001;
    }
    tokenHandler = () => new Response("not JSON");
    await assert.rejects(authenticate("example/project"), /invalid response/);
    await assert.rejects(authenticate("example/project"), /invalid response/);
    now += 30_001;
    tokenHandler = () => tokenResponse();
    const recovered = await authenticate("example/project");
    assert.equal(recovered.identity, "app:12345:installation:11");
    assert.equal(calls.filter((call) => call.path.endsWith("/installation")).length, 2);
    assert.equal(tokens, 1);
  `);
});

test("provider errors retain sanitized quota headers and secondary-limit signals across the failure cache", async () => {
  await providerScenario(`
    const reset = String(Math.floor(now / 1000) + 3_600);
    const retryDate = new Date(now + 120_000).toUTCString();
    const cases = [
      { status: 403, body: "private-secret", headers: { "retry-after": "60" }, secondary: true, shared: true },
      { status: 429, body: "private-secret", headers: { "retry-after": retryDate }, secondary: true, shared: true },
      { status: 403, body: "private-secret: secondary rate limit", headers: {}, secondary: true, shared: true },
      { status: 403, body: "private-secret: abuse detection", headers: {}, secondary: true, shared: true },
      { status: 429, body: "private-secret", headers: {}, secondary: true, shared: true },
      { status: 429, body: "private-secret", headers: { "x-ratelimit-remaining": "0" }, secondary: false, shared: true },
      { status: 403, body: "private-secret", headers: { "x-ratelimit-remaining": "0" }, secondary: false, shared: true },
      { status: 401, body: "private-secret", headers: {}, secondary: false, shared: true },
      { status: 503, body: "private-secret", headers: {}, secondary: false, shared: true },
      { status: 403, body: "private-secret", headers: {}, secondary: false, shared: false },
    ];
    for (const scenario of cases) {
      const headers = {
        "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999", "x-ratelimit-used": "1", "x-ratelimit-reset": reset,
        "authorization": "Bearer private-secret", "x-unrelated-secret": "private-secret",
        ...scenario.headers,
      };
      handler = async () => new Response(scenario.body, { status: scenario.status, headers });
      const before = calls.length;
      const failure = await authenticate("example/project").catch((error) => error);
      assert.ok(failure instanceof GithubAppError);
      assert.equal(failure.status, scenario.status);
      assert.equal(failure.installationId, undefined);
      assert.equal(failure.secondaryRateLimited, scenario.secondary);
      for (const name of ["resource", "limit", "remaining", "used", "reset"]) {
        assert.equal(failure.headers.get("x-ratelimit-" + name), headers["x-ratelimit-" + name]);
      }
      assert.equal(failure.headers.get("retry-after"), scenario.headers["retry-after"] ?? null);
      assert.equal(failure.headers.get("authorization"), null);
      assert.equal(failure.headers.get("x-unrelated-secret"), null);
      assert.ok(!failure.message.includes("private-secret"));
      assert.ok(!JSON.stringify([...failure.headers]).includes("private-secret"));
      await assert.rejects(authenticate("example/project"), (error) => error === failure);
      if (scenario.shared) {
        await assert.rejects(authenticate("other/project"), (error) => error === failure);
      }
      assert.equal(calls.length, before + 1);
      now += 30_001;
    }
    handler = async () => new Response("private-secret", { status: 403, headers: {
      "retry-after": "private-secret", "x-ratelimit-resource": "private-secret /",
      "x-ratelimit-limit": "private-secret", "x-ratelimit-remaining": "-1",
      "x-ratelimit-used": "Infinity", "x-ratelimit-reset": "999999999999999999999999",
    } });
    const malformed = await authenticate("example/project").catch((error) => error);
    assert.ok(malformed instanceof GithubAppError);
    assert.equal(malformed.secondaryRateLimited, true);
    assert.deepEqual([...malformed.headers], []);
    now += 30_001;
    handler = async (_request, path) => path.endsWith("/installation")
      ? Response.json({ id: 11 })
      : new Response("private-secret", { status: 403, headers: {
        "retry-after": "90", "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999",
      } });
    const issuance = await authenticate("example/project").catch((error) => error);
    assert.ok(issuance instanceof GithubAppError);
    assert.equal(issuance.status, 403);
    assert.equal(issuance.installationId, 11);
    assert.equal(issuance.secondaryRateLimited, true);
    assert.equal(issuance.headers.get("retry-after"), "90");
    assert.equal(issuance.headers.get("x-ratelimit-remaining"), "4999");
  `);
});

test("issuance 403 and 404 evict every stale repository mapping before uninstall rediscovery", async () => {
  for (const status of [403, 404]) {
    await providerScenario(`
      const first = await authenticate("example/project");
      assert.equal((await authenticate("example/another")).identity, first.identity);
      const other = await authenticate("other/project");
      invalidate(first.identity);
      handler = async (_request, path) => {
        assert.ok(path.endsWith("/access_tokens"));
        return new Response("private-secret", { status: ${status} });
      };
      const failure = await authenticate("example/project").catch((error) => error);
      assert.ok(failure instanceof GithubAppError);
      assert.equal(failure.status, ${status});
      assert.equal(failure.installationId, 11);
      const afterFailure = calls.length;
      await assert.rejects(authenticate("example/project"), (error) => error === failure);
      await assert.rejects(authenticate("example/another"), (error) => error === failure);
      assert.equal((await authenticate("other/project")).token, other.token);
      assert.equal(calls.length, afterFailure);
      handler = async (_request, path) => {
        assert.ok(path.endsWith("/installation"));
        return new Response("not installed", { status: 404 });
      };
      now += 30_001;
      assert.equal(await authenticate("example/project"), null);
      assert.equal(await authenticate("example/another"), null);
      assert.equal(calls.length, afterFailure + 2);
      assert.equal(tokens, 2);
      assert.equal(calls.filter((call) => call.path === "/app/installations/11/access_tokens").length, 2);
      now += 60_001;
      handler = async (_request, path) => path.endsWith("/installation") ? Response.json({ id: 33 }) : tokenResponse();
      const reinstalled = await authenticate("example/project");
      assert.equal(reinstalled.identity, "app:12345:installation:33");
      assert.equal(tokens, 3);
    `);
  }
});

test("an invalidated in-flight issuance failure cannot evict a newer successful token or discovery", async () => {
  await providerScenario(`
    const first = await authenticate("example/project");
    invalidate(first.identity);
    const { promise: started, resolve: oldStarted } = Promise.withResolvers();
    const { promise: oldGate, resolve: releaseOld } = Promise.withResolvers();
    let issuance = 0;
    handler = async (_request, path) => {
      assert.ok(path.endsWith("/access_tokens"));
      if (++issuance === 1) {
        oldStarted();
        await oldGate;
        return new Response("private-secret", { status: 404 });
      }
      return tokenResponse();
    };
    const old = authenticate("example/project");
    const rejected = assert.rejects(old, (error) => error instanceof GithubAppError && error.status === 404);
    await started;
    invalidate(first.identity);
    const fresh = await authenticate("example/project");
    releaseOld();
    await rejected;
    assert.equal((await authenticate("example/project")).token, fresh.token);
    assert.equal(calls.filter((call) => call.path.endsWith("/installation")).length, 1);
    assert.equal(tokens, 2);
  `);
});
