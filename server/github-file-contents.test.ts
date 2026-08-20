import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child imports after the fake gh executable is injected, so this test never reads the user's token.
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;

test("fetchFileContents rejects invalid UTF-8 payloads", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-github-test-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);

  try {
    const script = `
      const { fetchFileContents } = await import(${JSON.stringify(githubModuleUrl)});
      const calls = [];
      globalThis.fetch = async (input) => {
        calls.push(String(input));
        return Response.json({ encoding: "base64", content: "/w==" });
      };
      try {
        const result = await fetchFileContents("base-owner/base-repo", "src/value.ts", ${JSON.stringify("a".repeat(40))});
        console.log(JSON.stringify({ result, calls }));
      } catch (error) {
        console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), calls }));
      }
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_GH_BIN: fakeGh, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);

    const outcome = JSON.parse(stdout) as { result?: unknown; error?: string; calls: string[] };
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeDefined();
    expect(outcome.calls).toHaveLength(1);
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});
