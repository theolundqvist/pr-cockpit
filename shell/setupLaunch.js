const { spawn } = require("child_process");

const commands = {
  "omp-anthropic": "printf '\\nType /login in OMP, then connect Anthropic for Sonnet.\\n\\n'; omp",
};

const appleQuote = (value) => `"${String(value).replace(/[\\"]/g, "\\$&")}"`;

function setupCommand(action) {
  return commands[action] ?? null;
}

function launchSetupTerminal(action, bounds, env = process.env, platform = process.platform) {
  const command = setupCommand(action);
  if (!command) return Promise.resolve({ error: "unknown setup action" });

  if (platform === "darwin") {
    const script = `
      tell application "Terminal"
        activate
        do script ${appleQuote(command)}
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
    const proc = spawn(terminal, ["-e", env.SHELL || "/bin/sh", "-ilc", command], { detached: true, stdio: "ignore" });
    proc.on("error", (error) => resolve({ error: `Terminal launch failed: ${error.message}` }));
    proc.unref();
    setTimeout(() => resolve({ ok: true }), 100);
  });
}

module.exports = { launchSetupTerminal, setupCommand };