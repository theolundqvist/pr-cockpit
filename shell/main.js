const { app, BrowserWindow, shell, Menu, globalShortcut, Tray, nativeTheme, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");
const { windowBoundsForPersistence, windowBoundsForRestore } = require("./windowBounds");
const { launchEditorTerminal } = require("./editorLaunch");

app.setName("PR Cockpit");

// Only scripts/cockpit (the installed app) sets COCKPIT_MANAGED; every other launch is an isolated dev instance.
const isManaged = process.env.COCKPIT_MANAGED === "1";
if (!isManaged) {
  app.setPath("userData", app.getPath("userData") + "-dev");
  console.log("pr-cockpit: dev instance — isolated userData, no protocol/shortcut registration, temp data dir");
}

if (isManaged) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient("prcockpit", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("prcockpit");
  }
}

function cockpitUrlFromArgv(argv) {
  const flag = argv.find((a) => a.startsWith("--cockpit-url="));
  return flag ? flag.slice("--cockpit-url=".length) : null;
}

function modeFromUrl(urlStr) {
  try {
    return /^#\/pr\//.test(new URL(urlStr).hash) ? "detail" : "list";
  } catch {
    return "list";
  }
}

// Do not use Chromium's generic --hidden switch: it prevents a macOS window
// from being shown later. This is an application-only launch instruction.
const startHidden = process.argv.includes("--cockpit-hidden");
const initialUrl = cockpitUrlFromArgv(process.argv) || process.env.COCKPIT_URL || "http://127.0.0.1:4820";
const serverOrigin = new URL(initialUrl).origin;
const paletteUrl = `${serverOrigin}/#/palette`;
const DEFAULT_OPEN_APP = "Command+Control+G";
const DEFAULT_OPEN_PALETTE = "Command+Option+K";

const boundsFile = path.join(app.getPath("userData"), "window-bounds.json");
const zoomFile = path.join(app.getPath("userData"), "zoom-level.json");
const ZOOM_LEVEL_MIN = -8;
const ZOOM_LEVEL_MAX = 8;

function loadZoomLevel() {
  try {
    return JSON.parse(fs.readFileSync(zoomFile, "utf8")).level ?? 0;
  } catch {
    return 0;
  }
}

function saveZoomLevel(level) {
  try {
    fs.writeFileSync(zoomFile, JSON.stringify({ level }));
  } catch (err) {
    console.error("pr-cockpit: failed to save zoom level", err);
  }
}

const dataDir =
  process.env.COCKPIT_DATA_DIR || (isManaged ? path.join(__dirname, "..", "data") : path.join(os.tmpdir(), "pr-cockpit-dev"));
const pidFile = path.join(dataDir, "shell.pid");

function loadAllBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile, "utf8"));
  } catch {
    return {};
  }
}

function saveModeBounds(mode, bounds) {
  const all = loadAllBounds();
  all[mode] = windowBoundsForPersistence(bounds, perViewSizeEnabled, perViewPositionEnabled);
  try {
    fs.writeFileSync(boundsFile, JSON.stringify(all));
  } catch (err) {
    console.error("pr-cockpit: failed to save window bounds", err);
  }
}

