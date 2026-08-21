// Record the real app for the landing search demo: bun scripts/record-landing-search.mjs [--trim seconds]
// Boots the mock server on the captured microsoft/vscode snapshot, records inbox -> Cmd+K -> type -> Enter -> PR detail
// at 2x device pixels, trims the load-in head, transcodes to H.264 MP4, and captures a palette-open poster still.
// Deterministic: frozen clock, captured avatars/assets only, external requests aborted.
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_DIR = resolve(ROOT, "server/mockData/microsoft-vscode");
const OUT_DIR = resolve(ROOT, "docs/screenshots");
const VIEWPORT = { width: 1280, height: 960 };
const SCALE = 2;
const TYPE_DELAY = 95;
const HOLD = { inbox: 2400, palette: 900, results: 900, detail: 3200 };
const CONTENT_TYPE_BY_EXTENSION = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const trimArgIndex = process.argv.indexOf("--trim");
const TRIM_OVERRIDE = trimArgIndex === -1 ? null : Number(process.argv[trimArgIndex + 1]);
if (TRIM_OVERRIDE !== null && (!Number.isFinite(TRIM_OVERRIDE) || TRIM_OVERRIDE < 0)) throw new Error(`invalid --trim: ${process.argv[trimArgIndex + 1]}`);

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
    return { body: readFileSync(join(snapshotDir, "blobs", name)), contentType: CONTENT_TYPE_BY_EXTENSION[extname(name)] ?? "application/octet-stream" };
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

async function settle(page) {
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light" && document.fonts.status === "loaded");
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  // Decode every image and force a full re-raster: the compositor otherwise ships stale pre-decode
  // tiles into the recording, leaving avatar circles gray until the next big invalidation.
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode().catch(() => {}))));
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(60);
  await page.mouse.wheel(0, -1);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function run(command, label) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) throw new Error(`${label} failed:\n${stderr || stdout}`);
  return stdout.trim();
}

