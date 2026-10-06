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
    const scheduledRecoveries = [];
    const dependencies = (refreshPr, executeMutation = async () => false) => ({
      executeMutation,
      refreshPr,
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationRefreshing: db.setMutationRefreshing,
      setMutationState: db.setMutationState,
      scheduleRecovery: (id, retry) => scheduledRecoveries.push({ id, retry }),
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

    let retryRefreshes = 0;
    const retryingRow = insert(110);
    await processMutation(retryingRow, dependencies(async () => {
      retryRefreshes++;
      if (retryRefreshes === 1) throw new Error("refresh unavailable");
    }));
    const scheduledRetry = scheduledRecoveries.shift();
    await scheduledRetry.retry();
    const retryingCount = db.listMutationsForPr(repo, 110).length;

    const refreshFailureRow = insert(103);
    await processMutation(refreshFailureRow, dependencies(async () => { throw new Error("refresh unavailable"); }));
    const refreshFailure = db.listMutationsForPr(repo, 103)[0];
    cache(106, { body: "old body", comments: { nodes: [] } });
    const unconfirmedEditRow = insert(106, { kind: "edit-body", body: "new body" });
    await processMutation(unconfirmedEditRow, dependencies(async () => {}));
    const unconfirmedEdit = db.listMutationsForPr(repo, 106)[0];
    db.db.query(\`INSERT INTO prs (
      repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
      updated_at, additions, deletions, changed_files, commit_count, mergeable,
      ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
    ) VALUES (?, 111, 'MERGED', 0, 'merged PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
      'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
      repo, "a".repeat(40), "2026-09-21T20:00:00Z",
      JSON.stringify({ body: "old body", comments: { nodes: [] } }), "2026-09-21T20:00:00Z",
    );
    const freshEditRow = insert(111, { kind: "edit-body", body: "published image" });
    await processMutation(freshEditRow, dependencies(async () => {
      cache(111, { body: "published image", comments: { nodes: [] } });
    }));
    const freshEditCount = db.listMutationsForPr(repo, 111).length;
    db.evictStalePrs(repo, []);
    const publishedBody = JSON.parse(db.getCachedPrDetail(repo, 111).detail_json).body;
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
      scheduleRecovery: (id, retry) => scheduledRecoveries.push({ id, retry }),
    });
    const unconfirmedAfterRecovery = db.listMutationsForPr(repo, 106).length;
    const interruptedAppliedCount = db.listMutationsForPr(repo, 104).length;
    const interruptedCommentCount = db.listMutationsForPr(repo, 109).length;
    const interruptedPending = db.listMutationsForPr(repo, 105)[0];

    console.log(JSON.stringify({
      persistedWhileRefreshing,
      apiStateWhileRefreshing,
      completedCount,
      retryingCount,
      retryRefreshes,
      scheduledRetryId: scheduledRetry.id,
      refreshFailure: { state: refreshFailure?.state, error: refreshFailure?.error },
      unconfirmedEdit: { state: unconfirmedEdit?.state, error: unconfirmedEdit?.error },
      confirmedCommentCount,
      freshEditCount, publishedBody,
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
    expect(result.retryingCount).toBe(0);
    expect(result.retryRefreshes).toBe(2);
    expect(result.scheduledRetryId).toBeGreaterThan(0);
    expect(result.refreshFailure).toEqual({ state: "refreshing", error: "GitHub accepted resolve-thread, but cache refresh failed: refresh unavailable" });
    expect(result.unconfirmedEdit).toEqual({ state: "refreshing", error: "GitHub accepted edit-body, but cache refresh failed: refreshed cache does not contain the accepted change" });
    expect(result.confirmedCommentCount).toBe(0);
    expect(result.freshEditCount).toBe(0);
    expect(result.publishedBody).toBe("published image");
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

test("inbox flags an open PR only while its latest merge attempt has failed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-merge-failure-"));
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { discardMutation, processMutation } = await import(${JSON.stringify(new URL("./mutations.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    for (const number of [201, 202]) {
      db.db.query(\`INSERT INTO prs (
        repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
        updated_at, additions, deletions, changed_files, commit_count, mergeable,
        ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
      ) VALUES (?, ?, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
        'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
        repo, number, "a".repeat(40), "2026-09-21T20:00:00Z",
        JSON.stringify({ body: "", comments: { nodes: [] } }), "2026-09-21T20:00:00Z",
      );
    }
    const merge = { kind: "merge", force: false, baseRef: "main", method: "squash", source: "default" };
    const insert = (number, payload) => {
      const id = db.insertMutation({ repo, number, kind: payload.kind, payload_json: JSON.stringify(payload), created_at: new Date().toISOString() });
      return db.listMutationsForPr(repo, number).find((row) => row.id === id);
    };
    const fail = (row, message) => processMutation(row, {
      executeMutation: async () => { throw new Error(message); },
      refreshPr: async () => {},
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationRefreshing: db.setMutationRefreshing,
      setMutationState: db.setMutationState,
    });
    const handler = buildFetchHandler(4820);
    const flags = async () => {
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      return Object.fromEntries(prs.map((pr) => [pr.number, pr.mergeFailed]));
    };

    const initial = await flags();
    await fail(insert(202, { kind: "update-branch" }), "update refused");
    const first = insert(201, merge);
    await fail(first, "Pull request is not mergeable");
    const afterFailure = await flags();
    const second = insert(201, merge);
    const whileRetrying = await flags();
    await fail(second, "Required status check is failing");
    const afterSecondFailure = await flags();
    const failedMerges = db.listMutationsForPr(repo, 201).map((row) => row.id);
    discardMutation(second.id);
    const afterDiscard = await flags();
    console.log(JSON.stringify({ initial, afterFailure, whileRetrying, afterSecondFailure, failedMerges, secondId: second.id, afterDiscard }));
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
    expect(result.initial).toEqual({ 201: false, 202: false });
    expect(result.afterFailure).toEqual({ 201: true, 202: false });
    expect(result.whileRetrying).toEqual({ 201: false, 202: false });
    expect(result.afterSecondFailure).toEqual({ 201: true, 202: false });
    expect(result.failedMerges).toEqual([result.secondId]);
    expect(result.afterDiscard).toEqual({ 201: false, 202: false });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failed merge refreshes the PR detail while keeping the merge failure", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-merge-failure-refresh-"));
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const scenario = `
    const db = await import(${url("./db.ts")});
    const { mockGithub } = await import(${url("./mockGithub.ts")});
    const { pollOnce, refreshPr } = await import(${url("./poller.ts")});
    const { processMutation } = await import(${url("./mutations.ts")});
    const { buildFetchHandler } = await import(${url("./http.ts")});
    const { setRendererInvalidationPublisher } = await import(${url("./rendererInvalidation.ts")});
    const repo = "fixture/cockpit";
    // Seed what a pre-merge refresh stores while GitHub is still computing mergeability; the
    // fixture GitHub then reports #103 as conflicting and #9301 as unknown, so its refresh fails.
    const seed = (number, fixture) => {
      const detail = { ...mockGithub.detail(repo, fixture), number, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
      db.db.query(\`INSERT INTO prs (
        repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
        updated_at, additions, deletions, changed_files, commit_count, mergeable, merge_state_status,
        ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
      ) VALUES (?, ?, 'OPEN', 0, ?, 'author', 'main', ?, ?, ?, 0, 0, 0, 1, 'UNKNOWN', 'UNKNOWN',
        'SUCCESS', 0, 0, ?, ?)\`).run(
        repo, number, detail.title, detail.headRefName, detail.headRefOid, detail.updatedAt,
        JSON.stringify(detail), "2026-09-21T20:00:00Z",
      );
    };
    for (const number of [101, 102, 103]) seed(number, number);
    seed(9301, 103);
    const merge = { kind: "merge", force: false, baseRef: "main", method: "squash", source: "default" };
    const insert = (number, payload) => {
      const id = db.insertMutation({ repo, number, kind: payload.kind, payload_json: JSON.stringify(payload), created_at: new Date().toISOString() });
      return db.listMutationsForPr(repo, number).find((row) => row.id === id);
    };
    // Only the GitHub write is replaced: it refuses merges and branch updates and accepts assignments.
    const dependencies = {
      executeMutation: async (row) => {
        if (row.kind === "assign") return false;
        throw new Error(row.kind === "merge" ? "Pull Request is not mergeable" : "update refused");
      },
      refreshPr,
      pollOnce,
      deleteMutation: db.deleteMutation,
      setMutationRefreshing: db.setMutationRefreshing,
      setMutationState: db.setMutationState,
    };
    const invalidated = new Set();
    setRendererInvalidationPublisher((event) => { if (event.type === "pr") invalidated.add(event.number); });
    const handler = buildFetchHandler(4820);
    const mergeable = async (number) =>
      (await (await handler(new Request(\`http://127.0.0.1:4820/api/pr/fixture/cockpit/\${number}?prefetch=1\`))).json()).mergeable;
    const mutations = async (number) =>
      (await (await handler(new Request(\`http://127.0.0.1:4820/api/mutations?repo=fixture%2Fcockpit&number=\${number}\`))).json())
        .mutations.map(({ kind, state, error }) => ({ kind, state, error }));

    await processMutation(insert(103, merge), dependencies);
    const conflict = { invalidated: invalidated.has(103), mergeable: await mergeable(103), mutations: await mutations(103) };

    await processMutation(insert(9301, merge), dependencies);
    await processMutation(insert(101, { kind: "assign", logins: ["reviewer-one"] }), dependencies);
    const refreshFailure = { mergeable: await mergeable(9301), mutations: await mutations(9301), nextMutations: await mutations(101) };

    await processMutation(insert(102, { kind: "update-branch" }), dependencies);
    const nonMerge = { invalidated: invalidated.has(102), mergeable: await mergeable(102), mutations: await mutations(102) };
    console.log(JSON.stringify({ conflict, refreshFailure, nonMerge }));
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
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.conflict).toEqual({
      invalidated: true,
      mergeable: "CONFLICTING",
      mutations: [{ kind: "merge", state: "failed", error: "Error: Pull Request is not mergeable" }],
    });
    // The refresh failure leaves the merge failure in place and the next queued mutation completes.
    expect(result.refreshFailure).toEqual({
      mergeable: "UNKNOWN",
      mutations: [{ kind: "merge", state: "failed", error: "Error: Pull Request is not mergeable" }],
      nextMutations: [],
    });
    expect(result.nonMerge).toEqual({
      invalidated: false,
      mergeable: "UNKNOWN",
      mutations: [{ kind: "update-branch", state: "failed", error: "Error: update refused" }],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a description checkbox applies to the current GitHub description, not the rendered copy", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-task-intent-"));
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const report = (cache: string, rows: string[]) => [
    "Checkboxes record approval by each PR's author.",
    "",
    "```md",
    "- [ ] **[FIX]** #101 (@author-one) fenced example",
    "```",
    "",
    ...rows,
    "",
    `<!-- risk-cache:${cache} -->`,
    "",
  ].join("\n");
  // Rendered when the author ticks #101; the report regenerates before the queued write runs.
  const rendered = report("v1 [ ] ünïcødé", ["### Low risk", "- [ ] **[FIX]** #101 (@author-one), *Old reason*", "- [ ] **[FEAT]** #102 (@author-two)", "- [ ] #41-not-a-pr"]);
  const regenerated = report("v2 [ ] 🚀", ["### Medium risk", "- [ ] **[FEAT]** #103 (@author-three)", "- [ ] **[FEAT]** #101 (@author-one), *New reason*", "- [x] **[FEAT]** #102 (@author-two)", "- [ ] #41-not-a-pr"]);
  const scenario = `
    const db = await import(${url("./db.ts")});
    const { seedMockDatabase } = await import(${url("./mockGithub.ts")});
    const { finalizeMutation, processMutation } = await import(${url("./mutations.ts")});
    const { setTaskByKey, taskMarkers } = await import(${url("../shared/taskList.js")});
    const repo = "fixture/cockpit";
    seedMockDatabase(db.db, ${JSON.stringify(dataDir)});
    const setBody = (number, body) => {
      const detail = JSON.parse(db.getPr(repo, number).detail_json);
      db.db.query("UPDATE prs SET detail_json = ? WHERE repo = ? AND number = ?").run(JSON.stringify({ ...detail, body }), repo, number);
    };
    const body = (number) => JSON.parse(db.getPr(repo, number).detail_json).body;
    const tick = async (number, rendered, regenerated, index) => {
      setBody(number, rendered);
      const { key } = taskMarkers(rendered)[index];
      const payload = { kind: "edit-body", body: setTaskByKey(rendered, key, true), task: { key, checked: true } };
      const id = db.insertMutation({ repo, number, kind: "edit-body", payload_json: JSON.stringify(payload), created_at: new Date().toISOString() });
      setBody(number, regenerated);
      await processMutation(db.listMutationsForPr(repo, number).find((row) => row.id === id));
      return { key, body: body(number), mutations: db.listMutationsForPr(repo, number).map(({ state, error }) => ({ state, error })) };
    };
    // GitHub accepted a tick, then the assessment republished with a new cache before the refresh.
    const republished = async (number, published) => {
      const key = "pr:101";
      const payload = { kind: "edit-body", body: setTaskByKey(rendered, key, true), task: { key, checked: true } };
      const id = db.insertMutation({ repo, number, kind: "edit-body", payload_json: JSON.stringify(payload), created_at: new Date().toISOString() });
      const row = db.listMutationsForPr(repo, number).find((candidate) => candidate.id === id);
      db.setMutationRefreshing(id, row.payload_json);
      setBody(number, published);
      await finalizeMutation(row, false, {
        refreshPr: async () => {},
        pollOnce: async () => {},
        deleteMutation: db.deleteMutation,
        setMutationState: db.setMutationState,
        scheduleRecovery: () => {},
      });
      return db.listMutationsForPr(repo, number).map(({ state, error }) => ({ state, error }));
    };
    const rendered = ${JSON.stringify(rendered)};
    const regenerated = ${JSON.stringify(regenerated)};
    const ticked = regenerated.replace("- [ ] **[FEAT]** #101", "- [x] **[FEAT]** #101").replace("v2", "v3");
    console.log(JSON.stringify({
      applied: await tick(101, rendered, regenerated, 0),
      generic: await tick(102, rendered, regenerated, 2),
      missing: await tick(103, rendered, regenerated.replace("**[FEAT]** #101", "**[FEAT]** #104"), 0),
      republishedTicked: await republished(104, ticked),
      republishedUnticked: await republished(105, regenerated),
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
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    // Only #101's marker changes; the new cache, reason, heading and #102's approval survive.
    expect(result.applied).toEqual({
      key: "pr:101",
      body: regenerated.replace("- [ ] **[FEAT]** #101", "- [x] **[FEAT]** #101"),
      mutations: [],
    });
    expect(result.generic).toEqual({
      key: "text:#41-not-a-pr",
      body: regenerated.replace("- [ ] #41-not-a-pr", "- [x] #41-not-a-pr"),
      mutations: [],
    });
    expect(result.missing).toEqual({
      key: "pr:101",
      body: regenerated.replace("**[FEAT]** #101", "**[FEAT]** #104"),
      mutations: [{ state: "failed", error: "Error: Checklist changed on GitHub; discard and reload before ticking again" }],
    });
    // A later publication that keeps the tick confirms it; one that lost it keeps the edit unconfirmed.
    expect(result.republishedTicked).toEqual([]);
    expect(result.republishedUnticked).toEqual([{
      state: "refreshing",
      error: "GitHub accepted edit-body, but cache refresh failed: refreshed cache does not contain the accepted change",
    }]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
