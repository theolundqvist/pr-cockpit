const { spawn } = require("child_process");

const commands = {
  "omp-anthropic": "printf '\\nType /login in OMP, then connect Anthropic for Sonnet.\\n\\n'; omp",
};

const appleQuote = (value) => `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

function setupCommand(action) {
  return commands[action] ?? null;
}

function setupInvocation(command, proxyHost = "") {
  if (!proxyHost) return command;
  if (!/^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(proxyHost)) return null;
  return `ssh -t ${shellQuote(proxyHost)} ${shellQuote(command)}`;
}

function launchSetupTerminal(action, bounds, env = process.env, platform = process.platform, proxyHost = "") {
  const command = setupCommand(action);
  if (!command) return Promise.resolve({ error: "unknown setup action" });
  const invocation = setupInvocation(command, proxyHost);
  if (!invocation) return Promise.resolve({ error: "invalid SSH proxy host" });

  if (platform === "darwin") {
    const script = `
      tell application "Terminal"
        activate
        do script ${appleQuote(invocation)}
        set bounds of front window to {${bounds.x}, ${bounds.y}, ${bounds.x + bounds.width}, ${bounds.y + bounds.height}}
      end tell`;
    return new Promise((resolve) => {
      const osa = spawn("osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      osa.stderr.on("data", (chunk) => (stderr += chunk));
      osa.on("close", (code) => resolve(code === 0 ? { ok: true } : { error: `Terminal launch failed: ${stderr.trim()}` }));
      osa.on("error", (error) => resolve({ error: `Terminal launch failed: ${error.message}` }));
    });
  }

  const terminal = env.TERMINAL || "x-terminal-emulator";
  return new Promise((resolve) => {
    const proc = spawn(terminal, ["-e", env.SHELL || "/bin/sh", "-ilc", invocation], { detached: true, stdio: "ignore" });
    proc.on("error", (error) => resolve({ error: `Terminal launch failed: ${error.message}` }));
    proc.unref();
    setTimeout(() => resolve({ ok: true }), 100);
  });
}

module.exports = { launchSetupTerminal, setupCommand, setupInvocation };