const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const repoRoot = `${import.meta.dir}/..`;

let updateAvailable = false;
// The revision this process booted from. static/ is only rebuilt by the same update that restarts the
// server, so a client seeing this change knows a new build is on disk and a reload is safe.
const sourceRoot = process.env.COCKPIT_SOURCE_ROOT || repoRoot;
const bootRev = process.env.COCKPIT_RELEASE_REVISION || Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();

export function updatesEnabled(): boolean {
  return process.env.COCKPIT_UPDATE_DISABLED !== "1";
}

async function checkForUpdate(): Promise<void> {
  try {
    const fetchProc = Bun.spawn(["git", "fetch", "--quiet", "origin", "main"], {
      cwd: sourceRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    await fetchProc.exited;

    const revListProc = Bun.spawn(["git", "rev-list", `${bootRev}..origin/main`, "--count"], {
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "ignore",
    });
    const count = (await new Response(revListProc.stdout).text()).trim();
    await revListProc.exited;

    updateAvailable = Number(count) > 0;
  } catch (err) {
    console.error("update check failed:", err);
  }
}

export function isUpdateAvailable(): boolean {
  return updatesEnabled() && updateAvailable;
}

export function runningRev(): string {
  return bootRev;
}

export function startUpdateCheck(): void {
  if (!updatesEnabled()) return;
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}
