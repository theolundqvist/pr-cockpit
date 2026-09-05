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
    const insert = (number, payload = { kind: "resolve-thread", threadId: "thread-1", resolved: true }) => {
      const id = db.insertMutation({
        repo,
        number,
        kind: payload.kind,
        payload_json: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      });
      return db.listMutationsForPr(repo, number).find((row) => row.id === id);
    };
    const cache = (number, detail) => db.upsertCachedPrDetail({
      repo,
      number,
      head_sha: "a".repeat(40),
      detail_json: JSON.stringify(detail),
      fetched_at: new Date().toISOString(),
    });
    const acceptComment = async (row) => {
      const payload = JSON.parse(row.payload_json);
      row.payload_json = JSON.stringify({ ...payload, commentNodeId: "mock-comment" });
      return false;
    };
    const dependencies = (refreshPr, executeMutation = async () => false) => ({
      executeMutation,
      refreshPr,
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationRefreshing: db.setMutationRefreshing,
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
    const refreshFailure = db.listMutationsForPr(repo, 103)[0];
    cache(106, { body: "old body", comments: { nodes: [] } });
    const unconfirmedEditRow = insert(106, { kind: "edit-body", body: "new body" });
    await processMutation(unconfirmedEditRow, dependencies(async () => {}));
    const unconfirmedEdit = db.listMutationsForPr(repo, 106)[0];
    cache(107, { body: "body", comments: { nodes: [] } });
    const confirmedCommentRow = insert(107, { kind: "comment", body: "accepted comment\\r\\n" });
    await processMutation(confirmedCommentRow, dependencies(async () => {
      cache(107, { body: "body", comments: { nodes: [{ id: "mock-comment", body: "accepted comment" }] } });
    }, acceptComment));
    const confirmedCommentCount = db.listMutationsForPr(repo, 107).length;
    cache(108, { body: "body", comments: { nodes: [{ id: "older-comment", body: "duplicate body" }] } });
    const duplicateCommentRow = insert(108, { kind: "comment", body: "duplicate body" });
    await processMutation(duplicateCommentRow, dependencies(async () => {}, acceptComment));
    const duplicateComment = db.listMutationsForPr(repo, 108)[0];

    const interruptedAppliedRow = insert(104);
    db.setMutationState(interruptedAppliedRow.id, "refreshing", null);
    cache(109, { body: "body", comments: { nodes: [{ id: "mock-comment", body: "restart comment" }] } });
    const interruptedCommentRow = insert(109, { kind: "comment", body: "restart comment" });
    await acceptComment(interruptedCommentRow);
    db.setMutationRefreshing(interruptedCommentRow.id, interruptedCommentRow.payload_json);
    insert(105);
    db.failInterruptedMutations();
    const recovered = [];
    await recoverRefreshingMutations({
      refreshPr: async (_repo, number) => { recovered.push(number); },
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationState: db.setMutationState,
    });
    const unconfirmedAfterRecovery = db.listMutationsForPr(repo, 106).length;
    const interruptedAppliedCount = db.listMutationsForPr(repo, 104).length;
    const interruptedCommentCount = db.listMutationsForPr(repo, 109).length;
    const interruptedPending = db.listMutationsForPr(repo, 105)[0];

    console.log(JSON.stringify({
      persistedWhileRefreshing,
      apiStateWhileRefreshing,
      completedCount,
      refreshFailure: { state: refreshFailure?.state, error: refreshFailure?.error },
      unconfirmedEdit: { state: unconfirmedEdit?.state, error: unconfirmedEdit?.error },
      confirmedCommentCount,
      duplicateComment: {
        state: duplicateComment?.state,
        error: duplicateComment?.error,
        commentNodeId: JSON.parse(duplicateComment?.payload_json ?? "{}").commentNodeId,
      },
      interruptedCommentCount,
      unconfirmedAfterRecovery,
      interruptedAppliedCount,
      recovered,
      interruptedPending: { state: interruptedPending?.state, error: interruptedPending?.error },
    }));
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
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
    expect(result.refreshFailure).toEqual({ state: "refreshing", error: "GitHub accepted resolve-thread, but cache refresh failed: refresh unavailable" });
    expect(result.unconfirmedEdit).toEqual({ state: "refreshing", error: "GitHub accepted edit-body, but cache refresh failed: refreshed cache does not contain the accepted change" });
    expect(result.confirmedCommentCount).toBe(0);
    expect(result.interruptedAppliedCount).toBe(0);
    expect(result.interruptedCommentCount).toBe(0);
    expect(result.duplicateComment).toEqual({
      state: "refreshing",
      error: "GitHub accepted comment, but cache refresh failed: refreshed cache does not contain the accepted change",
      commentNodeId: "mock-comment",
    });
    expect(result.recovered).toEqual([103, 106, 108, 104, 109]);
    expect(result.unconfirmedAfterRecovery).toBe(1);
    expect(result.interruptedPending).toEqual({ state: "failed", error: "interrupted" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
