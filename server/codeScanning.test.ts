import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeScanningAlertNumber } from "../shared/codeScanning.js";

test("alert links require the security bot and the same repository", () => {
  const thread = (login: string, body: string) => ({ comments: { nodes: [{ author: { login }, body }] } });
  const link = "https://github.com/fixture/cockpit/security/code-scanning/42";
  expect(codeScanningAlertNumber(thread("github-advanced-security[bot]", link), "fixture/cockpit")).toBe(42);
  expect(codeScanningAlertNumber(thread("reviewer", link), "fixture/cockpit")).toBeNull();
  expect(codeScanningAlertNumber(thread("github-advanced-security", link), "fixture/other")).toBeNull();
});

test("CodeQL uses PR-scoped pagination and GitHub dismissal reasons; permission errors propagate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-codeql-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(gh, 0o755);
  try {
    const script = `
      const { findCodeScanningAlert, setCodeScanningAlertResolved } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
      const requests = [];
      let denied = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        requests.push({ path: url.pathname, query: url.search, method: init.method, body: init.body ? JSON.parse(init.body) : null });
        if (denied) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
        if (init.method === "PATCH") return Response.json({});
        if (!url.searchParams.has("page")) return Response.json([], { headers: { link: '<https://api.github.com/repos/fixture/cockpit/code-scanning/alerts?page=2>; rel="next"' } });
        return Response.json([{ number: 42, most_recent_instance: { location: { path: "src/main.ts", start_line: 8, end_line: 10 } } }]);
      };
      const alert = await findCodeScanningAlert("fixture/cockpit", 103, "src/main.ts", 9);
      await setCodeScanningAlertResolved("fixture/cockpit", alert, true);
      await setCodeScanningAlertResolved("fixture/cockpit", alert, false);
      let missing = false;
      try { await findCodeScanningAlert("fixture/cockpit", 103, "other.ts", 9); } catch { missing = true; }
      denied = true;
      let permissionError = false;
      try { await setCodeScanningAlertResolved("fixture/cockpit", alert, true); } catch { permissionError = true; }
      console.log(JSON.stringify({ alert, requests, missing, permissionError }));
    `;
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      env: { ...Bun.env, COCKPIT_GH_BIN: gh, COCKPIT_DATA_DIR: dir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.alert).toBe(42);
    expect(new URLSearchParams(result.requests[0].query).get("ref")).toBe("refs/pull/103/merge");
    expect(result.requests[2].body).toEqual({ state: "dismissed", dismissed_reason: "won't fix" });
    expect(result.requests[3].body).toEqual({ state: "open" });
    expect(result.missing).toBe(true);
    expect(result.permissionError).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
