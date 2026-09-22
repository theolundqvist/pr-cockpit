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
      await setCodeScanningAlertResolved("fixture/cockpit", alert, true, { reason: "false positive", comment: "Input is validated upstream" });
      await setCodeScanningAlertResolved("fixture/cockpit", alert, false);
      let missing = false;
      try { await findCodeScanningAlert("fixture/cockpit", 103, "other.ts", 9); } catch { missing = true; }
      denied = true;
      let permissionError = false;
      try { await setCodeScanningAlertResolved("fixture/cockpit", alert, true, { reason: "mitigated" }); } catch { permissionError = true; }
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
    expect(result.requests[2].body).toEqual({ state: "dismissed", dismissed_reason: "false positive", dismissed_comment: "Input is validated upstream" });
    expect(result.requests[3].body).toEqual({ state: "open" });
    expect(result.missing).toBe(true);
    expect(result.permissionError).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CodeQL resolution validates every entry path before writes and never resolves after a failed dismissal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-codeql-mutations-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(gh, 0o755);
  const script = `
    // Load consumers after replacing the poller so this isolated process cannot refresh GitHub.
    const { mock } = await import("bun:test");
    const pollerUrl = ${JSON.stringify(new URL("./poller.ts", import.meta.url).href)};
    const poller = await import(pollerUrl);
    mock.module(pollerUrl, () => ({ ...poller, refreshPr: async () => {}, pollOnce: async () => {} }));
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { processMutation, enqueueMutation } = await import(${JSON.stringify(new URL("./mutations.ts", import.meta.url).href)});
    const { buildFetchHandler, normalizeAgentMutation, reviewThreadHandle } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const { setCodeScanningAlertResolved } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    const thread = (id, login) => ({ id, path: "src/main.ts", line: 9, isResolved: false, comments: { nodes: [{ author: { login }, body: "https://github.com/fixture/cockpit/security/code-scanning/42" }] } });
    const detail = { reviewThreads: { nodes: [thread("security", "codeql[bot]"), thread("ordinary", "reviewer")] } };
    db.upsertCachedPrDetail({ repo, number: 103, head_sha: "a".repeat(40), detail_json: JSON.stringify(detail), fetched_at: new Date().toISOString() });
    let writes = [];
    let denied = false;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(init.body);
      writes.push({ path: new URL(String(input)).pathname, body });
      if (denied) return Response.json({ message: "Forbidden" }, { status: 403 });
      return Response.json({ data: { resolveReviewThread: { thread: { id: "security" } }, unresolveReviewThread: { thread: { id: "security" } } } });
    };
    const payload = (choice, id = "security", resolved = true) => ({ kind: "resolve-thread", threadId: id, resolved, ...(choice === undefined ? {} : { codeScanningDismissal: choice }) });
    const rejected = [];
    const handler = buildFetchHandler(4820);
    for (const choice of [undefined, { reason: "fixed" }, { reason: "mitigated", comment: "x".repeat(281) }, { reason: "mitigated", comment: 1 }]) {
      let enqueueRejected = false, agentRejected = false, directRejected = false;
      try { enqueueMutation({ repo, number: 103, payload: payload(choice) }); } catch { enqueueRejected = true; }
      try { normalizeAgentMutation(repo, 103, detail, { ...payload(choice), threadHandle: reviewThreadHandle("security") }); } catch { agentRejected = true; }
      try { await setCodeScanningAlertResolved(repo, 42, true, choice); } catch { directRejected = true; }
      const response = await handler(new Request("http://127.0.0.1:4820/api/agent/pr/fixture/cockpit/103/threads/" + reviewThreadHandle("security"), {
        method: "POST", headers: { "x-pr-cockpit-cli": "1", "content-type": "application/json" }, body: JSON.stringify({ codeScanningDismissal: choice }),
      }));
      rejected.push({ enqueueRejected, agentRejected, directRejected, legacyStatus: response.status });
    }
    const writesAfterInvalid = writes.length;
    const run = async (value) => {
      writes = [];
      const id = db.insertMutation({ repo, number: 103, kind: value.kind, payload_json: JSON.stringify(value), created_at: new Date().toISOString() });
      await processMutation(db.listMutationsForPr(repo, 103).find(row => row.id === id));
      const row = db.listMutationsForPr(repo, 103).find(row => row.id === id);
      const result = { writes, state: row?.state ?? "completed" };
      db.deleteMutation(id);
      return result;
    };
    const stale = await run(payload(undefined));
    const choice = { reason: "used in tests", comment: "x".repeat(280) };
    const normalized = normalizeAgentMutation(repo, 103, detail, { ...payload(choice), threadHandle: reviewThreadHandle("security") });
    const accepted = await run(normalized);
    denied = true;
    const failure = await run(payload({ reason: "mitigated" }));
    denied = false;
    const ordinary = await run(payload(undefined, "ordinary"));
    const misleading = await run(payload({ reason: "false positive" }, "ordinary"));
    const reopened = await run(payload(undefined, "security", false));
    console.log(JSON.stringify({ rejected, writesAfterInvalid, stale, accepted, failure, ordinary, misleading, reopened }));
  `;
  try {
    const child = Bun.spawn([Bun.which("bun")!, "-e", script], {
      env: { ...Bun.env, COCKPIT_GH_BIN: gh, COCKPIT_DATA_DIR: dir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.trim());
    expect(result.rejected).toEqual(Array(4).fill({ enqueueRejected: true, agentRejected: true, directRejected: true, legacyStatus: 400 }));
    expect(result.writesAfterInvalid).toBe(0);
    expect(result.stale).toEqual({ writes: [], state: "failed" });
    expect(result.accepted.state).toBe("completed");
    expect(result.accepted.writes.map((write: { path: string }) => write.path)).toEqual(["/repos/fixture/cockpit/code-scanning/alerts/42", "/graphql"]);
    expect(result.accepted.writes[0].body).toEqual({ state: "dismissed", dismissed_reason: "used in tests", dismissed_comment: "x".repeat(280) });
    expect(result.failure.state).toBe("failed");
    expect(result.failure.writes.map((write: { path: string }) => write.path)).toEqual(["/repos/fixture/cockpit/code-scanning/alerts/42"]);
    expect(result.ordinary.state).toBe("completed");
    expect(result.ordinary.writes.map((write: { path: string }) => write.path)).toEqual(["/graphql"]);
    expect(result.misleading).toEqual({ writes: [], state: "failed" });
    expect(result.reopened.state).toBe("completed");
    expect(result.reopened.writes[0].body).toEqual({ state: "open" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
