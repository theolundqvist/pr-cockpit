import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const versionModuleUrl = new URL("./version.ts", import.meta.url).href;

test("the server can start without Git and reports the missing prerequisite", async () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "pr-cockpit-no-git-"));
  try {
    const script = `
      const version = await import(${JSON.stringify(versionModuleUrl)});
      let error = null;
      try { await version.checkForUpdate(); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      console.log(JSON.stringify({ runningRev: version.runningRev(), error }));
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, PATH: emptyPath, COCKPIT_RELEASE_REVISION: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ runningRev: "", error: "Git is required to check for updates." });
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
