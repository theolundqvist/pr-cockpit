// Record the real app for the landing search demo: node scripts/record-landing-search.mjs
// Boots the mock server on the captured Rust target snapshot, then composites one fixed
// 1280x960 canvas: macOS desktop -> real 680x440 standalone Electron palette -> word query ->
// Enter -> real 1120x840 app window on the PR detail at scroll top. Poster comes from PNGs.
// Deterministic: frozen clock, captured avatars/assets only, external requests aborted.
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, _electron as electron } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_RELATIVE = "server/mockData/rust-lang-rust";
const SNAPSHOT_DIR = resolve(ROOT, SNAPSHOT_RELATIVE);
const OUT_DIR = resolve(ROOT, "docs/screenshots");
// One canvas for every frame: the desktop, the palette panel, and the app window are all
// composited at their real sizes onto this fixed 1280x960 stage. Nothing resizes mid-video.
const VIEWPORT = { width: 1280, height: 960 };
// The shell creates the palette as a transparent 680x440 panel; the recording keeps that exact
// size from first keystroke to Enter, so nothing in the demo implies a resizing search window.
const PALETTE_WINDOW = { width: 680, height: 440 };
const MAIN_WINDOW = { width: 1120, height: 840 };
const centerOn = (window) => ({ x: (VIEWPORT.width - window.width) / 2, y: (VIEWPORT.height - window.height) / 2 });
const PALETTE_ORIGIN = centerOn(PALETTE_WINDOW);
const MAIN_ORIGIN = centerOn(MAIN_WINDOW);
const FPS = 25;
// Saturated macOS-style desktop. The palette window is transparent, so the same pixels are
// painted behind the card and under the composite: the palette never sits on an app backing.
const WALLPAPER_BACKGROUND = `
  radial-gradient(78% 82% at 6% 8%, rgba(255,42,120,.95), rgba(255,42,120,0) 62%),
  radial-gradient(58% 62% at 97% 10%, rgba(255,150,32,.9), rgba(255,150,32,0) 60%),
  radial-gradient(85% 75% at 74% 100%, rgba(0,224,255,.75), rgba(0,224,255,0) 62%),
  linear-gradient(155deg,#2a0b62 0%,#0d2f8f 26%,#0b62c4 52%,#06356f 78%,#041c4a 100%)`;
