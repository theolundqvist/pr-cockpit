// Shoot the six landing screenshots from a captured mock snapshot: bun scripts/shoot-snapshot.mjs [--snapshot server/mockData/microsoft-vscode] [--out docs/screenshots]
import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const VIEWPORT = { width: 1440, height: 900 };

function parseArgs(argv) {
  const options = { snapshot: "server/mockData/microsoft-vscode", out: "docs/screenshots" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    options[key] = argv[i + 1];
  }
  return options;
}

const AVATAR_CONTENT_TYPE = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function collectAuthors(detail) {
  const authors = [detail.author];
  for (const r of detail.reviews.nodes) authors.push(r.author);
  for (const c of detail.comments.nodes) authors.push(c.author);
  for (const t of detail.reviewThreads.nodes) for (const c of t.comments.nodes) authors.push(c.author);
  for (const r of detail.reviewRequests.nodes) authors.push(r.requestedReviewer);
  return authors.filter((a) => a?.login && a.avatarUrl);
}

// The inbox/palette build github.com/<login>.png, so blobs are keyed by login too, not just by captured URL.
function loadAvatars(snapshotDir, snapshot) {
  const blob = (url) => {
    const name = snapshot.assets[url];
    if (!name) return null;
    return {
      body: readFileSync(join(snapshotDir, "blobs", name)),
      contentType: AVATAR_CONTENT_TYPE[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
    };
  };
  const byUrl = new Map();
  const byLogin = new Map();
  for (const url of Object.keys(snapshot.assets)) {
    if (new URL(url).host === "avatars.githubusercontent.com") byUrl.set(url, blob(url));
  }
  for (const detail of snapshot.details) {
    for (const author of collectAuthors(detail)) {
      const resolved = blob(author.avatarUrl);
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
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function settle(page) {
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

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function inspectPng(buffer, expectedWidth, expectedHeight) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("screenshot is not a PNG");
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshotDir = resolve(ROOT, options.snapshot);
  const snapshot = JSON.parse(await readFile(join(snapshotDir, "snapshot.json"), "utf8"));
  const repo = snapshot.repo;
  const avatars = loadAvatars(snapshotDir, snapshot);
  const outDir = resolve(ROOT, options.out);

  const scenarios = [
    { name: "inbox", route: "#/", ready: ".inbox-layout .queue-group" },
    {
      name: "pr-detail",
      route: `#/pr/${repo}/326247`,
      ready: ".page .detail .body-card .md",
      // taller than the others so the PR header and the first embedded image share the frame
      viewport: { width: 1440, height: 1400 },
      interact: async (page) => {
        const image = page.locator(".body-card .md img").first();
        await image.scrollIntoViewIfNeeded();
        await page.waitForFunction((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0, await image.elementHandle());
        await page.evaluate(() => window.scrollTo(0, 0));
      },
    },
    { name: "files", route: `#/pr/${repo}/326431/files`, ready: ".files-layout .diff" },
    {
      name: "file-history",
      route: `#/pr/${repo}/326431/files`,
      ready: ".files-layout .tree .file",
      interact: async (page) => {
        await page.locator(".tree .file").filter({ hasText: "app.ts" }).first().click();
        await page.keyboard.press("h");
        await page.locator(".fh-view .fh-row").first().waitFor();
        await page.locator(".fh-detail").waitFor();
      },
    },
    {
      name: "palette",
      route: "#/",
      ready: ".inbox-layout",
      interact: async (page) => {
        await page.keyboard.press("Meta+k");
        await page.locator(".palette .palette-result").first().waitFor();
      },
    },
    {
      name: "merge-confirm",
      route: `#/pr/${repo}/326145`,
      ready: ".page .detail",
      interact: async (page) => {
        await page.keyboard.press("m");
        await page.locator(".keybar.merge-confirm").first().waitFor();
      },
    },
  ];

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
    await fetch(`${baseURL}/api/settings`, { method: "PUT", body: JSON.stringify({ hide_sidebar: true }) });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", reducedMotion: "reduce" });
    await context.addInitScript((now) => {
      Date.now = () => now;
    }, Date.parse(snapshot.capturedAt));
    const missingAvatars = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === baseURL) return route.continue();
      const login = url.host === "github.com" ? url.pathname.match(/^\/([^/]+)\.png$/)?.[1] : null;
      const isAvatar = login !== null || url.host === "avatars.githubusercontent.com";
      const avatar = login ? avatars.byLogin.get(login) : avatars.byUrl.get(url.href);
      if (avatar) return route.fulfill({ status: 200, contentType: avatar.contentType, body: avatar.body });
      if (isAvatar) missingAvatars.push(url.href);
      return route.abort("blockedbyclient");
    });

    await mkdir(outDir, { recursive: true });
    for (const scenario of scenarios) {
      missingAvatars.length = 0;
      const viewport = scenario.viewport ?? VIEWPORT;
      const page = await context.newPage();
      if (scenario.viewport) await page.setViewportSize(viewport);
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error));
      await page.goto(`${baseURL}/${scenario.route}`, { waitUntil: "domcontentloaded" });
      await page.locator(scenario.ready).first().waitFor({ state: "visible", timeout: 15_000 });
      await scenario.interact?.(page);
      await settle(page);
      if (missingAvatars.length) throw new Error(`${scenario.name}: avatar not in snapshot: ${[...new Set(missingAvatars)].join(", ")}`);
      if (pageErrors.length) throw new AggregateError(pageErrors, `${scenario.name}: uncaught browser error`);
      const png = await page.screenshot({ type: "png", animations: "disabled" });
      inspectPng(png, viewport.width, viewport.height);
      await writeFile(join(outDir, `${scenario.name}.png`), png);
      console.log(`wrote ${scenario.name}.png`);
      await page.close();
    }
    await context.close();
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
