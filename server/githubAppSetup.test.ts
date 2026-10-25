import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setupUrl = new URL("./githubAppSetup.ts", import.meta.url).href;
const serverUrl = new URL("./cockpitServer.ts", import.meta.url).href;

test("nonce-launched browser-bound app registration stores credentials once and returns cleanly after installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cockpit-app-setup-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import assert from "node:assert/strict";
      import { generateKeyPairSync, createPrivateKey } from "node:crypto";
      import { readFile, stat, access, writeFile, unlink } from "node:fs/promises";
      import { handleGithubAppSetup } from ${JSON.stringify(setupUrl)};
      import { startCockpitServer } from ${JSON.stringify(serverUrl)};
      const configPath = process.env.COCKPIT_GITHUB_APP_CONFIG;
      const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = keys.privateKey.export({ type: "pkcs1", format: "pem" });
      const rendererOrigin = "https://cockpit.example";
      let exchanges = 0;
      let rejectConversion = false;
      const github = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        assert.equal(request.method, "POST");
        assert.equal(new URL(request.url).pathname, "/app-manifests/fixture-code/conversions");
        exchanges++;
        return rejectConversion ? new Response("rejected", { status: 422 })
          : Response.json({ id: 123, name: "Fixture Cockpit", slug: "fixture-cockpit", pem });
      } });
      const server = startCockpitServer(0, handleGithubAppSetup, rendererOrigin);
      const nativeFetch = globalThis.fetch;
      // Both browser and GitHub requests still cross actual HTTP listeners; no real GitHub calls.
      globalThis.fetch = (input, init) => {
        const target = new URL(String(input));
        const base = target.origin === "https://api.github.com" ? github.url
          : target.origin === rendererOrigin ? server.url : null;
        return nativeFetch(base ? new URL(target.pathname + target.search, base) : target, init);
      };
      const path = "/api/github-app/quota";
      const url = (suffix = "") => new URL(path + suffix, server.url);
      let now = Date.now();
      Date.now = () => now;
      const post = (owner = "acme-org", origin = rendererOrigin) => fetch(url("/start"), {
        method: "POST", headers: { origin }, body: new URLSearchParams({ owner }),
      });
      async function mint(owner = "acme-org") {
        const response = await post(owner);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const external = new URL((await response.json()).url);
        assert.equal(external.origin, rendererOrigin);
        assert.equal(external.pathname, path + "/start");
        assert.match(external.searchParams.get("nonce"), /^[a-f0-9]{64}$/);
        assert.deepEqual([...external.searchParams.keys()], ["nonce"]);
        return external;
      }
      async function launch(external, owner = "acme-org") {
        const response = await fetch(external);
        assert.equal(response.status, 200);
        const cookie = response.headers.get("set-cookie");
        assert.ok(cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"));
        assert.ok(cookie.includes("Path=" + path + "/callback") && cookie.includes("Max-Age=3600"));
        const body = await response.text();
        assert.ok(!body.includes(pem));
        const registration = new URL(body.match(/action="([^"]+)"/)[1]);
        assert.equal(registration.origin, "https://github.com");
        assert.equal(registration.pathname, owner ? "/organizations/" + owner + "/settings/apps/new" : "/settings/apps/new");
        const state = registration.searchParams.get("state");
        assert.match(state, /^[a-f0-9]{64}$/);
        const cookiePair = cookie.split(";")[0];
        assert.notEqual(cookiePair.split("=")[1], state);
        assert.notEqual(state, external.searchParams.get("nonce"));
        const manifest = JSON.parse(body.match(/name="manifest" value="([^"]+)"/)[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
        assert.equal(manifest.redirect_url, rendererOrigin + path + "/callback");
        assert.equal(manifest.setup_url, rendererOrigin + path + "/installed");
        assert.equal(new URL(manifest.setup_url).hash, "");
        assert.equal(manifest.public, false);
        assert.deepEqual(manifest.default_events, []);
        assert.ok(Object.values(manifest.default_permissions).every(value => value === "read"));
        return { state, cookie: cookiePair, manifest };
      }
      const start = async (owner = "acme-org") => launch(await mint(owner), owner);
      const callback = (state, cookie, code = "fixture-code") => fetch(url("/callback?state=" + state + (code ? "&code=" + code : "")), {
        redirect: "manual", headers: cookie ? { cookie } : {},
      });
      try {
        assert.deepEqual(await (await fetch(url())).json(), { app: null });
        assert.equal((await post("acme-org", "https://untrusted.example")).status, 403);
        assert.equal((await post("invalid/owner")).status, 400);
        assert.equal((await fetch(url("/start"))).status, 400);
        assert.equal((await fetch(url("/start?nonce=unminted"))).status, 400);
        assert.equal(exchanges, 0);

        const expiredLaunch = await mint();
        now += 300_001;
        const expired = await fetch(expiredLaunch);
        assert.equal(expired.status, 400);
        assert.equal(expired.headers.get("set-cookie"), null);
        const external = await mint();
        let first = await launch(external);
        const replayed = await fetch(external);
        assert.equal(replayed.status, 400);
        assert.equal(replayed.headers.get("set-cookie"), null);
        let second = await start("");
        assert.notEqual(first.state, second.state);
        assert.notEqual(first.cookie.split("=")[0], second.cookie.split("=")[0]);
        assert.equal((await callback("wrong", first.cookie)).status, 400);
        assert.equal((await callback(first.state, null)).status, 400);
        assert.equal((await callback(first.state, second.cookie)).status, 400);
        assert.equal((await callback(first.state, first.cookie.split("=")[0] + "=" + first.state)).status, 400);
        assert.equal((await callback(first.state, first.cookie, "")).status, 400);
        assert.equal(exchanges, 0);
        await assert.rejects(access(configPath));
        now += 3_600_001;
        assert.equal((await callback(first.state, first.cookie)).status, 400);
        assert.equal((await callback(second.state, second.cookie)).status, 400);
        assert.equal(exchanges, 0);

        first = await start();
        second = await start("");
        const waitingLaunch = await mint();
        rejectConversion = true;
        assert.equal((await callback(first.state, first.cookie)).status, 502);
        assert.equal((await callback(first.state, first.cookie)).status, 400);
        assert.equal(exchanges, 1);
        await assert.rejects(access(configPath));
        rejectConversion = false;
        // Failing one flow must not replace or consume another browser's active flow.
        const connected = await callback(second.state, second.cookie);
        assert.equal(connected.status, 303);
        assert.equal(connected.headers.get("location"), "https://github.com/apps/fixture-cockpit/installations/new");
        assert.ok(connected.headers.get("set-cookie").startsWith(second.cookie.split("=")[0] + "=;"));
        assert.ok(connected.headers.get("set-cookie").includes("Max-Age=0"));
        const configText = await readFile(configPath, "utf8");
        const config = JSON.parse(configText);
        assert.equal(config.appId, "123");
        assert.equal((await stat(configPath)).mode & 0o777, 0o600);
        assert.equal((await stat(config.privateKeyPath)).mode & 0o777, 0o600);
        const saved = createPrivateKey(await readFile(config.privateKeyPath));
        assert.equal(saved.export({ type: "pkcs1", format: "pem" }), pem);
        const publicResponse = await fetch(url());
        const publicText = await publicResponse.text();
        assert.ok(!publicText.includes(pem) && !publicText.includes(config.privateKeyPath));
        assert.deepEqual(JSON.parse(publicText), { app: {
          name: "Fixture Cockpit", installUrl: "https://github.com/apps/fixture-cockpit/installations/new",
        } });
        assert.equal((await callback(second.state, second.cookie)).status, 400);
        assert.equal(exchanges, 2);
        assert.equal((await post()).status, 409);
        assert.equal((await fetch(waitingLaunch)).status, 409);
        assert.equal((await fetch(waitingLaunch)).status, 400);
        assert.equal(await readFile(configPath, "utf8"), configText);
        const installed = new URL(second.manifest.setup_url);
        installed.search = "installation_id=456&setup_action=install";
        const returned = await fetch(installed, { redirect: "manual" });
        assert.equal(returned.status, 303);
        assert.equal(returned.headers.get("location"), "/#/settings");

        await unlink(configPath);
        first = await start();
        await writeFile(configPath, configText);
        assert.equal((await callback(first.state, first.cookie)).status, 409);
        assert.equal(exchanges, 2);
        assert.equal(await readFile(configPath, "utf8"), configText);
        await unlink(configPath);
        first = await start();
        assert.equal((await callback(first.state, first.cookie)).status, 502);
        assert.equal(exchanges, 3);
        await assert.rejects(access(configPath));
        assert.equal(await readFile(config.privateKeyPath, "utf8"), pem);

        // Bounded pending launches reject excess work rather than evicting an active launch.
        now += 3_600_001;
        const queued = [];
        for (let index = 0; index < 16; index++) queued.push(await mint());
        assert.equal((await post()).status, 429);
        await launch(queued[0]);
        now += 300_001;
        assert.equal((await fetch(queued[1])).status, 400);
        await mint("");
        console.log(JSON.stringify({ nonceReplayBlocked: true, nonceExpiry: true, browserBound: true, independentFlows: true, privateFiles: true, existingCredentialsPreserved: true, cleanInstallReturn: true, boundedLaunches: true }));
      } finally {
        server.stop(true);
        github.stop(true);
      }
    `], { env: { ...process.env, HOME: root, COCKPIT_GITHUB_APP_CONFIG: join(root, "github-app.json") }, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
