const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const repoRoot = `${import.meta.dir}/..`;

let updateAvailable = false;
// The revision this process booted from. static/ is only rebuilt by the same update that restarts the
// server, so a client seeing this change knows a new build is on disk and a reload is safe.
const bootRev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();

async function checkForUpdate(): Promise<void> {
  try {
    const fetchProc = Bun.spawn(["git", "fetch", "--quiet", "origin", "main"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    await fetchProc.exited;

    const revListProc = Bun.spawn(["git", "rev-list", "HEAD..origin/main", "--count"], {
      cwd: repoRoot,
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
  return updateAvailable;
}

export function runningRev(): string {
  return bootRev;
}

export function startUpdateCheck(): void {
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}
