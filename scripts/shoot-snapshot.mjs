// Shoot the public screenshots from a captured mock snapshot: bun scripts/shoot-snapshot.mjs [--snapshot server/mockData/microsoft-vscode] [--out docs/screenshots]
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const THEMES = ["light", "dark"];
const CONTENT_TYPE_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function parseArgs(argv) {
  const options = { snapshot: "server/mockData/microsoft-vscode", out: "docs/screenshots", viewport: "1600x1200", theme: "both", profile: "public", filter: "" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  return options;
}
function parseViewport(value) {
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`invalid viewport: ${value}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}


function collectAuthors(detail) {
  const authors = [detail.author];
  for (const review of detail.reviews.nodes) authors.push(review.author);
  for (const comment of detail.comments.nodes) authors.push(comment.author);
  for (const thread of detail.reviewThreads.nodes) {
    for (const comment of thread.comments.nodes) authors.push(comment.author);
  }
  for (const request of detail.reviewRequests.nodes) authors.push(request.requestedReviewer);
  return authors.filter((author) => author?.login && author.avatarUrl);
}

function loadAssets(snapshotDir, snapshot) {
  const asset = (url) => {
    const name = snapshot.assets[url];
    if (!name) return null;
    return {
      body: readFileSync(join(snapshotDir, "blobs", name)),
      contentType: CONTENT_TYPE_BY_EXTENSION[extname(name)] ?? "application/octet-stream",
    };
  };
  const byUrl = new Map();
  const byLogin = new Map();
  for (const url of Object.keys(snapshot.assets)) {
    const resolved = asset(url);
    if (resolved) byUrl.set(url, resolved);
  }
  for (const detail of snapshot.details) {
    for (const author of collectAuthors(detail)) {
      const resolved = asset(author.avatarUrl);
      if (resolved && !byLogin.has(author.login)) byLogin.set(author.login, resolved);
    }
  }
  return { byUrl, byLogin };
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function waitForServer(server, baseURL) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${baseURL}/api/settings`)).ok) return;
    } catch {}
    await delay(75);
  }
  throw new Error("server did not become ready within 15s");
}

async function settle(page, theme) {
  await page.waitForFunction(
    (expectedTheme) => document.documentElement.dataset.theme === expectedTheme && document.fonts.status === "loaded",
    theme,
  );
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

function inspectPng(buffer, viewport) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("screenshot is not a PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== viewport.width || height !== viewport.height) {
    throw new Error(`PNG is ${width}×${height}, expected ${viewport.width}×${viewport.height}`);
  }
  if (buffer.length < 10_000) throw new Error(`PNG appears blank: only ${buffer.length} bytes`);
}

function requireRoles(snapshot) {
  const roles = snapshot.roles;
  for (const name of ["inbox", "conversation", "files", "editing", "history", "palette"]) {
    if (!roles?.[name]) throw new Error(`snapshot is missing ${name} role`);
  }
  const capturedNumbers = new Set(snapshot.details.map((detail) => detail.number));
  for (const name of ["conversation", "files", "editing", "history", "palette"]) {
    if (!capturedNumbers.has(roles[name].number)) throw new Error(`${name} role references uncaptured PR #${roles[name].number}`);
  }
  const editingKey = `${roles.editing.headSha}:${roles.editing.path}`;
  if (!snapshot.fileContents?.[editingKey]) throw new Error(`snapshot is missing editable file ${editingKey}`);
  if (snapshot.history.path !== roles.history.path) throw new Error("history role does not match captured history");
  return roles;
}

function fileBlock(page, path) {
  return page.locator(".diff section.file").filter({ has: page.locator(".file-path", { hasText: path }) }).first();
}

async function openFile(page, path) {
  const treeEntry = page.locator(".tree .file").filter({ hasText: path.split("/").at(-1) }).first();
  await treeEntry.click();
  await fileBlock(page, path).waitFor();
}

async function positionFiles(page) {
  await page.locator(".files-layout").evaluate((layout) => {
    const scroller = layout.closest(".page");
    if (!(scroller instanceof HTMLElement)) throw new Error("files scroll container missing");
    const top = layout.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo(0, Math.max(0, top - 24));
  });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
}

