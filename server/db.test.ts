import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
const agentsModuleUrl = new URL("./agents.ts", import.meta.url).href;

test("pinned PRs stay pinned until they are archived or leave the open inbox", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-pinned-lifecycle-"));
  const scenario = `
    const { db, evictStalePrs, getRanks, setArchived, setRank } = await import(${JSON.stringify(dbModuleUrl)});
    const repo = "test/pinned-lifecycle";
    setRank(repo, 1, 10);
    setRank(repo, 2, 20);
    const before = [...getRanks().keys()].sort();
    setArchived(repo, 1, true);
    const afterArchive = [...getRanks().keys()].sort();
    evictStalePrs(repo, []);
    const afterEviction = [...getRanks().keys()].sort();
    console.log(JSON.stringify({ before, afterArchive, afterEviction }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    expect(JSON.parse(stdout)).toEqual({
      before: [`test/pinned-lifecycle#1`, `test/pinned-lifecycle#2`],
      afterArchive: [`test/pinned-lifecycle#2`],
      afterEviction: [],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("eviction preserves the newest tracked detail and its observed freshness", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-eviction-"));
  const scenario = `
    // Dynamic import is required so the isolated child sets COCKPIT_DATA_DIR before db.ts opens SQLite.
    const { db, evictStalePrs, getCachedPrDetail, getPr, upsertCachedPrDetail } = await import(${JSON.stringify(dbModuleUrl)});
    const repo = "test/eviction-cache";
    const number = 987654;
    const observedAt = new Date().toISOString();
    const trackedDetail = JSON.stringify({ title: "new tracked detail", state: "MERGED" });
    upsertCachedPrDetail({
      repo,
      number,
      head_sha: "old-head",
      detail_json: JSON.stringify({ title: "old cached detail" }),
      fetched_at: new Date(Date.now() - 16 * 60_000).toISOString(),
    });
    db.query(\`
      INSERT INTO prs (
        repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
        updated_at, additions, deletions, changed_files, commit_count, mergeable,
        ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(
      repo, number, "MERGED", 0, "new tracked detail", "theo", "main", "feature", "new-head",
      "2026-07-24T18:00:00.000Z", 1, 0, 1, 1, "MERGEABLE", "passing", 0, 0,
      trackedDetail, observedAt,
    );
    evictStalePrs(repo, []);
    const cached = getCachedPrDetail(repo, number);
    console.log(JSON.stringify({
      prMissing: getPr(repo, number) === null,
      headSha: cached?.head_sha,
      detailJson: cached?.detail_json,
      fetchedAt: cached?.fetched_at,
      observedAt,
    }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    const result = JSON.parse(stdout);
    expect(result.prMissing).toBe(true);
    expect(result.headSha).toBe("new-head");
    expect(result.detailJson).toBe(JSON.stringify({ title: "new tracked detail", state: "MERGED" }));
    expect(result.fetchedAt).toBe(result.observedAt);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("older refreshes cannot replace newer pull request snapshots", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-monotonic-snapshot-"));
  const scenario = `
    // Dynamic imports are required so the isolated child sets COCKPIT_DATA_DIR before db.ts opens SQLite.
    await import(${JSON.stringify(agentsModuleUrl)});
    const { db, evictStalePrs, getCachedPrDetail, getPr, upsertCachedPrDetail, upsertPr, readInboxReplica, replaceInboxReplica } = await import(${JSON.stringify(dbModuleUrl)});
    const repo = "test/monotonic-snapshot";
    const base = {
      repo,
      number: 1,
      state: "OPEN",
      is_draft: 0,
      title: "new",
      author: "theo",
      base_ref: "main",
      head_ref: "fix",
      head_sha: "new-head",
      updated_at: "2026-09-05T12:50:00.000Z",
      additions: 1,
      deletions: 0,
      changed_files: 1,
      commit_count: 1,
      mergeable: "MERGEABLE",
      merge_state_status: "CLEAN",
      auto_merge_enabled: 0,
      viewer_is_author: 1,
      viewer_review_requested: 0,
      viewer_review_state: null,
      ci_status: "SUCCESS",
      review_decision: null,
      unresolved_count: 0,
      needs_me_rank: 0,
      greptile_confidence: null,
      greptile_reviewed_sha: null,
      greptile_unresolved_count: 0,
      detail_json: JSON.stringify({ title: "new" }),
      fetched_at: "2026-09-05T12:50:15.868Z",
    };
    upsertPr(base);
    upsertPr({ ...base, title: "old", head_sha: "old-head", detail_json: JSON.stringify({ title: "old" }), fetched_at: "2026-09-04T12:51:31.191Z" });
    upsertCachedPrDetail({ repo, number: 2, head_sha: "new-head", detail_json: JSON.stringify({ title: "new" }), fetched_at: "2026-09-05T12:50:15.868Z" });
    upsertCachedPrDetail({ repo, number: 2, head_sha: "old-head", detail_json: JSON.stringify({ title: "old" }), fetched_at: "2026-09-04T12:51:31.191Z" });
    const freshCacheAt = new Date().toISOString();
    upsertPr({ ...base, number: 3, title: "tracked", detail_json: JSON.stringify({ title: "tracked" }), fetched_at: freshCacheAt });
    upsertCachedPrDetail({ repo, number: 3, head_sha: "new-head", detail_json: JSON.stringify({ title: "new cache" }), fetched_at: freshCacheAt });
    evictStalePrs(repo, [1]);
    const replica = readInboxReplica();
    replica.prs = [{ ...base, title: "obsolete replica", fetched_at: "2026-09-04T12:51:31.191Z" }];
    replaceInboxReplica(replica);
    const replicaTracked = getPr(repo, 1);
    replica.prs = [];
    replaceInboxReplica(replica);
    const replicaEvicted = getCachedPrDetail(repo, 1);
    upsertPr(base);
    console.log(JSON.stringify({ tracked: getPr(repo, 1), cached: getCachedPrDetail(repo, 2), evictedCache: getCachedPrDetail(repo, 3), freshCacheAt, replicaTracked, replicaEvicted }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    const result = JSON.parse(stdout);
    expect(result.tracked).toMatchObject({ title: "new", head_sha: "new-head", fetched_at: "2026-09-05T12:50:15.868Z" });
    expect(result.cached).toMatchObject({ head_sha: "new-head", fetched_at: "2026-09-05T12:50:15.868Z" });
    expect(result.evictedCache).toMatchObject({ head_sha: "new-head", detail_json: JSON.stringify({ title: "new cache" }), fetched_at: result.freshCacheAt });
    expect(result.replicaTracked).toMatchObject({ title: "new", fetched_at: "2026-09-05T12:50:15.868Z" });
    expect(result.replicaEvicted).toMatchObject({ detail_json: JSON.stringify({ title: "new" }), fetched_at: "2026-09-05T12:50:15.868Z" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fresh databases include terminal PR index columns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-fresh-index-"));
  const scenario = `
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    console.log(JSON.stringify(db.query("PRAGMA table_info(pr_index)").all().map((column) => column.name)));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    expect(JSON.parse(stdout)).toEqual(expect.arrayContaining(["merged_at", "closed_at", "involves_me"]));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("migrates populated PR index and preserves terminal metadata on partial upserts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-index-migration-"));
  const scenario = `
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(${JSON.stringify(join(dataDir, "cockpit.db"))});
    legacy.exec(\`
      CREATE TABLE pr_index (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        is_draft INTEGER NOT NULL,
        author TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo, number)
      );
      INSERT INTO pr_index VALUES (
        'test/repo', 1, 'legacy', 'OPEN', 0, 'theo', '2026-01-01T00:00:00Z'
      );
    \`);
    legacy.close();

    const { db, listClosedPrs, upsertPrIndex } = await import(${JSON.stringify(dbModuleUrl)});
    upsertPrIndex([{
      repo: "test/repo",
      number: 1,
      title: "merged",
      state: "MERGED",
      isDraft: false,
      author: "theo",
      updatedAt: "2026-08-01T00:00:00Z",
      mergedAt: "2026-08-03T00:00:00Z",
      closedAt: "2026-08-02T00:00:00Z",
      involvesMe: true,
    }]);
    upsertPrIndex([{
      repo: "test/repo",
      number: 1,
      title: "merged again",
      state: "MERGED",
      isDraft: false,
      author: "theo",
      updatedAt: "2026-08-04T00:00:00Z",
      involvesMe: false,
    }]);
    upsertPrIndex([
      {
        repo: "test/repo",
        number: 2,
        title: "closed",
        state: "CLOSED",
        isDraft: false,
        author: "theo",
        updatedAt: "2026-08-01T00:00:00Z",
        closedAt: "2026-08-05T00:00:00Z",
        involvesMe: true,
      },
      {
        repo: "test/repo",
        number: 3,
        title: "not mine",
        state: "MERGED",
        isDraft: false,
        author: "other",
        updatedAt: "2026-08-06T00:00:00Z",
        mergedAt: "2026-08-06T00:00:00Z",
      },
      {
        repo: "test/repo",
        number: 4,
        title: "still open",
        state: "OPEN",
        isDraft: false,
        author: "theo",
        updatedAt: "2026-08-07T00:00:00Z",
        involvesMe: true,
      },
    ]);
    const columns = db.query("PRAGMA table_info(pr_index)").all().map((column) => column.name);
    const persisted = db.query("SELECT merged_at, closed_at, involves_me FROM pr_index WHERE repo = ? AND number = ?").get("test/repo", 1);
    const closed = listClosedPrs(10).map((row) => row.number);
    console.log(JSON.stringify({ columns, persisted, closed }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    const result = JSON.parse(stdout);
    expect(result.columns).toEqual(expect.arrayContaining(["merged_at", "closed_at", "involves_me"]));
    expect(result.persisted).toEqual({
      merged_at: "2026-08-03T00:00:00Z",
      closed_at: "2026-08-02T00:00:00Z",
      involves_me: 1,
    });
    expect(result.closed).toEqual([2, 1]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("schema updates preserve the normalized PR cache", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-schema-cache-"));
  const seed = `
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    db.query(\`
      INSERT INTO prs (
        repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
        updated_at, additions, deletions, changed_files, commit_count, mergeable,
        ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`).run(
      "test/repo", 42, "OPEN", 0, "cached PR", "theo", "main", "fix", "cached-head",
      "2026-08-26T00:00:00.000Z", 1, 0, 1, 1, "MERGEABLE", "passing", 0, 0,
      "{}", "2026-08-26T00:00:00.000Z",
    );
    db.query(\`
      INSERT INTO pr_index (repo, number, title, state, is_draft, author, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    \`).run("test/repo", 42, "cached PR", "OPEN", 0, "theo", "2026-08-26T00:00:00.000Z");
    db.exec("PRAGMA user_version = 1");
    db.close();
  `;
  const inspect = `
    const { db, getPr } = await import(${JSON.stringify(dbModuleUrl)});
    console.log(JSON.stringify({
      title: getPr("test/repo", 42)?.title,
      indexed: db.query("SELECT COUNT(*) AS count FROM pr_index").get().count,
    }));
    db.close();
  `;

  try {
    const seeded = Bun.spawnSync([Bun.which("bun") ?? "bun", "-e", seed], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
    });
    if (!seeded.success) throw new Error(seeded.stderr.toString());
    const inspected = Bun.spawnSync([Bun.which("bun") ?? "bun", "-e", inspect], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
    });
    if (!inspected.success) throw new Error(inspected.stderr.toString());
    expect(JSON.parse(inspected.stdout.toString())).toEqual({ title: "cached PR", indexed: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup drops Actions leases because browser presence cannot survive the server process", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-actions-lease-reset-"));
  const databasePath = join(dataDir, "cockpit.db");
  const scenario = `
    const { Database } = await import("bun:sqlite");
    const stored = new Database(${JSON.stringify(databasePath)});
    stored.exec(\`
      CREATE TABLE actions_leases (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        bootstrapped_at TEXT,
        PRIMARY KEY (repo, number)
      );
      INSERT INTO actions_leases VALUES ('acme/app', 7, 'head', '2099-01-01T00:00:00Z', NULL);
    \`);
    stored.close();
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    console.log(db.query("SELECT COUNT(*) AS count FROM actions_leases").get().count);
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    expect(stdout.trim()).toBe("0");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("startup removes retired generated score tables", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-score-table-migration-"));
  const databasePath = join(dataDir, "cockpit.db");
  const scenario = `
    const { Database } = await import("bun:sqlite");
    const stored = new Database(${JSON.stringify(databasePath)});
    stored.exec("CREATE TABLE review_scores (node_id TEXT PRIMARY KEY); CREATE TABLE review_rescores (repo TEXT);");
    stored.close();
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    const names = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('review_scores', 'review_rescores')").all();
    console.log(JSON.stringify(names));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
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
    expect(JSON.parse(stdout)).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Actions lookups by run, commit, and branch are served by their indexes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-actions-indexes-"));
  const scenario = `
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    const plan = (sql) => db.query("EXPLAIN QUERY PLAN " + sql).all().map((row) => row.detail).join(" | ");
    console.log(JSON.stringify({
      run: plan("SELECT * FROM run_jobs WHERE repo = 'r' AND run_id = 1 AND run_attempt = 1"),
      commit: plan("SELECT * FROM workflow_runs WHERE repo = 'r' AND head_sha = 's' ORDER BY run_id, run_attempt"),
      branch: plan("SELECT * FROM workflow_runs WHERE repo = 'r' AND head_branch = 'b' ORDER BY event_at DESC, run_id DESC, run_attempt DESC"),
    }));
    db.close();
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
    const plans = JSON.parse(stdout) as Record<string, string>;
    expect(plans.run).toContain("run_jobs_run_idx (repo=? AND run_id=? AND run_attempt=?)");
    expect(plans.commit).toContain("workflow_runs_sha_idx (repo=? AND head_sha=?)");
    expect(plans.branch).toContain("workflow_runs_branch_idx (repo=? AND head_branch=?)");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
