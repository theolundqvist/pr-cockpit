const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const repoRoot = `${import.meta.dir}/..`;

let updateAvailable = false;

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

export function startUpdateCheck(): void {
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_INTERVAL_MS);
}
