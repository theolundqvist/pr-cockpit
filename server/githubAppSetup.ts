import { createPrivateKey, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { githubAppConfigPath, invalidateGithubAppConfig } from "./githubApp.ts";
import { githubAppReadHealth, type GithubAppReadHealth } from "./github.ts";

const SETUP_PATH = "/api/github-app/quota";
const COOKIE = "cockpit_quota_app_setup";
const READ_PERMISSIONS = { actions: "read", checks: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read", statuses: "read" };
const LAUNCH_TTL_MS = 5 * 60_000;
const SETUP_TTL_MS = 60 * 60_000;
const MAX_PENDING = 16;
const launches = new Map<string, { owner: string; origin: string; configPath: string; expiresAt: number }>();
const pending = new Map<string, { browserToken: string; expiresAt: number; configPath: string }>();

function expirePending(): void {
  const now = Date.now();
  for (const [nonce, launch] of launches) if (launch.expiresAt <= now) launches.delete(nonce);
  for (const [state, setup] of pending) if (setup.expiresAt <= now) pending.delete(state);
}

function setupCookie(state: string): string {
  // Separate cookies let independent browser flows finish without replacing each other.
  return `${COOKIE}_${state}`;
}

function page(message: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>GitHub App setup</title><p>${escapeHtml(message)}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function configuredApp(): Promise<{ name: string; installUrl: string | null; health: GithubAppReadHealth } | null> {
  let text: string;
  try { text = await readFile(githubAppConfigPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("GitHub App configuration could not be read.");
  }
  const config = JSON.parse(text) as { appId?: unknown; name?: unknown; slug?: unknown };
  return {
    name: typeof config.name === "string" ? config.name : "GitHub App",
    installUrl: typeof config.slug === "string" && /^[a-z0-9-]+$/.test(config.slug)
      ? `https://github.com/apps/${config.slug}/installations/new` : null,
    health: githubAppReadHealth(typeof config.appId === "string" ? config.appId : null),
  };
}

async function storeCredentials(path: string, app: { id: number; name: string; slug: string; pem: string }): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, `github-app-${app.id}.pem`);
  const key = await open(keyPath, "wx", 0o600);
  try { await key.writeFile(app.pem); await key.sync(); }
  catch (error) { await unlink(keyPath); throw error; }
  finally { await key.close(); }
  const temporaryPath = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      await temporary.writeFile(JSON.stringify({ appId: String(app.id), privateKeyPath: keyPath, name: app.name, slug: app.slug }));
      await temporary.sync();
    } finally { await temporary.close(); }
    // Publish atomically without overwriting credentials installed by another setup.
    await link(temporaryPath, path);
  } catch (error) {
    await unlink(keyPath);
    throw error;
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function handleGithubAppSetup(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === SETUP_PATH && request.method === "GET") {
      return Response.json({ app: await configuredApp() }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === `${SETUP_PATH}/start` && request.method === "POST") {
      if (await configuredApp()) return page("An app is already configured. Manage its repository access from Settings.", 409);
      const owner = String((await request.formData()).get("owner") ?? "");
      if (owner && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner)) return page("Choose a valid GitHub organization.", 400);
      const origin = new URL(request.headers.get("origin") || url.origin).origin;
      if (!/^https?:\/\//.test(origin)) return page("Open setup from Cockpit Settings.", 400);
      expirePending();
      if (launches.size >= MAX_PENDING) return page("Too many setup links are waiting. Finish a setup or try again in a few minutes.", 429);
      const nonce = randomBytes(32).toString("hex");
      launches.set(nonce, { owner, origin, configPath: githubAppConfigPath(), expiresAt: Date.now() + LAUNCH_TTL_MS });
      return Response.json({ url: `${origin}${SETUP_PATH}/start?nonce=${nonce}` }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === `${SETUP_PATH}/start` && request.method === "GET") {
      expirePending();
      const nonce = url.searchParams.get("nonce") ?? "";
      const launch = launches.get(nonce);
      if (!launch) return page("This setup link has expired or was already opened. Start again from Cockpit Settings.", 400);
      // Consume before the first await so simultaneous opens cannot reuse a launch.
      launches.delete(nonce);
      if (launch.configPath !== githubAppConfigPath() || await configuredApp()) {
        return page("App configuration changed during setup. Open Cockpit Settings to continue.", 409);
      }
      if (pending.size >= MAX_PENDING) return page("Too many setups are waiting. Finish a setup or try again later.", 429);
      const state = randomBytes(32).toString("hex");
      const browserToken = randomBytes(32).toString("hex");
      pending.set(state, { browserToken, expiresAt: Date.now() + SETUP_TTL_MS, configPath: launch.configPath });
      const manifest = {
        name: `PR Cockpit ${randomBytes(4).toString("hex")}`,
        url: "https://github.com/theolundqvist/pr-cockpit",
        public: false,
        redirect_url: `${launch.origin}${SETUP_PATH}/callback`,
        setup_url: `${launch.origin}${SETUP_PATH}/installed`,
        default_permissions: READ_PERMISSIONS,
        default_events: [],
      };
      const registration = launch.owner ? `https://github.com/organizations/${encodeURIComponent(launch.owner)}/settings/apps/new` : "https://github.com/settings/apps/new";
      return new Response(`<!doctype html><meta charset="utf-8"><title>Connect GitHub App</title><form method="post" action="${registration}?state=${state}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form><script>document.forms[0].submit()</script>`, {
        headers: {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
          "set-cookie": `${setupCookie(state)}=${browserToken}; HttpOnly; SameSite=Lax; Path=${SETUP_PATH}/callback; Max-Age=3600${launch.origin.startsWith("https:") ? "; Secure" : ""}`,
        },
      });
    }
    if (url.pathname === `${SETUP_PATH}/callback` && request.method === "GET") {
      expirePending();
      const state = url.searchParams.get("state") ?? "";
      const setup = pending.get(state);
      const code = url.searchParams.get("code");
      const cookiePrefix = `${setupCookie(state)}=`;
      const browserToken = request.headers.get("cookie")?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(cookiePrefix))?.slice(cookiePrefix.length);
      if (!setup || browserToken !== setup.browserToken || !code) {
        return page("This setup link has expired or belongs to another browser. Start again from Cockpit Settings.", 400);
      }
      pending.delete(state);
      if (setup.configPath !== githubAppConfigPath() || await configuredApp()) return page("App configuration changed during setup. Open Cockpit Settings to continue.", 409);
      const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST", headers: { Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) { await response.body?.cancel(); return page("GitHub could not complete app registration. Start again from Cockpit Settings.", 502); }
      const app = await response.json() as { id: number; name: string; slug: string; pem: string };
      if (!Number.isSafeInteger(app.id) || app.id <= 0 || typeof app.name !== "string" || typeof app.slug !== "string" || !/^[a-z0-9-]+$/.test(app.slug) || typeof app.pem !== "string" || createPrivateKey(app.pem).asymmetricKeyType !== "rsa") {
        return page("GitHub returned an invalid app registration.", 502);
      }
      await storeCredentials(setup.configPath, app);
      invalidateGithubAppConfig();
      return new Response(null, { status: 303, headers: {
        location: `https://github.com/apps/${app.slug}/installations/new`, "cache-control": "no-store", "referrer-policy": "no-referrer",
        "set-cookie": `${setupCookie(state)}=; HttpOnly; SameSite=Lax; Path=${SETUP_PATH}/callback; Max-Age=0`,
      } });
    }
    if (url.pathname === `${SETUP_PATH}/installed` && request.method === "GET") {
      // GitHub appends installation query parameters here, not inside the UI hash route.
      return new Response(null, { status: 303, headers: { location: "/#/settings", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    return page("Not found.", 404);
  } catch {
    return page("GitHub App setup could not complete. Check that Cockpit can reach GitHub and write its local configuration.", 502);
  }
}
