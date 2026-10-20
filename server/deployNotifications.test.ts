import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a deploy notifies each merged PR its head first reaches, once, across re-runs, later deploys and restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-deploys-"));
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const settingsUrl = new URL("./settings.ts", import.meta.url).href;
  const runLogsUrl = new URL("./runLogs.ts", import.meta.url).href;
  const deploysUrl = new URL("./deployNotifications.ts", import.meta.url).href;
  const mirrorUrl = new URL("./mirror.ts", import.meta.url).href;
  // The scenario runs in a child process whose modules import after COCKPIT_DATA_DIR points at a scratch database.
  const source = `
    const { db, setSetting, upsertPrIndex, upsertCachedPrDetail } = await import(${JSON.stringify(dbUrl)});
    const { writeSettings } = await import(${JSON.stringify(settingsUrl)});
    const { refreshRecentActions } = await import(${JSON.stringify(runLogsUrl)});
    const { checkDeployRun, queueDeployCheck } = await import(${JSON.stringify(deploysUrl)});
    const { deployedCommitsFromMirror } = await import(${JSON.stringify(mirrorUrl)});
    const dataDir = ${JSON.stringify(dataDir)};
    const repo = "acme/app";
    const mirror = dataDir + "/mirrors/acme__app";
    const work = dataDir + "/work";
    const git = (cwd, ...args) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...Bun.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git(dataDir, "init", "-q", "-b", "staging", work);
    const commit = (subject) => { git(work, "commit", "-q", "--allow-empty", "-m", subject); return git(work, "rev-parse", "HEAD"); };
    commit("Initial");
    const shipZero = commit("Ship zero (#10)");
    const shipOne = commit("Ship one (#11)");
    const notMine = commit("Someone else's change (#14)");
    const shipTwo = commit("Ship two (#12)");
    const shipThree = commit("Ship three (#13)");
    git(dataDir, "clone", "-q", "--bare", work, mirror);
    const shipFour = commit("Ship four (#15)");

    const now = Date.now();
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString().replace(/\\.\\d{3}Z$/, "Z");
    const merged = (number, title, minutesAgo, mergeCommit, overrides = {}) => {
      upsertPrIndex([{ repo, number, title, state: "MERGED", isDraft: false, author: "viewer", updatedAt: at(minutesAgo), mergedAt: at(minutesAgo), closedAt: at(minutesAgo), involvesMe: true }]);
      upsertCachedPrDetail({ repo, number, head_sha: "f".repeat(40), fetched_at: at(minutesAgo), detail_json: JSON.stringify({
        number, title, state: "MERGED", mergedAt: at(minutesAgo), baseRefName: "staging", isDraft: false,
        author: { __typename: "User", login: "viewer" }, viewerLogin: "viewer", viewerIsAuthor: true,
        viewerReviewRequested: false, assignees: { nodes: [] },
        ...(mergeCommit === undefined ? {} : { mergeCommit: { oid: mergeCommit } }), ...overrides,
      }) });
    };
    merged(10, "Ship zero", 80, shipZero);
    merged(11, "Ship one", 40, shipOne);
    merged(14, "Someone else's change", 39, notMine, { author: { login: "other" }, viewerIsAuthor: false });
    merged(12, "Ship two", 38, shipTwo);
    // Cached before Cockpit read merge commits: matched by GitHub's squash subject on the branch.
    merged(13, "Ship three", 15);
    merged(16, "Ship to release", 37, shipTwo, { baseRefName: "release" });

    const run = (id, attempt, head, minutesAgo, name = "Deploy") => ({
      id, run_attempt: attempt, head_sha: head, head_branch: "staging", name, path: ".github/workflows/deploy.yml",
      display_title: name, event: "push", actor: { login: "deployer" }, status: "completed", conclusion: "success",
      created_at: at(minutesAgo + 5), updated_at: at(minutesAgo), run_started_at: at(minutesAgo + 5), run_number: id, html_url: null,
    });
    const ingest = async (...runs) => {
      await refreshRecentActions(repo, async () => runs, async () => []);
      await queueDeployCheck(repo, 0, 0);
    };
    const notifications = () => db.query("SELECT id, title, body, number FROM desktop_notifications ORDER BY number").all();

    // Deployed before notifications were turned on.
    writeSettings({ notifications: { enabled: true, rules: [{
      id: "deploys", name: "My PRs deployed", enabled: true, events: ["deployed"], match: "all", conditions: [
        { field: "participation", operator: "is", value: "author" },
        { field: "workflow", operator: "is", value: "Deploy" },
        { field: "branch", operator: "is", value: "staging" },
      ],
    }] } });
    setSetting("notifications_enabled_at", at(50));
    await ingest(run(100, 1, shipZero, 60));
    const beforeActivation = notifications().length;

    await ingest(run(101, 1, shipTwo, 30));
    const firstDeploy = notifications();
    await ingest(run(101, 2, shipTwo, 25));
    await ingest(run(102, 1, shipTwo, 20), run(103, 1, shipThree, 18, "CI"));
    // A restart re-ingests history; detection reruns against the same runs and finds nothing new.
    await checkDeployRun(repo, 101, 1);
    await checkDeployRun(repo, 102, 1);
    const afterRepeats = notifications();

    await ingest(run(104, 1, shipThree, 10));
    const afterThirdDeploy = notifications();

    // A head the mirror lacks is fetched, not skipped.
    merged(15, "Ship four", 8, shipFour);
    await refreshRecentActions(repo, async () => [], async () => []);
    db.query("INSERT INTO workflow_runs (repo, run_id, run_attempt, head_sha, head_branch, workflow_name, status, conclusion, event_at, updated_at, actor_login, fetched_at) VALUES (?, 105, 1, ?, 'staging', 'Deploy', 'completed', 'success', ?, ?, 'deployer', datetime('now'))")
      .run(repo, shipFour, at(5), at(5));
    let fetches = 0;
    await checkDeployRun(repo, 105, 1, {
      deployedCommits: deployedCommitsFromMirror,
      fetchMirror: async () => { fetches++; git(work, "push", "-q", mirror, "staging"); },
    });
    console.log(JSON.stringify({ beforeActivation, firstDeploy, afterRepeats, afterThirdDeploy, fetches, final: notifications().map((row) => row.number) }));
    db.close();
  `;
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
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.beforeActivation).toBe(0);
    expect(result.firstDeploy).toEqual([
      { id: "deployed:acme/app#11:Deploy:staging", title: "Deployed to staging", body: "#11 Ship one · Deploy", number: 11 },
      { id: "deployed:acme/app#12:Deploy:staging", title: "Deployed to staging", body: "#12 Ship two · Deploy", number: 12 },
    ]);
    expect(result.afterRepeats).toEqual(result.firstDeploy);
    expect(result.afterThirdDeploy.map((row: { number: number }) => row.number)).toEqual([11, 12, 13]);
    expect(result.fetches).toBe(1);
    expect(result.final).toEqual([11, 12, 13, 15]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
