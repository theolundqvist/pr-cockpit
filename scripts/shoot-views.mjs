import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { mockAvatarSvg } from "../server/mockImages.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXED_NOW = Date.parse("2026-07-15T10:00:00.000Z");
const DEFAULT_SIZES = ["1440x900", "2560x1440", "1100x800"];
const DEFAULT_OUT = "artifacts/views";
const REPO = "fixture/cockpit";

function mockAvatarLogin(url) {
  if (url.host !== "github.com") return null;
  return url.pathname.match(/^\/([^/]+)\.png$/)?.[1] ?? null;
}

const scenarios = [
  {
    name: "inbox-populated",
    route: "#/",
    description: "Populated inbox with mixed ownership, CI, review, and merge states.",
    ready: ".inbox-layout .queue-group",
    verify: async (page) => page.locator(".current-branch-badge").getByText("current", { exact: true }).waitFor(),
  },
  {
    name: "inbox-empty",
    route: "#/",
    description: "Inbox after every active fixture PR has been archived.",
    prepare: archiveActivePrs,
    ready: ".inbox-layout",
    verify: async (page) => page.getByText("No open pull requests", { exact: true }).waitFor(),
  },
  {
    name: "inbox-error",
    route: "#/",
    description: "Inbox error state after its API request fails.",
    beforeGoto: async (page) => page.route("**/api/inbox", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture inbox failure" }) })),
    ready: ".inbox-layout .empty",
    verify: async (page) => page.getByText("Error: inbox 500", { exact: true }).waitFor(),
  },
  {
    name: "inbox-archived",
    route: "#/",
    description: "Inbox with the archived queue expanded, including a closed PR.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.keyboard.press("Shift+A");
      await page.locator(".archived-group .row").first().waitFor();
    },
  },
  {
    ...detail("detail-conversation", 101, "Green PR conversation with approvals, threads, comments, and successful checks."),
    verify: async (page) => page.locator(".current-branch-badge").getByText("current", { exact: true }).waitFor(),
  },
  {
    ...detail("detail-title-rename", 101, "Inline pull request title rename with its queued optimistic state."),
    beforeGoto: async (page) => {
      let submitted = false;
      await page.route("**/api/mutations**", async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          const expected = { repo: REPO, number: 101, payload: { kind: "edit-title", title: "Ship the rename feature" } };
          if (JSON.stringify(body) !== JSON.stringify(expected)) throw new Error(`unexpected rename payload: ${JSON.stringify(body)}`);
          submitted = true;
          return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: 9_001 }) });
        }
        const mutations = submitted
          ? [{ id: 9_001, repo: REPO, number: 101, kind: "edit-title", payload: { kind: "edit-title", title: "Ship the rename feature" }, state: "pending", error: null, createdAt: new Date(FIXED_NOW).toISOString() }]
          : [];
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mutations }) });
      });
    },
    interact: async (page) => {
      await page.getByRole("button", { name: "Rename pull request", exact: true }).click();
      const input = page.getByRole("textbox", { name: "Pull request title", exact: true });
      await input.fill("Ship the rename feature");
      await input.press("Enter");
    },
    verify: async (page) => {
      await page.getByRole("heading", { name: "Ship the rename feature", exact: true }).waitFor();
      await page.getByText("SAVING…", { exact: true }).waitFor();
    },
  },
  detail("detail-conversation-blocked", 102, "PR blocked by branch protection without an admin bypass."),
  {
    ...detail("detail-conversation-blocked-admin", 112, "Branch-protection block with the admin force-merge confirmation visible.", "fixture/admin-cockpit"),
    interact: async (page) => {
      await page.keyboard.press("Shift+M");
      await page.locator(".force-confirm").waitFor();
    },
  },
  {
    ...detail("detail-conversation-conflicts", 103, "PR with exact conflict paths and an agent resolution action."),
    ready: ".conflict-alert",
    verify: async (page) => {
      const paths = await page.locator(".conflict-file-list li").allTextContents();
      const expected = ["ui/navigation.ts", "ui/src/lib/router/state.ts", "server/navigation.ts"];
      if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`unexpected conflict paths: ${JSON.stringify(paths)}`);
      await page.locator(".conflict-alert").getByRole("button", { name: "Copy fix prompt", exact: true }).waitFor();
      await page.locator(".conflict-alert").getByRole("button", { name: "Fix with agent", exact: true }).waitFor();
    },
  },
  {
    ...detail("detail-unstable", 104, "UNSTABLE PR with failing non-required checks."),
    ready: ".ci-failure-alert",
    verify: async (page) => {
      await page.locator(".ci-failure-list").getByText("CI / preview deploy", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Open logs ↗", exact: true }).waitFor();
      await page.getByRole("button", { name: "Copy fix prompt", exact: true }).waitFor();
      await page.getByRole("button", { name: "Fix with agent", exact: true }).waitFor();
    },
  },
  detail("detail-draft", 105, "Draft PR conversation."),
  detail("detail-merged", 106, "Merged PR conversation."),
  detail("detail-closed", 111, "Closed PR conversation from the archived fixture set."),
  detail("detail-no-checks", 113, "Open PR with no checks, no description, and no changed files."),
  detail("detail-checks-pending", 114, "PR with queued and in-progress required checks."),
  {
    name: "detail-files",
    route: `#/pr/${REPO}/101/files`,
    description: "Files tab with an ordinary three-file diff and inline threads.",
    ready: ".files-layout .diff",
  },
  {
    name: "detail-files-large-diff",
    route: `#/pr/${REPO}/107/files`,
    description: "Files tab with 50+ files, binary and renamed files, and a giant single-file diff.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      await page.locator(".tree .file").filter({ hasText: "client.ts" }).click();
      const client = page.locator(".diff .file").filter({ hasText: "src/generated/client.ts" });
      const header = client.locator(".file-head-row");
      await header.getByText("+701", { exact: true }).waitFor();
      await client.locator(".hunks").waitFor();
      await header.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "detail-files-empty",
    route: `#/pr/${REPO}/113/files`,
    description: "Zero-file PR showing the empty diff state.",
    ready: ".files-layout .diff-status",
    verify: async (page) => page.getByText("no changes in this range.", { exact: true }).waitFor(),
  },
  {
    name: "detail-files-error",
    route: `#/pr/${REPO}/101/files`,
    description: "Files tab after its diff request fails, with retry visible.",
    beforeGoto: async (page) => page.route((url) => url.pathname === "/api/pr/fixture/cockpit/101/diff", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "fixture diff failure" })),
    ready: ".files-layout .diff-status",
    verify: async (page) => {
      const retry = page.getByRole("button", { name: "retry", exact: true });
      await retry.waitFor();
      const status = await page.locator(".diff-status").innerText();
      if (!status.includes("couldn't load this diff.")) throw new Error(`unexpected diff error state: ${status}`);
    },
  },
  {
    name: "detail-file-history",
    route: `#/pr/${REPO}/101/files`,
    description: "Base-branch history and diff for a selected file.",
    ready: ".files-layout .tree .file",
    interact: async (page) => {
      await page.locator(".tree .file").first().click();
      await page.keyboard.press("h");
      await page.locator(".fh-view .fh-row").first().waitFor();
      await page.locator(".fh-detail").waitFor();
    },
  },
  {
    name: "detail-agents",
    route: `#/pr/${REPO}/110/agents`,
    description: "Agents tab with completed, failed, killed, and running fixture runs.",
    ready: ".agents-layout .run-row",
    interact: async (page) => {
      await page.locator(".run-row").first().click();
      await page.locator(".run-detail-head").waitFor();
    },
  },
  {
    name: "detail-agents-empty",
    route: `#/pr/${REPO}/101/agents`,
    description: "Agents tab before any runs exist.",
    ready: ".agents-layout",
    verify: async (page) => page.getByText("no agent runs yet", { exact: true }).waitFor(),
  },
  {
    ...detail("detail-long-markdown", 108, "Huge Markdown description with a table, code block, and embedded image."),
    ready: ".body-card .md",
  },
  {
    ...detail("detail-failed-mutation", 109, "Failed mutation with retry and discard actions."),
    verify: async (page) => {
      const failed = page.getByText("FAILED", { exact: true }).first();
      await failed.waitFor();
      await page.getByRole("button", { name: "retry", exact: true }).first().waitFor();
      await page.getByRole("button", { name: "discard", exact: true }).first().waitFor();
      await failed.scrollIntoViewIfNeeded();
    },
  },
  {
    ...detail("detail-pending-mutation", 114, "Pending comment mutation rendered alongside queued CI."),
    verify: async (page) => {
      const pending = page.getByText("POSTING…", { exact: true }).first();
      await pending.waitFor();
      await pending.scrollIntoViewIfNeeded();
    },
  },
  settings("settings", "General settings and workspace configuration.", "General"),
  settings("settings-keybinds", "Global and in-app keyboard shortcuts.", "Keybinds"),
  settings("settings-agents", "Built-in and custom agent configuration.", "Agents"),
  settings("settings-diff-tests", "Diff rendering and test-file preferences.", "Diff / Tests"),
  {
    name: "palette",
    route: "#/",
    description: "PR jump palette populated from the fixture inbox and index.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.getByRole("button", { name: "Find a PR" }).first().click();
      await page.locator(".palette .palette-result").first().waitFor();
    },
  },
  {
    name: "palette-standalone",
    route: "#/palette",
    description: "Standalone PR search palette opened outside the dashboard shell.",
    ready: ".palette.standalone .palette-result",
  },
  {
    name: "cheatsheet",
    route: "#/",
    description: "Keyboard shortcuts overlay.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.keyboard.press("?");
      await page.locator(".sheet").waitFor();
    },
  },
  {
    name: "onboarding",
    route: "#/",
    description: "First-run repository picker.",
    prepare: clearConfiguredRepos,
    ready: ".onb-page .repo-list",
  },
  {
    name: "detail-not-found",
    route: `#/pr/${REPO}/999`,
    description: "Stable detail error for a PR absent from the fixture set.",
    ready: ".page .load",
    verify: async (page) => {
      const text = await page.locator(".page .load").innerText();
      if (text === "Loading…") throw new Error("detail error never replaced its loading state");
    },
  },
];