async function main() {
  const snapshot = JSON.parse(await readFile(join(SNAPSHOT_DIR, "snapshot.json"), "utf8"));
  const repo = snapshot.repo;
  const paletteNumber = snapshot.roles.palette.number;
  const paletteTitle = snapshot.details.find((detail) => detail.number === paletteNumber).title;
  const paletteQuery = paletteTitle.split(/\W+/).filter(Boolean).slice(0, 3).join(" ");
  const assets = loadAssets(SNAPSHOT_DIR, snapshot);
  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-record-"));
  const videoDir = await mkdtemp(join(tmpdir(), "pr-cockpit-video-"));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, "server/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_PORT: String(port), COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: SNAPSHOT_DIR, COCKPIT_REPO_ROOTS: "", GITHUB_TOKEN: "", GH_TOKEN: "" },
    stdout: "inherit",
    stderr: "inherit",
  });

  let browser;
  try {
    await waitForServer(server, baseURL);
    const settingsResponse = await fetch(`${baseURL}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hide_sidebar: true, theme: "system", font_ui: "default", font_code: "default", font_comments: "default" }),
    });
    if (!settingsResponse.ok) throw new Error(`settings update failed: ${settingsResponse.status}`);

    browser = await chromium.launch({ headless: true });
    const prepareContext = async (context) => {
      await context.addInitScript((now) => { Date.now = () => now; }, Date.parse(snapshot.capturedAt));
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
      return blockedExternal;
    };
    const openPaletteWithQuery = async (page, mode) => {
      await page.goto(`${baseURL}/#/`, { waitUntil: "domcontentloaded" });
      await page.locator(".inbox-layout .queue-group").first().waitFor({ state: "visible", timeout: 15_000 });
      await settle(page);
      await page.waitForFunction(() => {
        const avatars = [...document.querySelectorAll(".row-avatar img")];
        return avatars.length > 0 && avatars.every((image) => image.complete && image.naturalWidth > 0);
      });
      await page.waitForTimeout(400);
      await settle(page);
      if (mode === "recorded") {
        page._holdStartedAt = Date.now();
        await page.waitForTimeout(HOLD.inbox);
      }
      await page.keyboard.press("Meta+K");
      const input = page.locator(".palette-input");
      await input.waitFor({ state: "visible" });
      if (mode === "recorded") {
        await page.waitForTimeout(HOLD.palette);
        await input.pressSequentially(paletteQuery, { delay: TYPE_DELAY });
      } else {
        await input.fill(paletteQuery);
      }
      const active = page.locator(".palette-result.active");
      await active.waitFor({ state: "visible" });
      const activeText = await active.innerText();
      if (!activeText.includes(paletteQuery.split(" ")[0])) throw new Error(`active palette result mismatch: ${activeText}`);
    };

    // Pass 1: recorded flow at 2x pixels.
    const recordContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "light", recordVideo: { dir: videoDir, size: VIEWPORT } });
    const recordBlocked = await prepareContext(recordContext);
    const recordPage = await recordContext.newPage();
    const recordStartedAt = Date.now();
    const recordErrors = [];
    recordPage.on("pageerror", (error) => recordErrors.push(error));
    await openPaletteWithQuery(recordPage, "recorded");
    await recordPage.waitForTimeout(HOLD.results);
    await recordPage.keyboard.press("Enter");
    await recordPage.waitForFunction((expected) => location.hash === expected, `#/pr/${repo}/${paletteNumber}`);
    await recordPage.locator(".page .detail").first().waitFor({ state: "visible", timeout: 15_000 });
    await settle(recordPage);
    await recordPage.waitForTimeout(HOLD.detail);
    if (recordBlocked.size) throw new Error(`recorded pass hit uncaptured external requests: ${[...recordBlocked].join(", ")}`);
    if (recordErrors.length) throw new AggregateError(recordErrors, "recorded pass: uncaught browser error");
    const video = recordPage.video();
    await recordPage.close();
    await recordContext.close();
    const webmPath = await video.path();
    await copyFile(webmPath, "/tmp/landing-search-raw.webm");

    // Pass 2: poster still (palette open with the query typed over the inbox), same 2x pixels.
    const posterContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "light", reducedMotion: "reduce" });
    const posterBlocked = await prepareContext(posterContext);
    const posterPage = await posterContext.newPage();
    const posterErrors = [];
    posterPage.on("pageerror", (error) => posterErrors.push(error));
    await openPaletteWithQuery(posterPage, "poster");
    await settle(posterPage);
    if (posterBlocked.size) throw new Error(`poster pass hit uncaptured external requests: ${[...posterBlocked].join(", ")}`);
    if (posterErrors.length) throw new AggregateError(posterErrors, "poster pass: uncaught browser error");
    const posterPath = join(OUT_DIR, "landing-search-poster.png");
    await posterPage.screenshot({ path: posterPath, type: "png", animations: "disabled" });
    await posterPage.close();
    await posterContext.close();

    // Transcode, trimming the load-in head. WebM VP9 leads: vanilla/Playwright Chromium ships no H.264
    // decoder (DEMUXER_ERROR_NO_SUPPORTED_STREAMS); the MP4 stays as a fallback for older Safari.
    const webmOutPath = join(OUT_DIR, "landing-search.webm");
    const mp4Path = join(OUT_DIR, "landing-search.mp4");
    // Trim everything before the settled inbox hold; the load-in lead varies run to run, so measure it.
    const TRIM_SECONDS = TRIM_OVERRIDE ?? Math.max(0, (recordPage._holdStartedAt - recordStartedAt) / 1000 - 0.35);
    await run(["ffmpeg", "-y", "-ss", TRIM_SECONDS.toFixed(2), "-i", webmPath, "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4Path], "ffmpeg transcode");
    await run(["ffmpeg", "-y", "-ss", TRIM_SECONDS.toFixed(2), "-i", webmPath, "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-pix_fmt", "yuv420p", "-an", webmOutPath], "ffmpeg webm transcode");
    const probeVideo = async (path) => {
      const parsed = JSON.parse(await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", path], "ffprobe"));
      return { ...parsed.streams[0], duration: Number(parsed.format.duration) };
    };
    const stream = await probeVideo(mp4Path);
    if (stream.codec_name !== "h264" || stream.width !== VIEWPORT.width || stream.height !== VIEWPORT.height) {
      throw new Error(`unexpected mp4 stream: ${JSON.stringify(stream)}`);
    }
    const webmStream = await probeVideo(webmOutPath);
    if (webmStream.codec_name !== "vp9" || webmStream.width !== VIEWPORT.width || webmStream.height !== VIEWPORT.height) {
      throw new Error(`unexpected webm stream: ${JSON.stringify(webmStream)}`);
    }
    const mp4Bytes = (await stat(mp4Path)).size;
    const webmBytes = (await stat(webmOutPath)).size;
    const posterBytes = (await stat(posterPath)).size;
    if (mp4Bytes < 100_000) throw new Error(`mp4 suspiciously small: ${mp4Bytes} bytes`);
    if (webmBytes < 100_000) throw new Error(`webm suspiciously small: ${webmBytes} bytes`);

    const manifest = {
      script: "scripts/record-landing-search.mjs",
      snapshot: "server/mockData/microsoft-vscode",
      capturedAt: snapshot.capturedAt,
      repo,
      pr: paletteNumber,
      prTitle: paletteTitle,
      query: paletteQuery,
      viewportCss: VIEWPORT,
      renderScale: SCALE,
      trimSeconds: Number(TRIM_SECONDS.toFixed(2)),
      flow: ["inbox", "Meta+K palette", `type query at ${TYPE_DELAY}ms/char`, "Enter", `PR detail #/pr/${repo}/${paletteNumber}`],
      video: { path: "docs/screenshots/landing-search.webm", codec: webmStream.codec_name, durationSeconds: Number(webmStream.duration.toFixed(2)), bytes: webmBytes },
      fallback: { path: "docs/screenshots/landing-search.mp4", codec: stream.codec_name, durationSeconds: Number(stream.duration.toFixed(2)), bytes: mp4Bytes },
      poster: { path: "docs/screenshots/landing-search-poster.png", scene: "palette open with query over inbox", bytes: posterBytes },
    };
    await writeFile(join(OUT_DIR, "landing-search.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`RECORD_RESULT ${JSON.stringify(manifest)}`);
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([server.exited, delay(2_000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(videoDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
