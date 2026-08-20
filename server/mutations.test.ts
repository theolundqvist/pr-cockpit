import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("applied mutations remain pending through refresh without becoming retryable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-mutation-completion-"));
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { processMutation, recoverRefreshingMutations } = await import(${JSON.stringify(new URL("./mutations.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    const insert = (number) => {
      const id = db.insertMutation({
        repo,
        number,
        kind: "resolve-thread",
        payload_json: JSON.stringify({ kind: "resolve-thread", threadId: "thread-1", resolved: true }),
        created_at: new Date().toISOString(),
      });
      return db.listMutationsForPr(repo, number).find((row) => row.id === id);
    };
    const dependencies = (refreshPr) => ({
      executeMutation: async () => false,
      refreshPr,
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationState: db.setMutationState,
    });

    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    const refreshingRow = insert(102);
    const running = processMutation(refreshingRow, dependencies(async () => refreshGate));
    for (let attempt = 0; attempt < 100 && db.listMutationsForPr(repo, 102)[0]?.state !== "refreshing"; attempt++) {
      await Bun.sleep(1);
    }
    if (db.listMutationsForPr(repo, 102)[0]?.state !== "refreshing") {
      throw new Error("mutation did not enter refreshing state");
    }
    const persistedWhileRefreshing = db.listMutationsForPr(repo, 102)[0]?.state;
    const handler = buildFetchHandler(4820);
    const response = await handler(new Request("http://127.0.0.1:4820/api/mutations?repo=fixture%2Fcockpit&number=102"));
    const apiStateWhileRefreshing = (await response.json()).mutations[0]?.state;
    releaseRefresh();
    await running;
    const completedCount = db.listMutationsForPr(repo, 102).length;

    const refreshFailureRow = insert(103);
    await processMutation(refreshFailureRow, dependencies(async () => { throw new Error("refresh unavailable"); }));
    const refreshFailureCount = db.listMutationsForPr(repo, 103).length;

    const interruptedAppliedRow = insert(104);
    db.setMutationState(interruptedAppliedRow.id, "refreshing", null);
    insert(105);
    db.failInterruptedMutations();
    const recovered = [];
    await recoverRefreshingMutations({
      refreshPr: async (_repo, number) => { recovered.push(number); },
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationState: db.setMutationState,
    });
    const interruptedAppliedCount = db.listMutationsForPr(repo, 104).length;
    const interruptedPending = db.listMutationsForPr(repo, 105)[0];

    console.log(JSON.stringify({
      persistedWhileRefreshing,
      apiStateWhileRefreshing,
      completedCount,
      refreshFailureCount,
      interruptedAppliedCount,
      recovered,
      interruptedPending: { state: interruptedPending?.state, error: interruptedPending?.error },
    }));
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim());
    expect(result.persistedWhileRefreshing).toBe("refreshing");
    expect(result.apiStateWhileRefreshing).toBe("pending");
    expect(result.completedCount).toBe(0);
    expect(result.refreshFailureCount).toBe(0);
    expect(result.interruptedAppliedCount).toBe(0);
    expect(result.recovered).toEqual([104]);
    expect(result.interruptedPending).toEqual({ state: "failed", error: "interrupted" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
