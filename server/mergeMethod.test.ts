import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts runs migrations and startup cleanup at module load, so every project import
// here would touch the live database. The whole suite therefore runs in one child
// process with an isolated COCKPIT_DATA_DIR; the parent only spawns and asserts.
test("merge method learning semantics against an isolated database", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-merge-method-"));
  const scenario = `
    const { isMethodNotAllowedError, learnMergeMethod, mergeAllowedNow, mergeMethodFor, mergeMethodSourceFor, mergeWithLearning, mergeWithSelection, setMergeMethodPreference } = await import(${JSON.stringify(new URL("./mergeMethod.ts", import.meta.url).href)});
    const { RestRequestError } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
    const { db, setSetting } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { currentBaseRef, enqueueMutation } = await import(${JSON.stringify(new URL("./mutations.ts", import.meta.url).href)});
    const REJECTIONS = {
      squash: "Squash merges are not allowed on this repository.",
      merge: "Merge commits are not allowed on this repository.",
      rebase: "Rebase merges are not allowed on this repository.",
    };
    const notAllowed = (method, status = 405) =>
      new RestRequestError('PUT /repos/x/pulls/1/merge failed: ' + status + ' {"message":"' + REJECTIONS[method] + '"}', status);
    const learnedRows = (repo) => db.query("SELECT method FROM merge_methods WHERE repo = ?").all(repo).length;
    const out = {};

    out.classifierMatches = [
      isMethodNotAllowedError(notAllowed("squash")),
      isMethodNotAllowedError(notAllowed("rebase")),
      isMethodNotAllowedError(notAllowed("merge", 422)),
      isMethodNotAllowedError(new RestRequestError("PUT ... failed: 405 Merge is not an allowed merge method in this repository.", 405)),
    ];
    out.classifierRejects = [
      isMethodNotAllowedError(new RestRequestError("PUT ... failed: 405 Pull Request is not mergeable", 405)),
      isMethodNotAllowedError(new RestRequestError("PUT ... failed: 409 Head branch was modified", 409)),
      isMethodNotAllowedError(new RestRequestError("PUT ... failed: 500 Squash merges are not allowed on this repository.", 500)),
      isMethodNotAllowedError(new Error("Squash merges are not allowed on this repository.")),
    ];

    out.noBaseThrew = (() => {
      try { currentBaseRef("acme/absent", 999999); return false; }
      catch (err) { return String(err).includes("no base ref known"); }
    })();
    out.gateAllowed = ["CLEAN", "UNSTABLE", "HAS_HOOKS"].map((s) => mergeAllowedNow("acme/repo", { merge_state_status: s }));
    out.gateDenied = ["DIRTY", "BEHIND", "BLOCKED", "UNKNOWN"].map((s) => mergeAllowedNow("acme/repo", { merge_state_status: s }));
    setSetting("force_merge_repos", "acme/repo");
    out.gateForceBlocked = mergeAllowedNow("acme/repo", { merge_state_status: "BLOCKED" });
    out.gateForceOtherRepo = mergeAllowedNow("acme/other", { merge_state_status: "BLOCKED" });
    out.gateForceNeverDirty = mergeAllowedNow("acme/repo", { merge_state_status: "DIRTY" });

    out.unknownDefault = mergeMethodFor("acme/unknown", "main");
    learnMergeMethod("acme/learned", "production", "merge");
    out.learned = mergeMethodFor("acme/learned", "production");
    out.otherBaseDefault = mergeMethodFor("acme/learned", "staging");
    learnMergeMethod("acme/learned", "production", "rebase");
    out.relearned = mergeMethodFor("acme/learned", "production");
    setMergeMethodPreference("acme/explicit", "production", "merge");
    out.explicitMethod = mergeMethodFor("acme/explicit", "production");
    out.explicitSource = mergeMethodSourceFor("acme/explicit", "production");
    learnMergeMethod("acme/explicit", "production", "rebase");
    out.explicitAfterLearning = mergeMethodFor("acme/explicit", "production");
    const explicitCalls = [];
    await mergeWithLearning("acme/explicit", 4, "production", undefined, async (_r, _n, method) => { explicitCalls.push(method); });
    out.explicitCalls = explicitCalls;
    setMergeMethodPreference("acme/explicit", "production", "rebase");
    const snapshotCalls = [];
    await mergeWithSelection("acme/explicit", 5, "production", "merge", "explicit", undefined, async (_r, _n, method) => { snapshotCalls.push(method); });
    out.snapshotCalls = snapshotCalls;
    out.invalidManualSnapshotRejected = (() => {
      try { enqueueMutation({ repo: "acme/repo", number: 1, payload: { kind: "merge", force: false, baseRef: "", method: "merge", source: "explicit" } }); return false; }
      catch (err) { return String(err).includes("branch and method snapshot"); }
    })();
    out.invalidNativeEnableRejected = (() => {
      try { enqueueMutation({ repo: "acme/repo", number: 1, payload: { kind: "github-auto-merge", enable: true, method: "octopus" } }); return false; }
      catch (err) { return String(err).includes("valid merge method"); }
    })();
    out.invalidNativeDisableRejected = (() => {
      try { enqueueMutation({ repo: "acme/repo", number: 1, payload: { kind: "github-auto-merge", enable: false, method: "squash" } }); return false; }
      catch (err) { return String(err).includes("must not include"); }
    })();

    const happyCalls = [];
    await mergeWithLearning("acme/happy", 1, "main", undefined, async (_r, _n, method) => { happyCalls.push(method); });
    out.happyCalls = happyCalls;
    out.happyRows = learnedRows("acme/happy");

    const walkCalls = [];
    await mergeWithLearning("acme/rebase-only", 1, "main", undefined, async (_r, _n, method) => {
      walkCalls.push(method);
      if (method !== "rebase") throw notAllowed(method);
    });
    out.walkCalls = walkCalls;
    out.walkLearned = mergeMethodFor("acme/rebase-only", "main");

    learnMergeMethod("acme/prod-merge", "production", "merge");
    const shaCalls = [];
    await mergeWithLearning("acme/prod-merge", 2, "production", "abc123", async (_r, _n, method, sha) => { shaCalls.push([method, sha]); });
    out.shaCalls = shaCalls;

    const lockedLearnedCalls = [];
    out.learnedRejectionThrew = await mergeWithLearning("acme/prod-merge", 3, "production", undefined, async (_r, _n, method) => {
      lockedLearnedCalls.push(method);
      throw notAllowed(method);
    }).then(() => false, (err) => String(err).includes("not allowed"));
    out.lockedLearnedCalls = lockedLearnedCalls;
    out.stillLearned = mergeMethodFor("acme/prod-merge", "production");

    out.nonMethodThrew = await mergeWithLearning("acme/flaky", 1, "main", undefined, async () => {
      throw new RestRequestError("PUT ... failed: 500 boom", 500);
    }).then(() => false, (err) => String(err).includes("boom"));
    out.flakyRows = learnedRows("acme/flaky");

    const allLockedCalls = [];
    out.allDisallowedThrew = await mergeWithLearning("acme/locked", 1, "main", undefined, async (_r, _n, method) => {
      allLockedCalls.push(method);
      throw notAllowed(method);
    }).then(() => false, (err) => String(err).includes("not allowed"));
    out.allLockedCalls = allLockedCalls;
    out.lockedRows = learnedRows("acme/locked");

    console.log(JSON.stringify(out));
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
    const result = JSON.parse(stdout);
    // classifier matches GitHub's method-rejection bodies on 405 and 422, nothing else
    expect(result.classifierMatches).toEqual([true, true, true, true]);
    expect(result.classifierRejects).toEqual([false, false, false, false]);
    // no known base ref throws instead of guessing
    expect(result.noBaseThrew).toBe(true);
    // merge gate: GitHub-offered states pass; BLOCKED only bypasses on a force-merge repo
    expect(result.gateAllowed).toEqual([true, true, true]);
    expect(result.gateDenied).toEqual([false, false, false, false]);
    expect(result.gateForceBlocked).toBe(true);
    expect(result.gateForceOtherRepo).toBe(false);
    expect(result.gateForceNeverDirty).toBe(false);
    expect(result.unknownDefault).toBe("squash");
    expect(result.learned).toBe("merge");
    expect(result.otherBaseDefault).toBe("squash");
    expect(result.relearned).toBe("rebase");
    // explicit dropdown choice is authoritative and cannot be overwritten by learning
    expect(result.explicitMethod).toBe("merge");
    expect(result.explicitSource).toBe("explicit");
    expect(result.explicitAfterLearning).toBe("merge");
    expect(result.explicitCalls).toEqual(["merge"]);
    expect(result.invalidNativeEnableRejected).toBe(true);
    expect(result.invalidNativeDisableRejected).toBe(true);
    // a queued manual merge executes the clicked branch/method snapshot, not a later preference
    expect(result.snapshotCalls).toEqual(["merge"]);
    expect(result.invalidManualSnapshotRejected).toBe(true);
    // first-try success under the default teaches nothing
    expect(result.happyCalls).toEqual(["squash"]);
    expect(result.happyRows).toBe(0);
    // an unlearned base walks squash -> merge -> rebase and persists the accepted method
    expect(result.walkCalls).toEqual(["squash", "merge", "rebase"]);
    expect(result.walkLearned).toBe("rebase");
    // a learned method is used directly with the bound sha
    expect(result.shaCalls).toEqual([["merge", "abc123"]]);
    // a learned method rejection surfaces instead of silently switching semantics
    expect(result.learnedRejectionThrew).toBe(true);
    expect(result.lockedLearnedCalls).toEqual(["merge"]);
    expect(result.stillLearned).toBe("merge");
    // non-method errors propagate without learning
    expect(result.nonMethodThrew).toBe(true);
    expect(result.flakyRows).toBe(0);
    // every method disallowed: the last rejection propagates, nothing is learned
    expect(result.allDisallowedThrew).toBe(true);
    expect(result.allLockedCalls).toEqual(["squash", "merge", "rebase"]);
    expect(result.lockedRows).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("merge worker refreshes the base and enforces its gate", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-merge-retarget-"));
  const scenario = `
    const { enqueueMutation, mutationsForPr } = await import(${JSON.stringify(new URL("./mutations.ts", import.meta.url).href)});
    const waitForFailure = async (id) => {
      let row;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        row = mutationsForPr("fixture/cockpit", 102).find((candidate) => candidate.id === id);
        if (row?.state === "failed") return row;
        await Bun.sleep(10);
      }
      return row;
    };
    const retargeted = await waitForFailure(enqueueMutation({
      repo: "fixture/cockpit",
      number: 102,
      payload: { kind: "merge", force: false, baseRef: "production", method: "merge", source: "explicit" },
    }));
    const gated = await waitForFailure(enqueueMutation({
      repo: "fixture/cockpit",
      number: 102,
      payload: { kind: "merge", force: false, baseRef: "main", method: "merge", source: "explicit" },
    }));
    console.log(JSON.stringify({ retargeted, gated }));
    await Bun.sleep(10);
    process.exit(retargeted?.state === "failed" && gated?.state === "failed" ? 0 : 2);
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
    const result = JSON.parse(stdout);
    expect(result.retargeted.state).toBe("failed");
    expect(result.retargeted.error).toContain("retargeted from production to main");
    expect(result.gated.state).toBe("failed");
    expect(result.gated.error).toContain("Cockpit merge gate rejected BLOCKED");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
