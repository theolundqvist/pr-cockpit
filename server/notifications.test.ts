import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runScenario(source: string): Promise<Record<string, unknown>> {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-notifications-"));
  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", source], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("notification observation is opt-in, filters authoritative actors, suppresses history, and deduplicates events", async () => {
  const notificationsUrl = new URL("./notifications.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const result = await runScenario(`
    const { db, getSetting, setSetting } = await import(${JSON.stringify(dbUrl)});
    const { observePrNotifications, claimNotifications } = await import(${JSON.stringify(notificationsUrl)});
    const { readSettings, writeSettings } = await import(${JSON.stringify(settingsUrl)});
    const iso = (day) => \`2030-01-\${String(day).padStart(2, "0")}T00:00:00Z\`;
    const detail = (overrides = {}) => ({
      title: "Ship safely", state: "OPEN", isDraft: false,
      author: { __typename: "User", login: "owner" }, viewerLogin: "viewer",
      viewerIsAuthor: false, viewerReviewRequested: false,
      assignees: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] },
      reviewThreads: { nodes: [] }, lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      updatedAt: iso(5), ...overrides,
    });
    const row = (value, fetchedAt = iso(5)) => ({ detail_json: JSON.stringify(value), fetched_at: fetchedAt });
    const nextRow = (value, fetchedAt = iso(5)) => ({ repo: "acme/app", number: 7, ...row(value, fetchedAt) });
    const previous = detail();
    const added = detail({ comments: { nodes: [{ id: "off", author: { __typename: "User", login: "alice" }, body: "ship it", createdAt: iso(5) }] } });
    observePrNotifications(row(previous), nextRow(added));
    const defaultOffCount = db.query("select count(*) as count from desktop_notifications").get().count;

    const rules = [
      { id: "human-text", name: "Human ship comments", enabled: true, events: ["comment"], match: "all", conditions: [
        { field: "actorType", operator: "is", value: "human" }, { field: "body", operator: "contains", value: "SHIP" },
      ] },
      { id: "same-human", name: "Same event also matches", enabled: true, events: ["comment"], match: "all", conditions: [{ field: "actor", operator: "is", value: "alice" }] },
      { id: "bots", name: "Bots", enabled: true, events: ["comment"], match: "all", conditions: [{ field: "actorType", operator: "is", value: "bot" }] },
      { id: "not-bots", name: "Known non-bots", enabled: true, events: ["comment"], match: "all", conditions: [{ field: "actorType", operator: "isNot", value: "bot" }] },
      { id: "approved", name: "Approvals", enabled: true, events: ["review"], match: "all", conditions: [{ field: "reviewState", operator: "is", value: "approved" }] },
    ];
    writeSettings({ notifications: { enabled: true, rules } });
    const persistedActivation = getSetting("notifications_enabled_at");
    setSetting("notifications_enabled_at", iso(2));
    observePrNotifications(null, nextRow(added));
    const afterInitialSnapshot = db.query("select count(*) as count from desktop_notifications").get().count;

    const mixed = detail({
      comments: { nodes: [
        { id: "old", author: { __typename: "User", login: "alice" }, body: "ship old", createdAt: iso(1) },
        { id: "human", author: { __typename: "User", login: "alice" }, body: "Please SHIP this", createdAt: iso(3) },
        { id: "bot", author: { login: "dependabot[bot]" }, body: "update", createdAt: iso(3) },
        { id: "unknown", author: { login: "mystery" }, body: "ship maybe", createdAt: iso(3) },
        { id: "configured", author: { login: "cursor" }, body: "configured bot", createdAt: iso(3) },
        { id: "declared-human", author: { __typename: "User", login: "cursor" }, body: "ship as a user", createdAt: iso(3) },
      ] },
      reviewThreads: { nodes: [{ id: "thread", comments: { nodes: [
        { databaseId: 44, author: { type: "Bot", login: "review-service" }, body: "thread note", createdAt: iso(3) },
      ] } }] },
      reviews: { nodes: [
        { id: "review-old", author: { __typename: "User", login: "bob" }, state: "APPROVED", body: "old", submittedAt: iso(1) },
        { id: "review-new", author: { __typename: "User", login: "bob" }, state: "APPROVED", body: "looks good", submittedAt: iso(3) },
      ] },
    });
    observePrNotifications(row(previous), nextRow(mixed));
    observePrNotifications(row(previous), nextRow(mixed));
    const firstClaim = claimNotifications();
    const editedThread = structuredClone(mixed);
    editedThread.reviewThreads.nodes[0].comments.nodes[0].body = "edited thread note";
    observePrNotifications(row(mixed), nextRow(editedThread));
    const replayClaim = claimNotifications();

    writeSettings({ notifications: { enabled: true, rules: [rules[0]] } });
    const humanOnly = structuredClone(mixed);
    humanOnly.comments.nodes.push(
      { id: "automation-account", author: { __typename: "User", login: "cursor" }, body: "ship automatically", createdAt: iso(4) },
      { id: "person", author: { __typename: "User", login: "alice" }, body: "ship this", createdAt: iso(4) },
    );
    observePrNotifications(row(mixed), nextRow(humanOnly));
    const humanOnlyIds = claimNotifications().map((item) => item.id);

    const priorSettings = readSettings();
    let invalidError = "";
    try {
      writeSettings({ default_repo: "must-not-persist", notifications: { enabled: true, rules: [{ id: "bad" }] } });
    } catch (error) { invalidError = error.message; }
    const afterInvalid = readSettings();
    setSetting("notifications", "{");
    let corruptError = "";
    const bounded = firstClaim.every((item) => item.title.length <= 120 && item.body.length <= 240);
    try { readSettings(); } catch (error) { corruptError = error.message; }
    console.log(JSON.stringify({
      defaultOffCount, afterInitialSnapshot, persistedActivation, bounded,
      firstIds: firstClaim.map((item) => item.id), replayClaim, humanOnlyIds,
      invalidError, corruptError, priorDefaultRepo: priorSettings.default_repo,
      afterInvalidDefaultRepo: afterInvalid.default_repo,
      notificationsUnchanged: JSON.stringify(priorSettings.notifications) === JSON.stringify(afterInvalid.notifications),
    }));
    db.close();
  `);

  expect(result.defaultOffCount).toBe(0);
  expect(Date.parse(result.persistedActivation as string)).not.toBeNaN();
  expect(result.afterInitialSnapshot).toBe(0);
  expect(result.firstIds).toEqual([
    "comment:acme/app#7:bot",
    "comment:acme/app#7:configured",
    "comment:acme/app#7:declared-human",
    "comment:acme/app#7:human",
    "review:acme/app#7:review-new",
    "thread-comment:acme/app#7:44",
  ]);
  expect(result.replayClaim).toEqual([]);
  expect(result.humanOnlyIds).toEqual(["comment:acme/app#7:person"]);
  expect(result.invalidError).toMatch(/notification rule/i);
  expect(result.bounded).toBe(true);
  expect(result.afterInvalidDefaultRepo).toBe(result.priorDefaultRepo);
  expect(result.notificationsUnchanged).toBe(true);
  expect(result.corruptError).not.toBe("");
});