function detail(name, number, description, repo = REPO) {
  return { name, route: `#/pr/${repo}/${number}`, description, ready: ".page .detail" };
}

function settings(name, description, tab) {
  return {
    name,
    route: "#/settings",
    description,
    ready: ".settings-panel",
    interact: tab === "General" ? undefined : async (page) => {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await page.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected").then((value) => {
        if (value !== "true") throw new Error(`${tab} settings tab did not activate`);
      });
    },
  };
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, filter: "", sizes: DEFAULT_SIZES, themes: ["light", "dark"] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--out") options.out = value;
    else if (arg === "--filter") options.filter = value;
    else if (arg === "--sizes") options.sizes = value.split(",").map((size) => size.trim()).filter(Boolean);
    else if (arg === "--theme") {
      if (!new Set(["light", "dark", "both"]).has(value)) throw new Error("--theme must be light, dark, or both");
      options.themes = value === "both" ? ["light", "dark"] : [value];
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.sizes.length) throw new Error("--sizes must include at least one WIDTHxHEIGHT value");
  options.viewports = options.sizes.map((label) => {
    const match = label.match(/^(\d+)x(\d+)$/);
    if (!match) throw new Error(`invalid size: ${label}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 320 || height < 240) throw new Error(`size is too small: ${label}`);
    return { label, width, height };
  });
  options.out = resolve(ROOT, options.out);
  return options;
}

function usage() {
  console.log(`Usage: bun scripts/shoot-views.mjs [options]

  --out DIR                 Output directory (default: ${DEFAULT_OUT})
  --filter substring        Shoot scenario names containing substring
  --sizes WxH,WxH           Viewports (default: ${DEFAULT_SIZES.join(",")})
  --theme light|dark|both   Color theme (default: both)`);
}

async function validateStatic() {
  const indexPath = join(ROOT, "static", "index.html");
  const missing = `Static UI is missing or stale. Run \`cd ui && bun run build\` before the screenshot harness.`;
  try {
    await access(indexPath);
    const html = await readFile(indexPath, "utf8");
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((path) => path.startsWith("/assets/"));
    if (!assets.length) throw new Error(missing);
    await Promise.all(assets.map((path) => access(join(ROOT, "static", path))));
    if (!(await readdir(join(ROOT, "static", "assets"))).length) throw new Error(missing);
  } catch (error) {
    if (error.message === missing) throw error;
    throw new Error(missing, { cause: error });
  }
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function collect(stream, lines) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    lines.push(...decoder.decode(value, { stream: true }).split("\n").filter(Boolean));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  }
}

async function waitForServer(process, baseURL, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const exited = await Promise.race([process.exited.then((code) => ({ code })), delay(75).then(() => null)]);
    if (exited) throw new Error(`server exited with code ${exited.code}\n${logs.join("\n")}`);
    try {
      const response = await fetch(`${baseURL}/api/settings`);
      if (response.ok) return;
    } catch {}
  }
  throw new Error(`server did not become ready within 15s\n${logs.join("\n")}`);
}

