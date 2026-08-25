const fs = require("fs");
const { randomUUID } = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { tmpdir } = require("os");
const { join } = require("path");

function editorCommand(env) {
  return env.EDITOR || env.VISUAL || "vi";
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
let yabaiRuleRegistered = false;
function floatEditorWindowInYabai() {
  if (yabaiRuleRegistered) return;
  yabaiRuleRegistered = true;
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

function editorCompletion(target, line, env) {
  const dir = fs.mkdtempSync(join(tmpdir(), "pr-cockpit-editor-"));
  const marker = join(dir, "done");
  let settled = false;
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  const finish = (result) => {
    if (settled) return;
    settled = true;
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
    resolve(result);
  };
  const readMarker = () => {
    let value;
    try {
      value = fs.readFileSync(marker, "utf8").trim();
    } catch {
      return;
    }
    if (!/^\d+$/.test(value)) {
      setTimeout(readMarker, 5);
      return;
    }
    finish({ ok: true, exitCode: Number(value) });
  };
  const watcher = fs.watch(dir, (_event, name) => {
    if (name === "done") readMarker();
  });
  const writeMarker = `status=$?; printf '%s' "$status" > ${shellQuote(marker)}`;
  const invocation = `trap ${shellQuote(writeMarker)} EXIT HUP TERM INT; ${editorInvocation(target, line, env)}; status=$?; trap - EXIT HUP TERM INT; printf '%s' "$status" > ${shellQuote(marker)}`;
  return {
    invocation,
    promise,
    fail: (error) => finish({ error }),
  };
}

function trackTerminalProcess(proc, completion, label) {
  proc.once("error", (err) => completion.fail(`${label} launch failed: ${err.message}`));
  proc.once("close", (code) => {
    if (code !== 0) setTimeout(() => completion.fail(`${label} closed before the editor exited.`), 100);
  });
  proc.unref();
}

function launchAlacritty(bin, dir, target, line, bounds, env) {
  const title = `pr-cockpit-editor-${Date.now()}`;
  const shell = env.SHELL || "/bin/zsh";
  const completion = editorCompletion(target, line, env);
  floatEditorWindowInYabai();
  const proc = spawn(bin, [
    "--title", title,
    "-o", "window.dynamic_title=false",
    "-o", `window.position={x=${bounds.x},y=${bounds.y}}`,
    "-o", `window.dimensions={columns=${Math.max(80, Math.round(bounds.width / 9))},lines=${Math.max(24, Math.round(bounds.height / 20))}}`,
    "--working-directory", dir,
    "-e", shell, "-lc", completion.invocation,
  ], { detached: true, stdio: "ignore" });
  trackTerminalProcess(proc, completion, "Alacritty");
  return completion.promise;
}

function launchAppleTerminal(dir, target, line, bounds, env) {
  const completion = editorCompletion(target, line, env);
  const command = `cd ${shellQuote(dir)} && ${completion.invocation}`;
  const script = `
    tell application "Terminal"
      activate
      do script ${appleQuote(command)}
      set bounds of front window to {${bounds.x}, ${bounds.y}, ${bounds.x + bounds.width}, ${bounds.y + bounds.height}}
    end tell`;
  const osa = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  osa.stderr.on("data", (chunk) => (stderr += chunk));
  osa.on("close", (code) => {
    if (code !== 0) completion.fail(`Terminal launch failed: ${stderr.trim()}`);
  });
  osa.on("error", (err) => completion.fail(`Terminal launch failed: ${err.message}`));
  return completion.promise;
}

function launchLinuxTerminal(dir, target, line, bounds, env) {
  const terminal = env.TERMINAL || "x-terminal-emulator";
  const completion = editorCompletion(target, line, env);
  const proc = spawn(terminal, ["-e", env.SHELL || "/bin/sh", "-lc", `cd ${shellQuote(dir)} && ${completion.invocation}`], {
    detached: true,
    stdio: "ignore",
  });
  trackTerminalProcess(proc, completion, "Terminal");
  return completion.promise;
}

// bounds = the cockpit BrowserWindow's current getBounds(); resolves when the editor exits.
async function launchEditorTerminal(dir, target, line, bounds, env = process.env, platform = process.platform) {
  if (platform !== "darwin") return launchLinuxTerminal(dir, target, line, bounds, env);
  const alacritty = alacrittyBin(env);
  if (alacritty) return launchAlacritty(alacritty, dir, target, line, bounds, env);
  return launchAppleTerminal(dir, target, line, bounds, env);
}

const editorSessions = new Map();

function headFile(checkout, relativePath) {
  const result = spawnSync("git", ["-C", checkout, "show", `HEAD:${relativePath}`], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString().trim() || `${relativePath} is unavailable at the PR head`);
  }
  return result.stdout;
}

async function runEditorSession(checkout, target, relativePath, line, bounds, env = process.env, platform = process.platform) {
  let baseline;
  try {
    baseline = headFile(checkout, relativePath);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const result = await launchEditorTerminal(checkout, target, line, bounds, env, platform);
  if (result.error) return result;

  let edited;
  try {
    edited = fs.readFileSync(target);
  } catch (err) {
    return { error: `Couldn't read the edited file: ${err.message}` };
  }
  if (edited.equals(baseline)) {
    if (result.exitCode) return { error: `Editor exited with status ${result.exitCode}.` };
    return { ...result, changed: false };
  }
  const content = edited.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(edited)) {
    return { error: "The edited file is not UTF-8 and can't be reviewed in PR Cockpit." };
  }
  const sessionId = randomUUID();
  editorSessions.set(sessionId, { target, baseline, edited });
  return {
    ...result,
    changed: true,
    content,
    sessionId,
    warning: result.exitCode ? `Editor exited with status ${result.exitCode}; review the saved changes before committing.` : result.warning,
  };
}

function finishEditorSession(sessionId) {
  const session = editorSessions.get(sessionId);
  if (!session) return { error: "Editor session expired; the worktree changes were preserved." };
  let current;
  try {
    current = fs.readFileSync(session.target);
  } catch (err) {
    return { error: `Couldn't inspect the edited file: ${err.message}` };
  }
  if (!current.equals(session.edited)) {
    return { error: "The file changed again; the worktree changes were preserved." };
  }
  try {
    fs.writeFileSync(session.target, session.baseline);
  } catch (err) {
    return { error: `Couldn't clean the editor worktree: ${err.message}` };
  }
  editorSessions.delete(sessionId);
  return { ok: true };
}

module.exports = {
  launchEditorTerminal,
  runEditorSession,
  finishEditorSession,
  editorCommand,
  editorInvocation,
  alacrittyBin,
};