test("transitions honor activation, requests have no invented actor, claims are atomic batches, and rule changes discard pending work", async () => {
  const notificationsUrl = new URL("./notifications.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const result = await runScenario(`
    const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
    const { observePrNotifications, claimNotifications } = await import(${JSON.stringify(notificationsUrl)});
    const { writeSettings } = await import(${JSON.stringify(settingsUrl)});
    const iso = (day) => \`2031-02-\${String(day).padStart(2, "0")}T00:00:00Z\`;
    const detail = (overrides = {}) => ({
      title: "Transition PR", state: "OPEN", isDraft: true,
      author: { login: "unknown-author" }, viewerLogin: "viewer", viewerIsAuthor: false,
      viewerReviewRequested: false, assignees: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] },
      reviewThreads: { nodes: [] }, lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      updatedAt: iso(5), ...overrides,
    });
    const row = (value, fetchedAt) => ({ detail_json: JSON.stringify(value), fetched_at: fetchedAt });
    const nextRow = (value, fetchedAt = iso(5), number = 9) => ({ repo: "acme/app", number, ...row(value, fetchedAt) });
    const allRule = { id: "all", name: "Everything", enabled: true, events: ["comment", "review", "review_requested", "checks_failed", "merged", "closed", "reopened", "ready_for_review"], match: "all", conditions: [] };
    writeSettings({ notifications: { enabled: true, rules: [allRule] } });
    setSetting("notifications_enabled_at", iso(2));
    const previous = detail();
    const transitioned = detail({
      state: "MERGED", isDraft: false, viewerReviewRequested: true, updatedAt: iso(5),
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    });
    observePrNotifications(row(previous, iso(1)), nextRow(transitioned));
    const historicalTransitions = claimNotifications();
    observePrNotifications(row(previous, iso(3)), nextRow(transitioned));
    const transitions = claimNotifications();


    const closed = detail({ state: "CLOSED", updatedAt: iso(5) });
    observePrNotifications(row(previous, iso(3)), nextRow(closed, iso(5), 13));
    const reopened = detail({ state: "OPEN", updatedAt: iso(6) });
    observePrNotifications(row(closed, iso(5)), nextRow(reopened, iso(6), 14));
    const stateTransitions = claimNotifications();
    const failedSameUpdatedAt = detail({ isDraft: false, updatedAt: iso(5), lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } });
    observePrNotifications(row(detail({ isDraft: false, updatedAt: iso(5) }), iso(7)), nextRow(failedSameUpdatedAt, iso(8), 15));
    const recoveredSameUpdatedAt = detail({ isDraft: false, updatedAt: iso(5) });
    observePrNotifications(row(recoveredSameUpdatedAt, iso(9)), nextRow(failedSameUpdatedAt, iso(10), 15));
    const repeatedFailures = claimNotifications();
    const comments = [
      ...Array.from({ length: 105 }, (_, index) => ({
        id: \`a-reject-\${String(index).padStart(3, "0")}\`, author: { __typename: "User", login: "alice" }, body: "reject", createdAt: iso(6),
      })),
      ...Array.from({ length: 22 }, (_, index) => ({
        id: \`z-wanted-\${String(index).padStart(3, "0")}\`, author: { __typename: "User", login: "alice" }, body: "wanted", createdAt: iso(6),
      })),
    ];
    const many = detail({ comments: { nodes: comments } });
    observePrNotifications(row(detail(), iso(3)), nextRow(many, iso(6), 10));
    const wantedRule = { id: "wanted", name: "Wanted comments", enabled: true, events: ["comment"], match: "all", conditions: [{ field: "body", operator: "contains", value: "wanted" }] };
    setSetting("notifications", JSON.stringify({ enabled: true, rules: [wantedRule] }));
    const claimA = claimNotifications();
    const claimB = claimNotifications();
    const claimC = claimNotifications();
    const pending = detail({ comments: { nodes: [{ id: "discard", author: { __typename: "User", login: "alice" }, body: "wanted pending", createdAt: iso(7) }] } });
    observePrNotifications(row(detail(), iso(3)), nextRow(pending, iso(7), 11));
    writeSettings({ notifications: { enabled: true, rules: [{ ...allRule, name: "Edited" }] } });
    const afterRuleEdit = claimNotifications();
    const pendingDisable = detail({ comments: { nodes: [{ id: "disable", author: { __typename: "User", login: "alice" }, body: "pending", createdAt: iso(8) }] } });
    observePrNotifications(row(detail(), iso(3)), nextRow(pendingDisable, iso(8), 12));
    writeSettings({ notifications: { enabled: false, rules: [{ ...allRule, name: "Edited" }] } });
    const afterDisable = claimNotifications();
    const pendingRows = db.query("select count(*) as count from desktop_notifications where claimed_at is null").get().count;
    console.log(JSON.stringify({ historicalTransitions, transitions, stateTransitions, repeatedFailures, claimSizes: [claimA.length, claimB.length, claimC.length], afterRuleEdit, afterDisable, pendingRows }));
    db.close();
  `);

  expect(result.historicalTransitions).toEqual([]);
  expect((result.transitions as Array<{ id: string; body: string }>).map((item) => item.id)).toEqual([
    "checks_failed:acme/app#9:2031-02-03T00:00:00Z",
    "merged:acme/app#9:2031-02-03T00:00:00Z",
    "ready_for_review:acme/app#9:2031-02-03T00:00:00Z",
    "review_requested:acme/app#9:2031-02-03T00:00:00Z",
  ]);
  expect((result.transitions as Array<{ id: string; body: string }>).find((item) => item.id.startsWith("review_requested:"))?.body).toBe("acme/app#9");
  expect(result.claimSizes).toEqual([20, 2, 0]);
  expect((result.stateTransitions as Array<{ id: string }>).map((item) => item.id)).toEqual([
    "closed:acme/app#13:2031-02-03T00:00:00Z",
    "reopened:acme/app#14:2031-02-05T00:00:00Z",
  ]);
  expect((result.repeatedFailures as Array<{ id: string }>).map((item) => item.id)).toEqual([
    "checks_failed:acme/app#15:2031-02-07T00:00:00Z",
    "checks_failed:acme/app#15:2031-02-09T00:00:00Z",
  ]);
  expect(result.afterRuleEdit).toEqual([]);
  expect(result.afterDisable).toEqual([]);
  expect(result.pendingRows).toBe(0);
});

