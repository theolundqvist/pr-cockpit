// Record the real app for the landing search demo: node scripts/record-landing-search.mjs [--trim seconds]
// Boots the mock server on the captured Rust target snapshot, records blank app -> standalone
// Electron palette -> word query -> Enter -> PR detail at 85% scale, then captures a search poster.
// Deterministic: frozen clock, captured avatars/assets only, external requests aborted.
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_RELATIVE = "server/mockData/rust-lang-rust";
const SNAPSHOT_DIR = resolve(ROOT, SNAPSHOT_RELATIVE);
const OUT_DIR = resolve(ROOT, "docs/screenshots");
const VIEWPORT = { width: 1280, height: 960 };
const TYPE_DELAY = 55;
const HOLD = { blank: 1400, palette: 500, results: 450, detail: 3200 };
const QUERY_STOP_WORDS = new Set(["a", "an", "and", "for", "from", "in", "of", "on", "the", "to", "with"]);
const CONTENT_TYPE_BY_EXTENSION = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const ELECTRON_EXECUTABLE = process.env.COCKPIT_ELECTRON_PATH
  ?? resolve(ROOT, "shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const execFileAsync = promisify(execFile);

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
  try {
    const { stdout } = await execFileAsync(command[0], command.slice(1), { maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${label} failed:\n${error.stderr || error.stdout || error.message}`);
  }
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
    await electronApp.evaluate(({ BrowserWindow }, viewport) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.getURL().includes("#/palette")) window.setBounds({ width: viewport.width, height: viewport.height });
      }
    }, VIEWPORT);
    await Promise.all([
      palettePage.reload({ waitUntil: "domcontentloaded" }),
      recordPage.reload({ waitUntil: "domcontentloaded" }),
    ]);
    await palettePage.evaluate(() => {
      document.documentElement.style.background = "#f5f5f3";
      document.body.style.background = "#f5f5f3";
    });
    await palettePage.locator(".palette-input").waitFor({ state: "visible", timeout: 15_000 });
    await recordPage.locator(".inbox-layout .queue-group").first().waitFor({ state: "visible", timeout: 15_000 });
    await Promise.all([settle(palettePage), settle(recordPage)]);
    await recordPage.evaluate(() => {
      document.documentElement.style.visibility = "hidden";
      document.body.style.background = "#f5f5f3";
    });

    const mainVideo = recordPage.video();
    const paletteVideo = palettePage.video();
    if (!mainVideo || !paletteVideo) throw new Error("Electron video recording did not start");
    const blankStartedAt = Date.now();
    await recordPage.waitForTimeout(HOLD.blank);

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
    await palettePage.waitForTimeout(HOLD.palette);
    await paletteInput.pressSequentially(paletteQuery, { delay: TYPE_DELAY });
    const active = palettePage.locator(".palette-result.active");
    await active.waitFor({ state: "visible" });
    const activeText = await active.innerText();
    if (!activeText.includes(paletteQuery.split(" ")[0])) throw new Error(`active palette result mismatch: ${activeText}`);
    await palettePage.waitForTimeout(HOLD.results);
    const paletteBox = await palettePage.locator(".palette.standalone").boundingBox();
    if (!paletteBox) throw new Error("standalone palette bounds unavailable");

    const enterAt = Date.now();
    await paletteInput.press("Enter");
    await recordPage.waitForFunction((expected) => location.hash === expected, `#/pr/${repo}/${paletteNumber}`);
    await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes("#/palette"));
      if (!main) throw new Error("main PR window not found");
      main.webContents.setZoomFactor(0.85);
    });
    await recordPage.locator(".page .detail").first().waitFor({ state: "attached", timeout: 15_000 });
    await settle(recordPage);
    const slide = recordPage.getByAltText(paletteSlideAlt, { exact: true });
    await slide.waitFor({ state: "attached", timeout: 15_000 });
    await slide.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await settle(recordPage);
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
    const videoTime = (duration, wallTime) => Math.max(0, duration - (recordingEndedAt - wallTime) / 1000);
    const blankStart = TRIM_OVERRIDE ?? videoTime(mainRaw.duration, blankStartedAt);
    const paletteMainStart = videoTime(mainRaw.duration, paletteStartedAt);
    const palettePanelStart = videoTime(paletteRaw.duration, paletteStartedAt);
    const detailStart = videoTime(mainRaw.duration, detailVisibleAt);
    const blankDuration = (paletteStartedAt - blankStartedAt) / 1000;
    const paletteDuration = (enterAt - paletteStartedAt) / 1000;
    const detailDuration = (recordingEndedAt - detailVisibleAt) / 1000;
    const even = (value) => Math.max(2, Math.round(value / 2) * 2);
    const panel = {
      x: even(paletteBox.x),
      y: even(paletteBox.y),
      width: even(paletteBox.width),
      height: even(paletteBox.height),
    };
    const fitMain = `scale=${VIEWPORT.width}:${VIEWPORT.height}:force_original_aspect_ratio=decrease,pad=${VIEWPORT.width}:${VIEWPORT.height}:(ow-iw)/2:(oh-ih)/2:color=0xf5f5f3`;
    const filter = [
      `[0:v]trim=start=${blankStart.toFixed(3)}:duration=${blankDuration.toFixed(3)},setpts=PTS-STARTPTS,${fitMain}[blank]`,
      `[0:v]trim=start=${paletteMainStart.toFixed(3)}:duration=${paletteDuration.toFixed(3)},setpts=PTS-STARTPTS,${fitMain}[palette-bg]`,
      `[1:v]trim=start=${palettePanelStart.toFixed(3)}:duration=${paletteDuration.toFixed(3)},setpts=PTS-STARTPTS,crop=${panel.width}:${panel.height}:${panel.x}:${panel.y}[palette-card]`,
      `[palette-bg][palette-card]overlay=(W-w)/2:(H-h)/2[search]`,
      `[0:v]trim=start=${detailStart.toFixed(3)}:duration=${detailDuration.toFixed(3)},setpts=PTS-STARTPTS,${fitMain}[detail]`,
      "[blank][search][detail]concat=n=3:v=1:a=0,format=yuv420p[out]",
    ].join(";");

    const webmOutPath = join(OUT_DIR, "landing-search.webm");
    const mp4Path = join(OUT_DIR, "landing-search.mp4");
    const posterPath = join(OUT_DIR, "landing-search-poster.png");
    await run([
      "ffmpeg", "-y", "-i", mainVideoPath, "-i", paletteVideoPath,
      "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-crf", "22",
      "-preset", "slow", "-movflags", "+faststart", "-an", mp4Path,
    ], "ffmpeg compose");
    await run(["ffmpeg", "-y", "-i", mp4Path, "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-pix_fmt", "yuv420p", "-an", webmOutPath], "ffmpeg webm transcode");
    const posterSecond = blankDuration + HOLD.palette / 1000 + Math.max(0, paletteQuery.length - 1) * TYPE_DELAY / 1000 + 0.05;
    await run(["ffmpeg", "-y", "-ss", posterSecond.toFixed(3), "-i", mp4Path, "-frames:v", "1", posterPath], "ffmpeg poster");

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
      snapshot: SNAPSHOT_RELATIVE,
      capturedAt: snapshot.capturedAt,
      repo,
      pr: paletteNumber,
      prTitle: paletteTitle,
      query: paletteQuery,
      viewportCss: VIEWPORT,
      renderScale: 1,
      detailScale: 0.85,
      trimSeconds: Number(blankStart.toFixed(2)),
      shell: {
        runtime: "Electron",
        paletteWindow: { width: 680, height: 440 },
        trigger: "The isolated recorder presents the same standalone BrowserWindow bound to Command+Option+K; OS global-shortcut registration is not exercised.",
      },
      flow: ["blank PR Cockpit window", "standalone Electron search palette", `type word query at ${TYPE_DELAY}ms/char`, "Enter", `PR detail #/pr/${repo}/${paletteNumber}`],
      capturedPr: {
        changedLines: paletteDetail.additions + paletteDetail.deletions,
        additions: paletteDetail.additions,
        deletions: paletteDetail.deletions,
        mergeable: paletteDetail.mergeable,
        ci: paletteDetail.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? "NONE",
      },
      fixtureAugmentation: snapshot.fixtureAugmentations[String(paletteNumber)],
      video: { path: "docs/screenshots/landing-search.webm", codec: webmStream.codec_name, durationSeconds: Number(webmStream.duration.toFixed(2)), bytes: webmBytes },
      fallback: { path: "docs/screenshots/landing-search.mp4", codec: stream.codec_name, durationSeconds: Number(stream.duration.toFixed(2)), bytes: mp4Bytes },
      poster: { path: "docs/screenshots/landing-search-poster.png", scene: "standalone Electron palette with word query", bytes: posterBytes },
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
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
