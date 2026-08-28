import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const relayClientUrl = new URL("./relayClient.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;

test("relay cursor survives restart and acknowledges only handled markers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-cursor-"));
  try {
    const script = `
      const { pollRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getSetting, setSetting } = await import(${JSON.stringify(dbUrl)});
      const run = (id) => ({ id, attempt: 1, headSha: "a".repeat(40), headBranch: "cache", workflowName: "CI", status: "completed", conclusion: "failure", eventAt: "2026-08-24T10:00:00Z", htmlUrl: null });
      const requests = [];
      const seen = [];
      db.query("DELETE FROM settings WHERE key = 'relay_cursor'").run();
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async (input) => { requests.push(String(input)); return Response.json({ latest: 5, events: [{ seq: 5, ts: 1, repo: "acme/app", number: 7, event: "workflow_run", run: run(5) }] }); },
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      const initialized = { cursor: getSetting("relay_cursor"), seen: [...seen] };

      setSetting("relay_cursor", "7");
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async (input) => { requests.push(String(input)); return Response.json({ latest: 10, events: [{ seq: 8, ts: 2, repo: "acme/app", number: 7, event: "workflow_run", run: run(8) }] }); },
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      const resumed = { cursor: getSetting("relay_cursor"), seen: [...seen] };

      setSetting("relay_cursor", "20");
      let request = 0;
      const fetcher = async (input) => {
        requests.push(String(input));
        request++;
        return request === 1
          ? Response.json({ latest: 22, events: [
              { seq: 21, ts: 3, repo: "acme/app", number: 7, event: "workflow_run", run: run(21) },
              { seq: 22, ts: 4, repo: "acme/app", number: 7, event: "workflow_run", run: run(22) },
            ] })
          : Response.json({ latest: 25, events: [
              { seq: 22, ts: 4, repo: "acme/app", number: 7, event: "workflow_run", run: run(22) },
              { seq: 23, ts: 5, repo: "acme/app", number: 7, event: "workflow_run", run: run(23) },
            ] });
      };
      let failed = false;
      try {
        await pollRelayOnce("https://relay.test", "token", {
          fetcher,
          ingest: async (_repo, state) => {
            seen.push(state.run.id);
            if (state.run.id === 22) throw new Error("reconcile failed");
            return true;
          },
        });
      } catch { failed = true; }
      const afterFailure = getSetting("relay_cursor");
      await pollRelayOnce("https://relay.test", "token", {
        fetcher,
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      console.log(JSON.stringify({ initialized, resumed, failed, afterFailure, finalCursor: getSetting("relay_cursor"), requests, seen }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.initialized).toEqual({ cursor: "5", seen: [] });
    expect(result.resumed).toEqual({ cursor: "10", seen: [8] });
    expect(result.failed).toBe(true);
    expect(result.afterFailure).toBe("21");
    expect(result.finalCursor).toBe("25");
    expect(result.requests).toEqual([
      "https://relay.test/events",
      "https://relay.test/events?since=7",
      "https://relay.test/events?since=20",
      "https://relay.test/events?since=21",
    ]);
    expect(result.seen).toEqual([8, 21, 22, 22, 23]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
