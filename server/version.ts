const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const repoRoot = `${import.meta.dir}/..`;

let updateAvailable = false;
// The revision this process booted from. static/ is only rebuilt by the same update that restarts the
// server, so a client seeing this change knows a new build is on disk and a reload is safe.
const sourceRoot = process.env.COCKPIT_SOURCE_ROOT || repoRoot;
const git = Bun.which("git");
const bootRev = process.env.COCKPIT_RELEASE_REVISION
  || (git ? Bun.spawnSync([git, "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim() : "");

export function updatesEnabled(): boolean {
  return process.env.COCKPIT_UPDATE_DISABLED !== "1";
}

export async function checkForUpdate(): Promise<void> {
  if (!updatesEnabled()) throw new Error("updates are disabled for this installation");
  if (!git) throw new Error("Git is required to check for updates.");
  const fetchProc = Bun.spawn([git, "fetch", "--quiet", "origin", "main"], {
    cwd: sourceRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await fetchProc.exited !== 0) throw new Error("Could not fetch origin/main from GitHub.");

  const revListProc = Bun.spawn([git, "rev-list", `${bootRev}..origin/main`, "--count"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const count = (await new Response(revListProc.stdout).text()).trim();
  if (await revListProc.exited !== 0) throw new Error("Could not compare the running revision with origin/main.");
  updateAvailable = Number(count) > 0;
}

function pollForUpdate(): void {
  checkForUpdate().catch((err) => console.error("update check failed:", err));
}

export function isUpdateAvailable(): boolean {
  return updatesEnabled() && updateAvailable;
}

export function runningRev(): string {
  return bootRev;
}

export function startUpdateCheck(): void {
  if (!updatesEnabled()) return;
  pollForUpdate();
  setInterval(pollForUpdate, CHECK_INTERVAL_MS);
}