async function stopServer(process) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const stopped = await Promise.race([process.exited.then(() => true), delay(2_000).then(() => false)]);
  if (!stopped) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function setArchived(baseURL, rows, archived) {
  const results = await Promise.allSettled(rows.map((row) => requestJson(`${baseURL}/api/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: row.repo, number: row.number, archived }),
  })));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), `could not ${archived ? "archive" : "restore"} ${failures.length} PRs`);
}

async function archiveActivePrs({ baseURL }) {
  const { prs } = await requestJson(`${baseURL}/api/inbox`);
  await setArchived(baseURL, prs, true);
  return () => setArchived(baseURL, prs, false);
}

async function clearConfiguredRepos({ baseURL }) {
  const settings = await requestJson(`${baseURL}/api/settings`);
  await requestJson(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repos: "" }),
  });
  return () => requestJson(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repos: settings.repos, default_repo: settings.default_repo }),
  });
}

async function settle(page, theme) {
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.complete
      ? undefined
      : new Promise((done) => {
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        })));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

function inspectPng(buffer, expectedWidth, expectedHeight) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("screenshot is not a PNG");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (width !== expectedWidth || height !== expectedHeight) throw new Error(`PNG is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`);
  if (bitDepth !== 8 || !new Set([2, 6]).has(colorType) || interlace !== 0) throw new Error(`unsupported PNG format: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  let previous = Buffer.alloc(stride);
  let position = 0;
  let darkest = 255;
  let lightest = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++];
    const row = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[position++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = value + left;
      else if (filter === 2) row[x] = value + up;
      else if (filter === 3) row[x] = value + Math.floor((left + up) / 2);
      else if (filter === 4) row[x] = value + paeth(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter: ${filter}`);
    }
    for (let x = 0; x < stride; x += channels * Math.max(1, Math.floor(width / 200))) {
      const lightness = Math.round((row[x] + row[x + 1] + row[x + 2]) / 3);
      darkest = Math.min(darkest, lightness);
      lightest = Math.max(lightest, lightness);
    }
    previous = row;
  }
  if (lightest - darkest < 8) throw new Error(`PNG appears blank: sampled pixel range is ${darkest}–${lightest}`);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function clearManifestScreenshots(out) {
  const manifestPath = join(out, "manifest.json");
  let previous;
  try {
    previous = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    await rm(manifestPath, { force: true });
    return;
  }

  const realOut = await realpath(out);
  const entries = previous && typeof previous === "object" ? Object.values(previous) : [];
  const files = new Set(entries.flatMap((entry) => Array.isArray(entry?.files) ? entry.files : []));
  for (const file of files) {
    if (typeof file !== "string" || isAbsolute(file) || normalize(file) !== file || !file.endsWith(".png")) continue;
    const target = resolve(out, file);
    let realTarget;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const fromOut = relative(realOut, realTarget);
    if (!fromOut || fromOut === ".." || fromOut.startsWith(`..${sep}`) || isAbsolute(fromOut)) continue;
    await rm(target);
  }
  await rm(manifestPath, { force: true });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  await validateStatic();
  const selected = scenarios.filter((scenario) => scenario.name.includes(options.filter));
  if (!selected.length) throw new Error(`no scenarios match --filter ${JSON.stringify(options.filter)}`);
  await clearManifestScreenshots(options.out);

  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-shots-"));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const server = Bun.spawn([process.execPath, "server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_PORT: String(port),
      COCKPIT_MOCK: "1",
      COCKPIT_REPO_ROOTS: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const outputDone = Promise.allSettled([collect(server.stdout, logs), collect(server.stderr, logs)]);
  let browser;
  const failures = [];
  const manifest = {};
  const summary = selected.map((scenario) => ({ scenario: scenario.name, route: scenario.route, shots: 0, localAvatars: 0, status: "ok" }));

  try {
    await waitForServer(server, baseURL, logs);
    browser = await chromium.launch({ headless: true });
    for (const viewport of options.viewports) {
      for (const theme of options.themes) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await context.addInitScript((now) => {
          Date.now = () => now;
        }, FIXED_NOW);
        const externalRequests = [];
        const localAvatarRequests = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          const avatarLogin = mockAvatarLogin(url);
          if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === baseURL) await route.continue();
          else if (avatarLogin) {
            localAvatarRequests.push(url.href);
            await route.fulfill({ status: 200, contentType: "image/svg+xml", body: mockAvatarSvg(avatarLogin) });
          }
          else {
            externalRequests.push(url.href);
            await route.abort("blockedbyclient");
          }
        });

        for (let index = 0; index < selected.length; index++) {
          const scenario = selected[index];
          const row = summary[index];
          externalRequests.length = 0;
          localAvatarRequests.length = 0;
          const page = await context.newPage();
          const pageErrors = [];
          page.on("pageerror", (error) => pageErrors.push(error));
          let cleanup;
          try {
            cleanup = await scenario.prepare?.({ baseURL });
            await scenario.beforeGoto?.(page);
            await page.goto(`${baseURL}/${scenario.route}`, { waitUntil: "domcontentloaded" });
            await page.locator(scenario.ready).first().waitFor({ state: "visible", timeout: 15_000 });
            await scenario.interact?.(page);
            await scenario.verify?.(page);
            await settle(page, theme);
            if (externalRequests.length) throw new Error(`external network request blocked: ${externalRequests.join(", ")}`);
            if (pageErrors.length) throw new AggregateError(pageErrors, "uncaught browser error");

            const relativeFile = `${viewport.label}/${theme}/${scenario.name}.png`;
            const file = join(options.out, relativeFile);
            await mkdir(resolve(file, ".."), { recursive: true });
            const png = await page.screenshot({ type: "png", animations: "disabled" });
            inspectPng(png, viewport.width, viewport.height);
            await writeFile(file, png);
            row.shots++;
            row.localAvatars += localAvatarRequests.length;
            manifest[scenario.name] ??= { route: scenario.route, description: scenario.description, localAvatarHrefs: [], files: [] };
            manifest[scenario.name].localAvatarHrefs = [...new Set([...manifest[scenario.name].localAvatarHrefs, ...localAvatarRequests])];
            manifest[scenario.name].files.push(relativeFile);
          } catch (error) {
            row.status = "failed";
            failures.push({ scenario: scenario.name, size: viewport.label, theme, error });
          } finally {
            try {
              await cleanup?.();
            } catch (error) {
              row.status = "failed";
              failures.push({ scenario: scenario.name, size: viewport.label, theme, error: new Error(`cleanup failed: ${error.message}`, { cause: error }) });
            }
            await page.close();
          }
        }
        await context.close();
      }
    }

    const expected = options.viewports.length * options.themes.length;
    for (const row of summary) {
      if (row.shots !== expected) row.status = "failed";
    }
    await mkdir(options.out, { recursive: true });
    await writeFile(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (Object.keys(manifest).length !== selected.length && !failures.length) throw new Error("manifest scenario count does not match the selected catalog");
    console.table(summary);
    if (failures.length) {
      for (const failure of failures) console.error(`\n${failure.scenario} ${failure.size} ${failure.theme}:\n${failure.error.stack ?? failure.error}`);
      throw new Error(`${failures.length} screenshot variant${failures.length === 1 ? "" : "s"} failed`);
    }
    console.log(`\nWrote ${summary.reduce((total, row) => total + row.shots, 0)} screenshots and manifest.json to ${options.out}`);
  } finally {
    await browser?.close();
    await stopServer(server);
    await outputDone;
    await rm(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