async function verifyAligned(page, leftSelector, rightSelector) {
  const [left, right] = await Promise.all([
    page.locator(leftSelector).first().boundingBox(),
    page.locator(rightSelector).first().boundingBox(),
  ]);
  if (!left || !right) throw new Error(`missing aligned capture columns: ${leftSelector}, ${rightSelector}`);
  if (Math.abs(left.y - right.y) > 2 || left.y > 72 || right.y > 72) {
    throw new Error(`capture columns are not top-aligned: ${leftSelector} y=${left.y}, ${rightSelector} y=${right.y}`);
  }
}

async function verifyRightEdgesAligned(page, leftSelector, rightSelector) {
  const [left, right] = await Promise.all([
    page.locator(leftSelector).first().boundingBox(),
    page.locator(rightSelector).first().boundingBox(),
  ]);
  if (!left || !right) throw new Error(`missing capture edges: ${leftSelector}, ${rightSelector}`);
  const leftEdge = left.x + left.width;
  const rightEdge = right.x + right.width;
  if (Math.abs(leftEdge - rightEdge) > 2) {
    throw new Error(`capture edges are not aligned: ${leftSelector} x=${leftEdge}, ${rightSelector} x=${rightEdge}`);
  }
}


function scenariosFor(snapshot, roles, profile) {
  const repo = snapshot.repo;
  const paletteTitle = snapshot.details.find((detail) => detail.number === roles.palette.number).title;
  const paletteQuery = paletteTitle.split(/\W+/).filter(Boolean).slice(0, 3).join(" ");
  const scenarios = [
    {
      name: "inbox",
      route: "#/",
      ready: ".inbox-layout .queue-group",
      verify: async (page) => {
        if (await page.locator(".app-sidebar").isVisible()) throw new Error("inbox sidebar is visible");
      },
    },
    {
      name: "conversation",
      route: `#/pr/${repo}/${roles.conversation.number}`,
      ready: ".page .detail",
      verify: (page) => verifyRightEdgesAligned(page, ".pr-head", ".right"),
    },
    {
      name: "files",
      route: `#/pr/${repo}/${roles.files.number}/files`,
      ready: ".files-layout .diff",
      interact: positionFiles,
      verify: (page) => verifyAligned(page, ".tree-pane", ".diff-pane"),
    },
    {
      name: "editing",
      route: `#/pr/${repo}/${roles.editing.number}/files`,
      ready: ".files-layout .diff",
      interact: async (page) => {
        await openFile(page, roles.editing.path);
        await fileBlock(page, roles.editing.path).locator(".file-edit-btn").click();
        const editor = page.getByLabel(`Edit ${roles.editing.path}`);
        await editor.waitFor();
        await editor.evaluate((content) => {
          const scroller = content.closest(".cm-editor")?.querySelector(".cm-scroller");
          if (!(scroller instanceof HTMLElement)) throw new Error("editor scroller missing");
          scroller.scrollTop = scroller.scrollHeight * 0.93;
          scroller.dispatchEvent(new Event("scroll"));
        });
        const changedLine = page.locator(".cm-line").filter({ hasText: "!Array.isArray(extensionGalleryManifest.resources)" }).first();
        await changedLine.waitFor();
        await changedLine.click();
        await page.keyboard.press("End");
        await page.keyboard.type(" /* reviewed here */");
        await page.waitForFunction(
          ({ label, expected }) => document.querySelector(`[aria-label="${CSS.escape(label)}"]`)?.textContent?.includes(expected),
          { label: `Edit ${roles.editing.path}`, expected: "reviewed here" },
        );
        await positionFiles(page);
      },
      verify: (page) => verifyAligned(page, ".tree-pane", ".diff-pane"),
    },
    {
      name: "history",
      route: `#/pr/${repo}/${roles.history.number}/history/${encodeURIComponent(roles.history.path)}`,
      ready: ".fh-view .fh-row",
      verify: (page) => verifyAligned(page, ".fh-rail", ".fh-detail"),
    },
    {
      name: "palette",
      route: "#/",
      ready: ".inbox-layout",
      interact: async (page) => {
        await page.keyboard.press("Meta+K");
        const input = page.locator(".palette-input");
        await input.fill(paletteQuery);
        await page.locator(".palette-result").first().waitFor();
      },
    },
  ];
  if (profile === "landing") {
    scenarios.push({
      name: "hide-tests",
      route: `#/pr/${repo}/${roles.files.number}/files`,
      ready: ".files-layout .diff",
      interact: async (page) => {
        await page.getByRole("button", { name: /hide 1 test file/ }).click();
        await page.getByRole("button", { name: /show 1 test file/ }).waitFor();
        await positionFiles(page);
      },
      verify: (page) => verifyAligned(page, ".tree-pane", ".diff-pane"),
    });
  }
  return scenarios;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const viewport = parseViewport(options.viewport);
  const themes = options.theme === "both" ? THEMES : [options.theme];
  if (!themes.every((theme) => THEMES.includes(theme))) throw new Error("--theme must be light, dark, or both");
  const snapshotDir = resolve(ROOT, options.snapshot);
  const snapshot = JSON.parse(await readFile(join(snapshotDir, "snapshot.json"), "utf8"));
  const roles = requireRoles(snapshot);
  const assets = loadAssets(snapshotDir, snapshot);
  const scenarios = scenariosFor(snapshot, roles, options.profile).filter((scenario) => scenario.name.includes(options.filter));
  const outDir = resolve(ROOT, options.out);
  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-snapshot-"));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, "server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_PORT: String(port),
      COCKPIT_MOCK: "1",
      COCKPIT_MOCK_DATA: snapshotDir,
      COCKPIT_REPO_ROOTS: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  let browser;
  try {
    await waitForServer(server, baseURL);
    const settingsResponse = await fetch(`${baseURL}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hide_sidebar: true,
        theme: "system",
        font_ui: "default",
        font_code: "default",
        font_comments: "default",
      }),
    });
    if (!settingsResponse.ok) throw new Error(`settings update failed: ${settingsResponse.status}`);
    const savedSettings = await (await fetch(`${baseURL}/api/settings`)).json();
    if (savedSettings.hide_sidebar !== true) throw new Error("hide_sidebar was not persisted");

    browser = await chromium.launch({ headless: true });
    await mkdir(outDir, { recursive: true });
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await context.addInitScript(
        (now) => {
          Date.now = () => now;
        },
        Date.parse(snapshot.capturedAt),
      );
      const blockedExternal = new Set();
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === baseURL) return route.continue();
        const direct = assets.byUrl.get(url.href);
        const login = url.host === "github.com" ? url.pathname.match(/^\/([^/]+)\.png(?:$|\/)/)?.[1] : null;
        const avatar = login && url.host === "github.com" ? assets.byLogin.get(login) : null;
        const captured = direct ?? avatar;
        if (captured) return route.fulfill({ status: 200, contentType: captured.contentType, body: captured.body });
        blockedExternal.add(url.href);
        return route.abort("blockedbyclient");
      });

      for (const scenario of scenarios) {
        blockedExternal.clear();
        const page = await context.newPage();
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error));
        await page.goto(`${baseURL}/${scenario.route}`, { waitUntil: "domcontentloaded" });
        await page.locator(scenario.ready).first().waitFor({ state: "visible", timeout: 15_000 });
        await scenario.interact?.(page);
        await settle(page, theme);
        await scenario.verify?.(page);
        if (blockedExternal.size) {
          throw new Error(`${scenario.name}-${theme}: uncaptured external requests: ${[...blockedExternal].join(", ")}`);
        }
        if (pageErrors.length) throw new AggregateError(pageErrors, `${scenario.name}-${theme}: uncaught browser error`);
        const png = await page.screenshot({ type: "png", animations: "disabled" });
        inspectPng(png, viewport);
        const output = join(outDir, `${scenario.name}-${theme}.png`);
        await writeFile(output, png);
        console.log(`wrote ${output}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([server.exited, delay(2_000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