async function fetchSettings() {
  try {
    const res = await fetch(`${serverOrigin}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let perViewSizeEnabled = false;
let perViewPositionEnabled = false;
let shellThemePreference = "system";
let win = null;
let paletteWin = null;

function normalizeThemePreference(value) {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function windowBackgroundColor() {
  const isLight = shellThemePreference === "light" || (shellThemePreference === "system" && !nativeTheme.shouldUseDarkColors);
  return isLight ? "#ffffff" : "#0a0d12";
}

function syncWindowBackground() {
  const backgroundColor = windowBackgroundColor();
  if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor);
  if (paletteWin && !paletteWin.isDestroyed()) paletteWin.setBackgroundColor("#00000000");
}

function applyShellSettings(data) {
  if (!data) return;
  perViewSizeEnabled = data.per_view_window_size === true;
  perViewPositionEnabled = data.per_view_window_position === true;
  shellThemePreference = normalizeThemePreference(data.theme);
  syncWindowBackground();
}

let updating = false;

function quitPrCockpit() {
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  function writePidFile() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const started = execSync(`ps -o lstart= -p ${process.pid}`).toString().trim();
      fs.writeFileSync(pidFile, `${process.pid}\n${started}\n`);
    } catch (err) {
      console.error("pr-cockpit: failed to write pidfile", err);
    }
  }

  function removePidFile() {
    try {
      if (fs.readFileSync(pidFile, "utf8").split("\n")[0].trim() === String(process.pid)) fs.unlinkSync(pidFile);
    } catch {
      // pidfile gone or owned by a newer instance
    }
  }

  let tray = null;
  let currentMode = modeFromUrl(initialUrl);
  let boundsRestoreGeneration = 0;
  let boundsNavigationGeneration = 0;
  let boundsNavigationPending = 0;
  let initialBoundsRestoreComplete = false;
  let boundsSaveTimer = null;
  let isQuitting = false;
  let pendingMainUrl = null;
  let pendingMainShow = false;
  let mainWindowReadyToShow = false;
  let pendingDeepLink = null;
  let mainRetryTimer = null;
  let mainReady = false;
  let mainLoadFailed = false;
  let handingOff = false;
  let zoomLevel = loadZoomLevel();
  // Keep Dock transitions edge-triggered. Repeating app.dock.show() while the
  // launcher, tray, or global shortcut all try to reveal the app makes the
  // tile visibly flash on macOS.
  let dockIconVisible = null;

  function deepLinkParts(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "prcockpit:" || u.host !== "pr") return null;
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.length === 3 ? parts : null;
    } catch {
      return null;
    }
  }

  function deepLinkHash(url) {
    const parts = deepLinkParts(url);
    return parts ? `#/pr/${parts[0]}/${parts[1]}/${parts[2]}` : null;
  }

  function showMainWindow() {
    if (!win || win.isDestroyed()) {
      pendingMainShow = true;
      return false;
    }
    if (!mainWindowReadyToShow) {
      // A hidden macOS window may not finish its first frame until a show is
      // requested. Keep the reveal pending so the ready handler focuses it.
      pendingMainShow = true;
      showDockIcon();
      win.show();
      return true;
    }
    pendingMainShow = false;
    if (win.isMinimized()) win.restore();
    showDockIcon();
    win.show();
    win.focus();
    app.focus({ steal: true });
    return true;
  }

  function showDockIcon() {
    if (process.platform !== "darwin" || dockIconVisible === true) return;
    app.setActivationPolicy("regular");
    app.dock.show();
    dockIconVisible = true;
  }

  function hideDockIcon() {
    if (process.platform !== "darwin" || dockIconVisible === false) return;
    app.dock.hide();
    dockIconVisible = false;
  }

  // ⌘W closes the visible surface, but a running app keeps its Dock tile.
  function hideMainWindow() {
    if (!win || win.isDestroyed()) return;
    win.hide();
  }

  function hideAppFromDock() {
    hideMainWindow();
    if (paletteWin && !paletteWin.isDestroyed()) paletteWin.hide();
    hideDockIcon();
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Hide PR Cockpit", accelerator: "Command+Q", click: hideAppFromDock },
          { type: "separator" },
          { label: "Quit PR Cockpit", click: quitPrCockpit },
        ],
      },
      { label: "File", submenu: [{ role: "close" }] },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }] },
      { role: "windowMenu" },
    ]),
  );

  // The lightweight Finder wrapper wakes the launch-agent-owned app with a
  // benign signal instead of starting a second Electron process.
  process.on("SIGWINCH", () => {
    if (!isQuitting) showMainWindow();
  });
  // The launcher waits for this pidfile before sending SIGWINCH, so a launch
  // race cannot lose the reveal request while Electron is still booting.
  writePidFile();

  // Cold prcockpit:// click launches the bundle directly (unmanaged, no server); hand off to the installed launcher.
  function handOffToManaged(url) {
    handingOff = true;
    const parts = deepLinkParts(url);
    const installedLauncher = path.join(os.homedir(), "Library", "Application Support", "PR Cockpit", "launch");
    const usesInstalledLauncher = !process.env.COCKPIT_LAUNCHER && fs.existsSync(installedLauncher);
    const cockpit =
      process.env.COCKPIT_LAUNCHER || (usesInstalledLauncher ? installedLauncher : path.join(__dirname, "..", "scripts", "cockpit"));
    const env = usesInstalledLauncher
      ? { ...process.env, COCKPIT_ROOT: path.join(__dirname, ".."), COCKPIT_LAUNCHER: cockpit, COCKPIT_NO_BUILD: "1" }
      : process.env;
    spawn(cockpit, parts ? [`${parts[0]}/${parts[1]}#${parts[2]}`] : [], { detached: true, stdio: "ignore", env }).unref();
    quitPrCockpit();
  }

  function openDeepLink(url) {
    const hash = deepLinkHash(url);
    if (!hash) return;
    if (win && !win.isDestroyed() && mainReady) {
      clearTimeout(mainRetryTimer);
      win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      showMainWindow();
    } else {
      pendingDeepLink = hash;
    }
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!isManaged) {
      handOffToManaged(url);
      return;
    }
    openDeepLink(url);
  });

  function flushPendingBoundsSave() {
    if (!boundsSaveTimer) return;
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
    if ((perViewSizeEnabled || perViewPositionEnabled) && win && !win.isDestroyed()) saveModeBounds(currentMode, win.getBounds());
  }

  async function killServerAndQuit() {
    try {
      await fetch(`${serverOrigin}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
    } catch {
      // server may already be dead
    }
    quitPrCockpit();
  }

  function showUpdateFailed(reason) {
    if (win && !win.isDestroyed()) {
      win.webContents
        .executeJavaScript(`window.cockpitFlash && window.cockpitFlash(${JSON.stringify("Update failed: " + reason)})`)
        .catch(() => {});
    }
  }

  function updateAndRestart() {
    if (updating) return;
    updating = true;
    flushPendingBoundsSave();
    const updateScript = path.join(__dirname, "..", "scripts", "update");
    const child = spawn(updateScript, [], {
      cwd: path.join(__dirname, ".."),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let handedOff = false;
    let stdout = "";
    let stderr = "";
    // Quit only once the pull succeeded; a failed pull keeps the app running and surfaces the error.
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!handedOff && stdout.includes("PULL_OK")) {
        handedOff = true;
        // The updater replaces this bundle immediately after the pull succeeds.
        app.exit(0);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", (err) => {
      if (handedOff) return;
      console.error("pr-cockpit: failed to spawn update script", err);
      updating = false;
      showUpdateFailed(err.message);
    });
    child.once("exit", () => {
      if (handedOff) return;
      updating = false;
      const match = stderr.match(/UPDATE_FAILED (.*)/);
      showUpdateFailed(match ? match[1].trim() : "update failed");
    });
    child.unref();
  }

  // Cmd+Q is handled by the custom Hide PR Cockpit menu action. All actual
  // macOS Quit commands (the app menu, Dock, and tray) should still terminate.
  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcut.unregisterAll();
    flushPendingBoundsSave();
  });

  app.on("will-quit", () => {
    removePidFile();
  });

  app.on("second-instance", (event, argv) => {
    // launchd may retry its hidden foreground-shell job while another managed
    // instance still owns Electron's lock. That is a background ownership
    // collision, not a request to reveal the UI.
    if (argv.includes("--cockpit-hidden")) return;
    const url = cockpitUrlFromArgv(argv);
    if (!win || win.isDestroyed()) {
      if (url) pendingMainUrl = url;
      pendingMainShow = true;
      return;
    }
    if (url && url !== win.webContents.getURL()) {
      clearTimeout(mainRetryTimer);
      win.loadURL(url);
    }
    showMainWindow();
  });

  app.on("activate", () => {
    showMainWindow();
  });

  app.on("window-all-closed", () => {});

  app.whenReady().then(async () => {
    if (handingOff) return;
    if (process.platform === "darwin") {
      if (startHidden) hideDockIcon();
      else showDockIcon();
    }

    const firstUrl = pendingMainUrl || initialUrl;
    currentMode = modeFromUrl(firstUrl);

    win = new BrowserWindow({
      width: 1440,
      height: 900,
      backgroundColor: windowBackgroundColor(),
      titleBarStyle: "hiddenInset",
      webPreferences: { sandbox: true, preload: path.join(__dirname, "preload.js") },
      show: false,
    });

    win.once("ready-to-show", () => {
      mainWindowReadyToShow = true;
      if (!startHidden || pendingMainShow) showMainWindow();
    });
    ipcMain.handle("cockpit:open-editor", async (_event, payload) => {
      const repo = payload?.repo;
      const number = payload?.number;
      const editorTarget = payload?.target;
      if (
        typeof repo !== "string" ||
        !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
        !Number.isInteger(number) ||
        (editorTarget !== null &&
          editorTarget !== undefined &&
          (typeof editorTarget !== "object" ||
            typeof editorTarget.path !== "string" ||
            (editorTarget.line !== null && (!Number.isInteger(editorTarget.line) || editorTarget.line <= 0))))
      ) {
        return { error: "bad editor request" };
      }
      let checkout;
      let target;
      try {
        const query = editorTarget ? `?file=${encodeURIComponent(editorTarget.path)}` : "";
        const res = await fetch(`${serverOrigin}/api/pr/${repo}/${number}/checkout${query}`);
        const body = await res.json();
        if (!res.ok) return { error: body.error || `checkout materialization failed (${res.status})` };
        if (typeof body.path !== "string" || !path.isAbsolute(body.path)) return { error: "server returned an invalid checkout path" };
        if (typeof body.target !== "string" || !path.isAbsolute(body.target)) return { error: "server returned an invalid editor target" };
        checkout = body.path;
        target = body.target;
        const checkoutPrefix = checkout.endsWith(path.sep) ? checkout : `${checkout}${path.sep}`;
        if (target !== checkout && !target.startsWith(checkoutPrefix)) return { error: "editor target escapes the checkout" };
      } catch (err) {
        return { error: `checkout materialization failed: ${err.message}` };
      }
      if (!win || win.isDestroyed()) return { error: "editor launch failed: no cockpit window" };
      const result = await launchEditorTerminal(checkout, target, editorTarget?.line ?? null, win.getBounds());
      return result.error ? { error: `editor launch failed: ${result.error}` } : result;
    });

    // Settings only tune background + per-view bounds; fetch them off the first-paint path and apply on arrival.
    fetchSettings()
      .then((settings) => {
        if (!win || win.isDestroyed() || !settings) return;
        applyShellSettings(settings);
        if (perViewSizeEnabled || perViewPositionEnabled) {
          const stored = loadAllBounds()[currentMode];
          if (stored) win.setBounds(windowBoundsForRestore(win.getBounds(), stored, perViewSizeEnabled, perViewPositionEnabled));
        }
      })
      .finally(() => {
        initialBoundsRestoreComplete = true;
      });

    nativeTheme.on("updated", () => {
      if (shellThemePreference === "system") syncWindowBackground();
    });

    tray = new Tray(path.join(__dirname, "..", "assets", "tray-iconTemplate.png"));
    tray.setToolTip("PR Cockpit");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show Cockpit",
          click: showMainWindow,
        },
        { type: "separator" },
        { label: "Update & Restart", click: updateAndRestart },
        { label: "Kill Server & Quit", click: killServerAndQuit },
        { type: "separator" },
        { label: "Quit PR Cockpit", click: quitPrCockpit },
      ]),
    );
    tray.on("click", showMainWindow);

    function applyZoom(level) {
      zoomLevel = Math.max(ZOOM_LEVEL_MIN, Math.min(ZOOM_LEVEL_MAX, level));
      win.webContents.zoomLevel = zoomLevel;
      saveZoomLevel(zoomLevel);
    }

    // Full page loads reset webContents.zoomLevel to 0, so reapply it on every did-finish-load below.
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !input.meta || input.control || input.alt) return;
      if (input.key === "=" || input.key === "+") {
        applyZoom(zoomLevel + 1);
        event.preventDefault();
      } else if (input.key === "-") {
        applyZoom(zoomLevel - 1);
        event.preventDefault();
      } else if (input.key === "0") {
        applyZoom(0);
        event.preventDefault();
      }
    });

    win.webContents.on("did-finish-load", () => {
      win.webContents.zoomLevel = zoomLevel;
      if (mainLoadFailed) {
        mainLoadFailed = false; // Chromium fires did-finish-load for its error page after did-fail-load
        return;
      }
      mainReady = true;
      if (pendingDeepLink) {
        const hash = pendingDeepLink;
        pendingDeepLink = null;
        win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
        showMainWindow();
      }
    });

    function reloadMain() {
      clearTimeout(mainRetryTimer);
      if (!win || win.isDestroyed()) return;
      mainReady = false;
      win.loadURL(initialUrl);
    }
    win.webContents.on("did-fail-load", (event, errorCode, desc, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 ERR_ABORTED: a load we superseded, not a real failure
      mainReady = false;
      mainLoadFailed = true;
      mainRetryTimer = setTimeout(reloadMain, 1500);
    });
    win.webContents.on("render-process-gone", reloadMain);

    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    win.webContents.on("did-navigate-in-page", async (event, url) => {
      applyShortcuts();
      const navigationGeneration = ++boundsNavigationGeneration;
      const newMode = modeFromUrl(url);
      const prevMode = currentMode;
      const modeChanged = newMode !== prevMode;
      const supersedesPendingNavigation = boundsNavigationPending !== 0;
      let prevBounds = null;
      if (modeChanged) {
        flushPendingBoundsSave();
        prevBounds = win.getBounds();
        currentMode = newMode;
        boundsNavigationPending = navigationGeneration;
      }

      const settings = await fetchSettings();
      if (navigationGeneration !== boundsNavigationGeneration || currentMode !== newMode || win.isDestroyed()) {
        if (boundsNavigationPending === navigationGeneration) boundsNavigationPending = 0;
        return;
      }
      applyShellSettings(settings);
      if (!modeChanged) return;
      if (!perViewSizeEnabled && !perViewPositionEnabled) {
        boundsNavigationPending = 0;
        return;
      }
      if (initialBoundsRestoreComplete && !supersedesPendingNavigation && !boundsRestoreGeneration) {
        saveModeBounds(prevMode, prevBounds);
      }
      const stored = loadAllBounds()[newMode];
      if (!stored) {
        boundsNavigationPending = 0;
        return;
      }
      boundsRestoreGeneration = navigationGeneration;
      try {
        await win.webContents.executeJavaScript(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
      } catch {
        if (boundsRestoreGeneration === navigationGeneration) boundsRestoreGeneration = 0;
        if (boundsNavigationPending === navigationGeneration) boundsNavigationPending = 0;
        return;
      }
      if (navigationGeneration === boundsNavigationGeneration && currentMode === newMode && !win.isDestroyed()) {
        win.setBounds(windowBoundsForRestore(win.getBounds(), stored, perViewSizeEnabled, perViewPositionEnabled));
      }
      if (boundsRestoreGeneration === navigationGeneration) boundsRestoreGeneration = 0;
      if (boundsNavigationPending === navigationGeneration) boundsNavigationPending = 0;
    });

    function scheduleBoundsSave() {
      if (boundsNavigationPending) return;
      clearTimeout(boundsSaveTimer);
      boundsSaveTimer = setTimeout(() => {
        if (!win || win.isDestroyed() || boundsNavigationPending) return;
        saveModeBounds(currentMode, win.getBounds());
      }, 500);
    }
    win.on("resize", () => {
      if (perViewSizeEnabled) scheduleBoundsSave();
    });
    win.on("move", () => {
      if (perViewPositionEnabled) scheduleBoundsSave();
    });

    win.on("close", (e) => {
      if (isQuitting) return;
      e.preventDefault();
      hideMainWindow();
    });

    // Pick up freshly-saved keybinds. Blur is when you'd leave the app to test a global
    // shortcut; the guard inside applyShortcuts makes the settings re-read a no-op unless
    // something changed. ponytail: no renderer→main IPC, so this leans on blur + navigation.
    win.on("blur", () => applyShortcuts());

    win.on("swipe", (event, direction) => {
      const history = win.webContents.navigationHistory;
      if (direction === "left" && history.canGoBack()) history.goBack();
      else if (direction === "right" && history.canGoForward()) history.goForward();
    });

    win.loadURL(firstUrl);

    paletteWin = new BrowserWindow({
      width: 680,
      height: 440,
      // nonactivating NSPanel: takes keyboard focus while another app stays active —
      // app.focus({steal:true}) is ignored by modern macOS cooperative activation
      type: "panel",
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: { sandbox: true },
    });
    let paletteReady = false;
    let paletteRetryTimer = null;
    let paletteLoadFailed = false;
    let paletteLoading = false;
    let paletteShowPending = false;
    function loadPalette() {
      clearTimeout(paletteRetryTimer);
      if (!paletteWin || paletteWin.isDestroyed() || paletteLoading) return;
      paletteReady = false;
      paletteLoading = true;
      paletteWin.loadURL(paletteUrl).catch(() => {});
    }
    loadPalette();
    paletteWin.webContents.on("did-finish-load", () => {
      paletteLoading = false;
      if (paletteLoadFailed) {
        paletteLoadFailed = false; // Chromium fires did-finish-load for its own error page after did-fail-load
        return;
      }
      paletteReady = true;
      if (paletteShowPending) presentPalette();
    });
    paletteWin.webContents.on("did-fail-load", (event, errorCode, desc, url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 ERR_ABORTED: a load we superseded, not a real failure
      paletteReady = false;
      paletteLoading = false;
      paletteLoadFailed = true;
      paletteWin.hide();
      paletteRetryTimer = setTimeout(loadPalette, 1500);
    });
    paletteWin.webContents.on("render-process-gone", (event, details) => {
      if (isQuitting || !paletteWin || paletteWin.isDestroyed()) return;
      paletteShowPending ||= paletteWin.isVisible();
      paletteReady = false;
      paletteLoading = false;
      paletteWin.hide();
      console.error(`pr-cockpit: palette renderer gone (${details.reason}, exitCode=${details.exitCode})`);
      loadPalette();
    });
    paletteWin.on("blur", () => {
      paletteShowPending = false;
      paletteWin.hide();
    });
    paletteWin.on("close", (e) => {
      if (isQuitting) return;
      e.preventDefault();
      paletteShowPending = false;
      paletteWin.hide();
    });
    paletteWin.webContents.on("did-navigate-in-page", (event, url) => {
      const hash = new URL(url).hash;
      const go = hash.match(/^#\/palette\/go\/(.+)$/);
      if (go) {
        win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/pr/${go[1]}`)}`);
        showMainWindow();
      } else if (hash !== "#/palette/close") {
        return;
      }
      paletteShowPending = false;
      paletteWin.hide();
      paletteWin.webContents.executeJavaScript("history.replaceState(null, '', '#/palette')").catch(() => {});
    });

    function presentPalette() {
      if (isQuitting || !paletteWin || paletteWin.isDestroyed() || !paletteReady) return;
      paletteShowPending = false;
      paletteWin.webContents
        .executeJavaScript("window.dispatchEvent(new Event('cockpit:open-palette'))")
        .catch(() => {});
      paletteWin.center();
      paletteWin.show();
      paletteWin.focus();
      paletteWin.webContents.focus();
    }

    function showPalette() {
      if (isQuitting || !paletteWin || paletteWin.isDestroyed()) return;
      if (!paletteReady) {
        paletteShowPending = true;
        loadPalette();
        return;
      }
      presentPalette();
    }

    function flashRenderer(message) {
      win.webContents
        .executeJavaScript(`window.cockpitFlash && window.cockpitFlash(${JSON.stringify(message)})`)
        .catch(() => {});
    }

    function registerOrDefault(accelerator, fallback, handler) {
      try {
        if (globalShortcut.register(accelerator, handler)) return;
      } catch {
        // malformed accelerator string
      }
      console.error(`pr-cockpit: failed to register global shortcut ${accelerator}`);
      flashRenderer(
        accelerator === fallback
          ? `Couldn't register the shortcut ${accelerator} — another app may be using it.`
          : `Couldn't register the shortcut ${accelerator} — falling back to ${fallback}.`,
      );
      if (accelerator !== fallback) globalShortcut.register(fallback, handler);
    }

    let appliedApp = null;
    let appliedPalette = null;

    async function applyShortcuts() {
      const settings = await fetchSettings();
      shellThemePreference = normalizeThemePreference(settings?.theme);
      syncWindowBackground();
      if (!isManaged) return; // dev instance: don't steal the installed app's global shortcuts
      const openApp = settings?.keybind_open_app || DEFAULT_OPEN_APP;
      const openPalette = settings?.keybind_open_palette || DEFAULT_OPEN_PALETTE;
      if (openApp === appliedApp && openPalette === appliedPalette) return;
      appliedApp = openApp;
      appliedPalette = openPalette;
      globalShortcut.unregisterAll();
      registerOrDefault(openApp, DEFAULT_OPEN_APP, showMainWindow);
      registerOrDefault(openPalette, DEFAULT_OPEN_PALETTE, showPalette);
    }

    applyShortcuts();
  });
}