test("replica inbox import observes local notification rules without replicating local state", async () => {
  const notificationsUrl = new URL("./notifications.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const replicaUrl = new URL("./replica.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const result = await runScenario(`
    const { db, getSetting, readInboxReplica, setSetting, upsertPr } = await import(${JSON.stringify(dbUrl)});
    const { claimNotifications } = await import(${JSON.stringify(notificationsUrl)});
    const { importInboxReplica } = await import(${JSON.stringify(replicaUrl)});
    const { writeSettings } = await import(${JSON.stringify(settingsUrl)});
    const previousAt = "2032-03-03T00:00:00Z";
    const nextAt = "2032-03-04T00:00:00Z";
    const detail = (comments) => ({
      title: "Replica PR", state: "OPEN", isDraft: false,
      author: { __typename: "User", login: "owner" }, viewerLogin: "viewer", viewerIsAuthor: false,
      viewerReviewRequested: false, assignees: { nodes: [] }, comments: { nodes: comments }, reviews: { nodes: [] },
      reviewThreads: { nodes: [] }, lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      updatedAt: nextAt,
    });
    const previousDetail = detail([]);
    const row = {
      repo: "acme/replica", number: 21, state: "OPEN", is_draft: 0, title: "Replica PR", author: "owner",
      base_ref: "main", head_ref: "feature", head_sha: "abc", updated_at: previousAt,
      additions: 1, deletions: 0, changed_files: 1, commit_count: 1, mergeable: "MERGEABLE", merge_state_status: "CLEAN",
      auto_merge_enabled: 0, viewer_is_author: 0, viewer_review_requested: 0, viewer_review_state: null,
      ci_status: "SUCCESS", review_decision: null, unresolved_count: 0, needs_me_rank: 0,
      greptile_confidence: null, greptile_reviewed_sha: null, greptile_unresolved_count: 0,
      detail_json: JSON.stringify(previousDetail), fetched_at: previousAt,
    };
    upsertPr(row);
    writeSettings({ notifications: { enabled: true, rules: [{ id: "comments", name: "Comments", enabled: true, events: ["comment"], match: "all", conditions: [] }] } });
    setSetting("notifications_enabled_at", "2032-03-01T00:00:00Z");
    const snapshot = readInboxReplica();
    snapshot.prs = [{ ...row, detail_json: JSON.stringify(detail([{
      id: "replica-comment", author: { __typename: "User", login: "reviewer" }, body: "from replica", createdAt: nextAt,
    }])), fetched_at: nextAt }];
    importInboxReplica(snapshot);
    const first = claimNotifications();
    importInboxReplica(snapshot);
    const duplicate = claimNotifications();
    console.log(JSON.stringify({
      first, duplicate,
      settingsStillLocal: JSON.parse(getSetting("notifications")).enabled,
      snapshotHasSettings: Object.hasOwn(snapshot, "settings"),
      snapshotHasQueue: Object.hasOwn(snapshot, "desktop_notifications"),
    }));
    db.close();
  `);

  expect(result.first).toEqual([expect.objectContaining({
    id: "comment:acme/replica#21:replica-comment",
    repo: "acme/replica",
    number: 21,
  })]);
  expect(result.duplicate).toEqual([]);
  expect(result.settingsStillLocal).toBe(true);
  expect(result.snapshotHasSettings).toBe(false);
  expect(result.snapshotHasQueue).toBe(false);
});

test("an I-merged-it rule fires for the viewer's own merges and queue-bot merges the viewer ordered", async () => {
  const notificationsUrl = new URL("./notifications.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const result = await runScenario(`
    const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
    const { observePrNotifications, claimNotifications, mergeAttributionWanted } = await import(${JSON.stringify(notificationsUrl)});
    const { writeSettings } = await import(${JSON.stringify(settingsUrl)});
    const iso = (day) => \`2032-04-\${String(day).padStart(2, "0")}T00:00:00Z\`;
    const detail = (overrides = {}) => ({
      title: "Merge me", state: "OPEN", isDraft: false, author: { __typename: "User", login: "author" },
      viewerLogin: "Viewer", viewerIsAuthor: false, viewerReviewRequested: false, assignees: { nodes: [] },
      comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, updatedAt: iso(5), ...overrides,
    });
    const bot = { __typename: "Bot", login: "queue-bot" };
    const merges = {
      1: { mergedBy: { __typename: "User", login: "viewer" } },
      2: { mergedBy: bot, orderedBy: { login: "VIEWER" } },
      3: { mergedBy: { __typename: "User", login: "someone" } },
      4: { mergedBy: bot, orderedBy: { login: "someone" } },
      5: { mergedBy: { __typename: "User", login: "someone" }, orderedBy: { login: "viewer" } },
      6: {},
    };
    const observe = () => {
      for (const [number, merge] of Object.entries(merges)) {
        observePrNotifications(
          { detail_json: JSON.stringify(detail()), fetched_at: iso(3) },
          { repo: "acme/app", number: Number(number), detail_json: JSON.stringify(detail({ state: "MERGED", ...merge })), fetched_at: iso(5) },
        );
      }
    };
    const wantedBefore = mergeAttributionWanted();
    const rule = { id: "my-merges", name: "PRs I merge", enabled: true, events: ["merged"], match: "all", conditions: [{ field: "participation", operator: "is", value: "merger" }] };
    writeSettings({ notifications: { enabled: true, rules: [rule] } });
    setSetting("notifications_enabled_at", iso(2));
    const wantedByRule = mergeAttributionWanted();
    observe();
    const fired = claimNotifications().map((item) => item.number);
    writeSettings({ notifications: { enabled: true, rules: [{ ...rule, enabled: false }] }, merged_by_me_notifications_enabled: true });
    const wantedBySetting = mergeAttributionWanted();
    console.log(JSON.stringify({ wantedBefore, wantedByRule, wantedBySetting, fired }));
    db.close();
  `);

  expect(result.wantedBefore).toBe(false);
  expect(result.wantedByRule).toBe(true);
  expect(result.wantedBySetting).toBe(true);
  expect(result.fired).toEqual([1, 2]);
});