const SRGB_FLAG = "--force-color-profile=srgb";
const TYPE_DELAY = 55;
const HOLD = { desktop: 1400, palette: 500, results: 450, detail: 3200 };
const QUERY_STOP_WORDS = new Set(["a", "an", "and", "for", "from", "in", "of", "on", "the", "to", "with"]);
const CONTENT_TYPE_BY_EXTENSION = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const ELECTRON_EXECUTABLE = process.env.COCKPIT_ELECTRON_PATH
  ?? resolve(ROOT, "shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const execFileAsync = promisify(execFile);

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

// Every surface is captured headlessly and the wallpaper is composited afterwards, so no OS screen
// recording and no real pointer can reach the frame. This rejects a drawn stand-in cursor too.
async function assertNoCursorLayer(page, label) {
  const drawn = await page.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((node) => /cursor|pointer|mouse/i.test(`${node.id} ${node.className}`))
    .map((node) => node.id || node.className)
    .filter((name) => typeof name === "string"));
  if (drawn.length > 0) throw new Error(`${label} draws a cursor layer: ${drawn.join(", ")}`);
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
  try {
    const { stdout } = await execFileAsync(command[0], command.slice(1), { maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${label} failed:\n${error.stderr || error.stdout || error.message}`);
  }
}

async function renderWallpaper(path) {
  // Both renderers are pinned to sRGB: on a P3 display the app window would otherwise be captured
  // in a wider profile than this PNG and the composited window would read as a tinted rectangle.
  const browser = await chromium.launch({ headless: true, args: [SRGB_FLAG] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "light" });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;background:${WALLPAPER_BACKGROUND}"></body></html>`, { waitUntil: "load" });
    await page.screenshot({ path, type: "png", animations: "disabled" });
  } finally {
    await browser.close();
  }
}

// One raw RGB pixel, used to prove the palette recording is the unscaled window content.
async function samplePixel(path, x, y, second = 0) {
  const args = ["-v", "error", ...(second ? ["-ss", second.toFixed(3)] : []), "-i", path, "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-frames:v", "1", "-f", "rawvideo", "-"];
  const { stdout } = await execFileAsync("ffmpeg", args, { encoding: "buffer", maxBuffer: 4096 });
  if (stdout.length < 3) throw new Error(`pixel sample failed for ${path} at ${x},${y}`);
  return [stdout[0], stdout[1], stdout[2]];
}

async function main() {
  const snapshot = JSON.parse(await readFile(join(SNAPSHOT_DIR, "snapshot.json"), "utf8"));
  const repo = snapshot.repo;
  const paletteNumber = snapshot.roles.palette.number;
  const paletteDetail = snapshot.details.find((detail) => detail.number === paletteNumber);
  const paletteTitle = paletteDetail.title;
  const paletteSlideAlt = snapshot.fixtureAugmentations?.[String(paletteNumber)]?.descriptionImage?.alt;
  if (!paletteSlideAlt) throw new Error(`snapshot has no disclosed description image for #${paletteNumber}`);
  const paletteQuery = paletteTitle.split(/\W+/).filter((word) => word.length > 2 && !QUERY_STOP_WORDS.has(word.toLowerCase())).slice(0, 3).join(" ");
  const assets = loadAssets(SNAPSHOT_DIR, snapshot);
  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-record-"));
  const videoDir = await mkdtemp(join(tmpdir(), "pr-cockpit-video-"));
  const profileDir = await mkdtemp(join(tmpdir(), "pr-cockpit-electron-"));
  const stageDir = await mkdtemp(join(tmpdir(), "pr-cockpit-stage-"));
  const wallpaperPath = join(stageDir, "desktop.png");
  await renderWallpaper(wallpaperPath);
  const wallpaperDataUrl = `data:image/png;base64,${(await readFile(wallpaperPath)).toString("base64")}`;
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn("bun", ["server/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_PORT: String(port), COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: SNAPSHOT_DIR, COCKPIT_REPO_ROOTS: "", GITHUB_TOKEN: "", GH_TOKEN: "" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let electronApp;
  try {
    await waitForServer(server, baseURL);
    const settingsResponse = await fetch(`${baseURL}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hide_sidebar: true, theme: "system", font_ui: "default", font_code: "default", font_comments: "default" }),
    });
    if (!settingsResponse.ok) throw new Error(`settings update failed: ${settingsResponse.status}`);
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

    if (!existsSync(ELECTRON_EXECUTABLE)) {
      throw new Error(`Electron runtime not found at ${ELECTRON_EXECUTABLE}; install shell dependencies or set COCKPIT_ELECTRON_PATH`);
    }
    electronApp = await electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [
        `--user-data-dir=${profileDir}`,
        resolve(ROOT, "shell"),
        `--cockpit-url=${baseURL}`,
        "--cockpit-hidden",
        SRGB_FLAG,
      ],
      env: {
        ...process.env,
        COCKPIT_URL: baseURL,
        COCKPIT_DATA_DIR: dataDir,
        COCKPIT_MANAGED: "0",
      },
      colorScheme: "light",
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    const recordContext = electronApp.context();
    const recordBlocked = await prepareContext(recordContext);
    const windows = electronApp.windows();
    const palettePage = windows.find((page) => page.url().includes("#/palette"));
    const recordPage = windows.find((page) => !page.url().includes("#/palette"));
    if (!palettePage || !recordPage) throw new Error(`Electron shell opened unexpected windows: ${windows.map((page) => page.url()).join(", ")}`);
    const recordErrors = [];
    palettePage.on("pageerror", (error) => recordErrors.push(error));
    recordPage.on("pageerror", (error) => recordErrors.push(error));
    await electronApp.evaluate(({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes("#/palette"));
      if (!main) throw new Error("main PR window not found");
      main.setContentSize(size.width, size.height);
      main.setResizable(false);
    }, MAIN_WINDOW);
    await Promise.all([
      palettePage.reload({ waitUntil: "domcontentloaded" }),
      recordPage.reload({ waitUntil: "domcontentloaded" }),
    ]);
    // The palette panel is transparent in the shell, so painting the desktop slice that sits behind
    // it reproduces the real global-shortcut view: card over wallpaper, no app window underneath.
    await palettePage.evaluate(({ dataUrl, origin, viewport }) => {
      const desktop = `url("${dataUrl}") -${origin.x}px -${origin.y}px / ${viewport.width}px ${viewport.height}px no-repeat`;
      document.documentElement.style.background = desktop;
      document.body.style.background = desktop;
    }, { dataUrl: wallpaperDataUrl, origin: PALETTE_ORIGIN, viewport: VIEWPORT });
    // The transparent panel has no page backdrop in the shell, so its scrim blur has nothing to
    // frost; over the injected desktop it would stamp a lighter rectangle the product never shows.
    await palettePage.addStyleTag({ content: ".scrim.standalone { backdrop-filter: none; }" });
    await electronApp.evaluate(({ BrowserWindow }, size) => {
      const palette = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("#/palette"));
      if (!palette) throw new Error("standalone palette window not found");
      palette.setContentSize(size.width, size.height);
      palette.setResizable(false);
    }, PALETTE_WINDOW);
    await palettePage.locator(".palette-input").waitFor({ state: "visible", timeout: 15_000 });
    await recordPage.locator(".inbox-layout .queue-group").first().waitFor({ state: "visible", timeout: 15_000 });
    await Promise.all([settle(palettePage), settle(recordPage)]);
    await recordPage.evaluate(() => {
      document.documentElement.style.visibility = "hidden";
    });
    const assertPaletteSize = async (stage) => {
      const measured = await palettePage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (measured.width !== PALETTE_WINDOW.width || measured.height !== PALETTE_WINDOW.height) {
        throw new Error(`palette window changed size at ${stage}: ${measured.width}x${measured.height}`);
      }
    };
    await assertPaletteSize("before the shortcut");

    const mainVideo = recordPage.video();
    const paletteVideo = palettePage.video();
    if (!mainVideo || !paletteVideo) throw new Error("Electron video recording did not start");

    const paletteStartedAt = Date.now();
    await palettePage.evaluate(() => window.dispatchEvent(new Event("cockpit:open-palette")));
    await electronApp.evaluate(({ BrowserWindow }) => {
      const palette = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("#/palette"));
      if (!palette) throw new Error("standalone palette window not found");
      palette.center();
      palette.show();
      palette.focus();
      palette.webContents.focus();
    });
    const paletteInput = palettePage.locator(".palette-input");
    await assertPaletteSize("palette shown");
    await palettePage.waitForTimeout(HOLD.palette);
    await paletteInput.pressSequentially(paletteQuery, { delay: TYPE_DELAY });
    const active = palettePage.locator(".palette-result.active");
    await active.waitFor({ state: "visible" });
    const activeText = await active.innerText();
    if (!activeText.includes(paletteQuery.split(" ")[0])) throw new Error(`active palette result mismatch: ${activeText}`);
    await assertPaletteSize("result rendered");
    await palettePage.waitForTimeout(HOLD.results);
    await assertNoCursorLayer(palettePage, "the palette surface");
    const paletteFramePath = join(stageDir, "palette-frame.png");
    const paletteImagePath = join(OUT_DIR, "landing-search-palette.png");
    await palettePage.screenshot({ path: paletteFramePath, animations: "disabled" });

    const enterAt = Date.now();
    await paletteInput.press("Enter");
    await recordPage.waitForFunction((expected) => location.hash === expected, `#/pr/${repo}/${paletteNumber}`);
    const mainSize = await recordPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (mainSize.width !== MAIN_WINDOW.width || mainSize.height !== MAIN_WINDOW.height) {
      throw new Error(`main window is not ${MAIN_WINDOW.width}x${MAIN_WINDOW.height}: ${JSON.stringify(mainSize)}`);
    }
    await recordPage.locator(".page .detail").first().waitFor({ state: "attached", timeout: 15_000 });
    await settle(recordPage);
    const slide = recordPage.getByAltText(paletteSlideAlt, { exact: true });
    await slide.waitFor({ state: "attached", timeout: 15_000 });
    // The detail rests where a real Enter leaves it: scroll top, never scrolled into the slide, so
    // the description image is only entering at the fold.
    await recordPage.evaluate(() => {
      document.querySelector(".page").scrollTop = 0;
    });
    await recordPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await assertNoCursorLayer(recordPage, "the app window surface");
    const framing = await slide.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { scrollTop: element.closest(".page").scrollTop, top: rect.top, bottom: rect.bottom, fold: window.innerHeight };
    });
    if (framing.scrollTop !== 0) throw new Error(`detail did not rest at scroll top: ${JSON.stringify(framing)}`);
    if (!(framing.top > 0 && framing.top < framing.fold && framing.bottom > framing.fold)) {
      throw new Error(`description image is not cut by the fold: ${JSON.stringify(framing)}`);
    }
    await recordPage.evaluate(() => {
      document.documentElement.style.visibility = "visible";
    });
    await recordPage.locator(".page .detail").first().waitFor({ state: "visible", timeout: 15_000 });
    const detailVisibleAt = Date.now();
    await recordPage.waitForTimeout(HOLD.detail);
    const recordingEndedAt = Date.now();
    if (recordBlocked.size) throw new Error(`recorded pass hit uncaptured external requests: ${[...recordBlocked].join(", ")}`);
    if (recordErrors.length) throw new AggregateError(recordErrors, "recorded pass: uncaught renderer error");
    await electronApp.close();
    electronApp = null;
    const [mainVideoPath, paletteVideoPath] = await Promise.all([mainVideo.path(), paletteVideo.path()]);

    const probeVideo = async (path) => {
      const parsed = JSON.parse(await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", path], "ffprobe"));
      return { ...parsed.streams[0], duration: Number(parsed.format.duration) };
    };
    const [mainRaw, paletteRaw] = await Promise.all([probeVideo(mainVideoPath), probeVideo(paletteVideoPath)]);
    const paletteDuration = (enterAt - paletteStartedAt) / 1000;
    const detailDuration = (recordingEndedAt - detailVisibleAt) / 1000;
    const desktopDuration = HOLD.desktop / 1000;
    // Both recordings run until the app closes, so wall-clock offsets map onto the video tail.
    const videoTime = (raw, wallTime, label) => {
      const start = raw.duration - (recordingEndedAt - wallTime) / 1000;
      if (start < 0) throw new Error(`${label} recording stopped early: ${raw.duration.toFixed(2)}s covers less than the ${((recordingEndedAt - wallTime) / 1000).toFixed(2)}s tail`);
      return start;
    };
    const palettePanelStart = videoTime(paletteRaw, paletteStartedAt, "palette");
    const detailStart = videoTime(mainRaw, detailVisibleAt, "main window");
    if (paletteRaw.width < PALETTE_WINDOW.width || paletteRaw.height < PALETTE_WINDOW.height) {
      throw new Error(`palette recording smaller than the window: ${paletteRaw.width}x${paletteRaw.height}`);
    }
    if (mainRaw.width < MAIN_WINDOW.width || mainRaw.height < MAIN_WINDOW.height) {
      throw new Error(`main recording smaller than the window: ${mainRaw.width}x${mainRaw.height}`);
    }
    // Playwright draws a smaller page unscaled at the frame origin; prove it before cropping, or a
    // scaled/offset recording would silently ship a sliced palette.
    const [videoCorner, wallpaperCorner] = await Promise.all([
      samplePixel(paletteVideoPath, 6, 6, palettePanelStart + HOLD.palette / 2000),
      samplePixel(wallpaperPath, PALETTE_ORIGIN.x + 6, PALETTE_ORIGIN.y + 6),
    ]);
    const cornerDrift = Math.max(...videoCorner.map((value, index) => Math.abs(value - wallpaperCorner[index])));
    if (cornerDrift > 20) {
      throw new Error(`palette recording is not the unscaled window content: corner ${videoCorner} vs desktop ${wallpaperCorner}`);
    }
    const stageDuration = desktopDuration + paletteDuration + detailDuration + 1;
    const filter = [
      `[2:v]fps=${FPS},setsar=1,split=3[desk-a][desk-b][desk-c]`,
      `[desk-a]trim=duration=${desktopDuration.toFixed(3)},setpts=PTS-STARTPTS[desktop]`,
      `[desk-b]trim=duration=${paletteDuration.toFixed(3)},setpts=PTS-STARTPTS[palette-bg]`,
      `[desk-c]trim=duration=${detailDuration.toFixed(3)},setpts=PTS-STARTPTS[detail-bg]`,
      `[1:v]trim=start=${palettePanelStart.toFixed(3)}:duration=${paletteDuration.toFixed(3)},setpts=PTS-STARTPTS,crop=${PALETTE_WINDOW.width}:${PALETTE_WINDOW.height}:0:0,fps=${FPS},setsar=1[palette-window]`,
      `[palette-bg][palette-window]overlay=${PALETTE_ORIGIN.x}:${PALETTE_ORIGIN.y}:shortest=1[search]`,
      `[0:v]trim=start=${detailStart.toFixed(3)}:duration=${detailDuration.toFixed(3)},setpts=PTS-STARTPTS,crop=${MAIN_WINDOW.width}:${MAIN_WINDOW.height}:0:0,fps=${FPS},setsar=1[main-window]`,
      `[detail-bg][main-window]overlay=${MAIN_ORIGIN.x}:${MAIN_ORIGIN.y}:shortest=1[detail]`,
      "[desktop][search][detail]concat=n=3:v=1:a=0,format=yuv420p,split=2[mp4-out][webm-out]",
    ].join(";");

    const webmOutPath = join(OUT_DIR, "landing-search.webm");
    const mp4Path = join(OUT_DIR, "landing-search.mp4");
    const posterPath = join(OUT_DIR, "landing-search-poster.png");
    // BT.709 tagging keeps the saturated desktop and the palette text from being decoded as
    // washed-out BT.601; both encodes come off the same filter graph, so neither is a re-compress.
    const colorTags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
    await run([
      "ffmpeg", "-y", "-i", mainVideoPath, "-i", paletteVideoPath,
      "-loop", "1", "-framerate", String(FPS), "-t", stageDuration.toFixed(3), "-i", wallpaperPath,
      "-filter_complex", filter,
      "-map", "[mp4-out]", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", ...colorTags, "-movflags", "+faststart", "-an", mp4Path,
      "-map", "[webm-out]", "-c:v", "libvpx-vp9", "-crf", "24", "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-pix_fmt", "yuv420p", ...colorTags, "-an", webmOutPath,
    ], "ffmpeg compose");
    await run([
      "ffmpeg", "-y", "-i", mp4Path, "-frames:v", "1", posterPath,
    ], "ffmpeg poster");
    await run([
      "ffmpeg", "-y", "-i", wallpaperPath, "-i", paletteFramePath,
      "-filter_complex", `[0:v][1:v]overlay=${PALETTE_ORIGIN.x}:${PALETTE_ORIGIN.y}[palette]`,
      "-map", "[palette]", "-frames:v", "1", paletteImagePath,
    ], "ffmpeg palette image");

    const stream = await probeVideo(mp4Path);
    if (stream.codec_name !== "h264" || stream.width !== VIEWPORT.width || stream.height !== VIEWPORT.height) {
      throw new Error(`unexpected mp4 stream: ${JSON.stringify(stream)}`);
    }
    const webmStream = await probeVideo(webmOutPath);
    if (webmStream.codec_name !== "vp9" || webmStream.width !== VIEWPORT.width || webmStream.height !== VIEWPORT.height) {
      throw new Error(`unexpected webm stream: ${JSON.stringify(webmStream)}`);
    }
    const poster = JSON.parse(await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", posterPath], "ffprobe poster"));
    if (poster.streams[0].width !== VIEWPORT.width || poster.streams[0].height !== VIEWPORT.height) {
      throw new Error(`unexpected poster size: ${JSON.stringify(poster.streams[0])}`);
    }
    const mp4Bytes = (await stat(mp4Path)).size;
    const webmBytes = (await stat(webmOutPath)).size;
    const posterBytes = (await stat(posterPath)).size;
    const paletteImageBytes = (await stat(paletteImagePath)).size;
    if (mp4Bytes < 100_000) throw new Error(`mp4 suspiciously small: ${mp4Bytes} bytes`);
    if (webmBytes < 100_000) throw new Error(`webm suspiciously small: ${webmBytes} bytes`);

    const manifest = {
      script: "scripts/record-landing-search.mjs",
      snapshot: SNAPSHOT_RELATIVE,
      capturedAt: snapshot.capturedAt,
      repo,
      pr: paletteNumber,
      prTitle: paletteTitle,
      query: paletteQuery,
      capture: "headless Electron surface capture composited over the wallpaper by ffmpeg; no OS screen recording, no pointer or cursor layer in any frame",
      canvasCss: VIEWPORT,
      canvas: "every frame is composited on one fixed 1280x960 stage; no window or canvas is resized mid-video",
      renderScale: 1,
      zoomFactor: 1,
      detailRestsAt: "scroll top, never scrolled into the slide: the description image is cut by the fold",
      desktop: {
        source: "CSS gradient rendered at 1280x960 by this script",
        role: "stands in for the macOS desktop; the transparent palette panel and the app window are composited onto it, so no synthetic app plane sits behind the palette",
      },
      shell: {
        runtime: "Electron",
        paletteWindow: { ...PALETTE_WINDOW, origin: PALETTE_ORIGIN, fixed: "content size asserted at 680x440 before the shortcut, on show, and with the result rendered" },
        mainWindow: { ...MAIN_WINDOW, origin: MAIN_ORIGIN, fixed: "content size asserted at 1120x840 when the detail opens; zoom factor left at 1" },
        trigger: "The isolated recorder presents the same standalone BrowserWindow bound to Command+Option+K; OS global-shortcut registration is not exercised.",
      },
      flow: ["macOS desktop, PR Cockpit window not shown", "standalone 680x440 Electron search palette over the desktop", `type word query at ${TYPE_DELAY}ms/char`, "Enter", `hard cut to the 1120x840 app window on PR detail #/pr/${repo}/${paletteNumber} at scroll top`],
      capturedPr: {
        changedLines: paletteDetail.additions + paletteDetail.deletions,
        additions: paletteDetail.additions,
        deletions: paletteDetail.deletions,
        mergeable: paletteDetail.mergeable,
        ci: paletteDetail.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "NONE",
      },
      fixtureAugmentation: snapshot.fixtureAugmentations[String(paletteNumber)],
      descriptionImageFraming: { topPx: Math.round(framing.top), bottomPx: Math.round(framing.bottom), foldPx: Math.round(framing.fold) },
      encode: { mp4Crf: 18, webmCrf: 24, colorSpace: "bt709", note: "single filter pass feeds both encoders; the poster matches the opening desktop frame" },
      paletteImage: { path: "docs/screenshots/landing-search-palette.png", scene: "standalone Electron palette with word query over the desktop", bytes: paletteImageBytes },
      video: { path: "docs/screenshots/landing-search.webm", codec: webmStream.codec_name, durationSeconds: Number(webmStream.duration.toFixed(2)), bytes: webmBytes },
      fallback: { path: "docs/screenshots/landing-search.mp4", codec: stream.codec_name, durationSeconds: Number(stream.duration.toFixed(2)), bytes: mp4Bytes },
      poster: { path: "docs/screenshots/landing-search-poster.png", scene: "opening desktop frame before the palette appears", bytes: posterBytes },
    };
    await writeFile(join(OUT_DIR, "landing-search.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`RECORD_RESULT ${JSON.stringify(manifest)}`);
  } finally {
    await electronApp?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await delay(250);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
    await rm(videoDir, { recursive: true, force: true });
    await rm(profileDir, { recursive: true, force: true });
    await rm(stageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
