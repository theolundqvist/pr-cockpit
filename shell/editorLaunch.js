const fs = require("fs");
const { spawn, execFileSync } = require("child_process");

function editorCommand(env) {
  return env.VISUAL || env.EDITOR || "nvim";
}

// A packaged GUI app's PATH usually lacks homebrew/cargo bins, so probe known
// locations before falling back to the login shell's PATH.
let resolvedAlacrittyBin;
function alacrittyBin(env) {
  if (resolvedAlacrittyBin !== undefined) return resolvedAlacrittyBin;
  const candidates = [
    "/Applications/Alacritty.app/Contents/MacOS/alacritty",
    `${env.HOME}/Applications/Alacritty.app/Contents/MacOS/alacritty`,
    "/opt/homebrew/bin/alacritty",
    "/usr/local/bin/alacritty",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return (resolvedAlacrittyBin = candidate);
  }
  try {
    const found = execFileSync(env.SHELL || "/bin/sh", ["-lc", "command -v alacritty"], {
      encoding: "utf8",
      timeout: 3000,
      killSignal: "SIGKILL",
    }).trim();
    return (resolvedAlacrittyBin = found || null);
  } catch {
    return (resolvedAlacrittyBin = null);
  }
}

// A tiling window manager re-places new windows, defeating exact bounds. Register
// a float rule for our uniquely-titled window first; harmless no-op without yabai.
function floatEditorWindowInYabai() {
  const candidates = ["/opt/homebrew/bin/yabai", "/usr/local/bin/yabai"];
  const bin = candidates.find((c) => fs.existsSync(c));
  if (!bin) return;
  const rule = ["label=pr-cockpit-editor", "app=^Alacritty$", "title=^pr-cockpit-editor", "manage=off"];
  try {
    // --add self-replaces the same label atomically; a bounded timeout keeps a
    // hung yabai socket from freezing the Electron main process.
    execFileSync(bin, ["-m", "rule", "--add", ...rule], { stdio: "ignore", timeout: 300, killSignal: "SIGKILL" });
  } catch {}
}

const appleQuote = (value) => `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function editorInvocation(target, line, env) {
  const command = editorCommand(env);
  const executable = command.trim().split(/\s+/, 1)[0] || "";
  const name = executable.slice(executable.lastIndexOf("/") + 1);
  const lineOption = line && /^(?:vi|[gm]?vim|nvim|view)$/.test(name) ? ` +${line}` : "";
  return `${command}${lineOption} -- ${shellQuote(target)}`;
}

// Alacritty positions in pixels but sizes in cells; launch with the exact position
// plus a rough cell estimate so the window appears near-right immediately, then let
// System Events set the exact pixel size (needs the Accessibility permission).
function launchAlacritty(bin, dir, target, line, bounds, env) {
  const title = `pr-cockpit-editor-${Date.now()}`;
  const shell = env.SHELL || "/bin/zsh";
  floatEditorWindowInYabai();
  const script = `
    tell application "System Events"
      repeat 20 times
        if exists (first window of process "Alacritty" whose name is ${appleQuote(title)}) then
          tell (first window of process "Alacritty" whose name is ${appleQuote(title)})
            set position to {${bounds.x}, ${bounds.y}}
            set size to {${bounds.width}, ${bounds.height}}
          end tell
          return
        end if
        delay 0.1
      end repeat
      error "window never appeared"
    end tell`;
  return new Promise((resolve) => {
    const proc = spawn(bin, [
      "--title", title,
      "-o", "window.dynamic_title=false",
      "-o", `window.position={x=${bounds.x},y=${bounds.y}}`,
      "-o", `window.dimensions={columns=${Math.max(80, Math.round(bounds.width / 9))},lines=${Math.max(24, Math.round(bounds.height / 20))}}`,
      "--working-directory", dir,
      "-e", shell, "-ilc", editorInvocation(target, line, env),
    ], { detached: true, stdio: "ignore" });
    proc.on("error", (err) => resolve({ error: `Alacritty launch failed: ${err.message}` }));
    proc.unref();

    const osa = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    osa.stderr.on("data", (chunk) => (stderr += chunk));
    osa.on("close", (code) => {
      if (code === 0) return resolve({ ok: true });
      const denied = /not allowed assistive access|osascript is not allowed/i.test(stderr);
      resolve({
        ok: true,
        warning: denied
          ? "Editor opened, but exact sizing needs Accessibility permission for PR Cockpit."
          : "Editor opened, but the window couldn't be resized exactly.",
      });
    });
    osa.on("error", () => resolve({ ok: true, warning: "Editor opened, but osascript is unavailable." }));
  });
}

// Terminal.app is AppleScript-native: exact pixel bounds, no Accessibility permission.
function launchAppleTerminal(dir, target, line, bounds, env) {
  const command = `cd ${shellQuote(dir)} && ${editorInvocation(target, line, env)}`;
  const script = `
    tell application "Terminal"
      activate
      set editorTab to do script ${appleQuote(command)}
      set bounds of front window to {${bounds.x}, ${bounds.y}, ${bounds.x + bounds.width}, ${bounds.y + bounds.height}}
    end tell`;
  return new Promise((resolve) => {
    const osa = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    osa.stderr.on("data", (chunk) => (stderr += chunk));
    osa.on("close", (code) => resolve(code === 0 ? { ok: true } : { error: `Terminal launch failed: ${stderr.trim()}` }));
    osa.on("error", (err) => resolve({ error: `Terminal launch failed: ${err.message}` }));
  });
}

function launchLinuxTerminal(dir, target, line, bounds, env) {
  const terminal = env.TERMINAL || "x-terminal-emulator";
  return new Promise((resolve) => {
    const proc = spawn(terminal, ["-e", env.SHELL || "/bin/sh", "-ilc", `cd ${shellQuote(dir)} && ${editorInvocation(target, line, env)}`], {
      detached: true,
      stdio: "ignore",
    });
    proc.on("error", (err) => resolve({ error: `terminal launch failed: ${err.message}` }));
    proc.unref();
    // spawn reports ENOENT asynchronously; give it a tick before declaring success
    setTimeout(() => resolve({ ok: true, warning: "Window bounds aren't applied on this platform." }), 100);
  });
}

// bounds = the cockpit BrowserWindow's current getBounds(); returns { ok, warning? } | { error }
async function launchEditorTerminal(dir, target, line, bounds, env = process.env, platform = process.platform) {
  if (platform !== "darwin") return launchLinuxTerminal(dir, target, line, bounds, env);
  const alacritty = alacrittyBin(env);
  if (alacritty) return launchAlacritty(alacritty, dir, target, line, bounds, env);
  return launchAppleTerminal(dir, target, line, bounds, env);
}

module.exports = { launchEditorTerminal, editorCommand, editorInvocation, alacrittyBin };
