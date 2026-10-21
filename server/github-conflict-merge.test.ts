import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mirrorModuleUrl = new URL("./mirror.ts", import.meta.url).href;
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const resolvedNavigation = "export const route = 'settings-inbox';\n";

// main and topic both edit navigation.ts; each side also makes changes Git merges on its own.
async function conflictingRepository(): Promise<{ root: string; mirror: string; remote: string }> {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-conflict-merge-"));
  cleanup.push(root);
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  git(work, "config", "user.name", "PR Cockpit Test");
  git(work, "config", "user.email", "pr-cockpit@example.test");
  const shared = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`);
  await Bun.write(join(work, "navigation.ts"), "export const route = 'home';\n");
  await Bun.write(join(work, "shared.ts"), `${shared.join("\n")}\n`);
  await Bun.write(join(work, "retired.ts"), "export {};\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "switch", "-qc", "topic");
  await Bun.write(join(work, "navigation.ts"), "export const route = 'settings';\n");
  await Bun.write(join(work, "shared.ts"), `${shared.with(1, "line 2 from topic").join("\n")}\n`);
  await Bun.write(join(work, "topic-only.ts"), "export const topic = true;\n");
  git(work, "rm", "-q", "retired.ts");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "topic");
  git(work, "switch", "-q", "main");
  await Bun.write(join(work, "navigation.ts"), "export const route = 'inbox';\n");
  await Bun.write(join(work, "shared.ts"), `${shared.with(10, "line 11 from main").join("\n")}\n`);
  await Bun.write(join(work, "base-only.ts"), "export const base = true;\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "main");
  const mirror = join(root, "mirror.git");
  const remote = join(root, "github.git");
  git(root, "clone", "-q", "--bare", work, mirror);
  git(root, "clone", "-q", "--bare", work, remote);
  return { root, mirror, remote };
}

type Scenario = { mirror: string; remote: string; scratch: string; resolution: string; headMovesFirst?: boolean };

// Resolves every conflict in the mirror and commits through GitHub's Git Data API, which the fake fetch
// serves from `remote` with real Git objects, refusing a ref update that is not a fast-forward. The child
// loads the modules itself because github.ts binds fixture-token auth from the environment at import.
async function resolveAndCommit(scenario: Scenario) {
  const script = `
    const { conflictMergeFromGitDir, resolvedMergeFromGitDir } = await import(${JSON.stringify(mirrorModuleUrl)});
    const { commitPrMerge } = await import(${JSON.stringify(githubModuleUrl)});
    const scenario = ${JSON.stringify(scenario)};
    const identity = { GIT_AUTHOR_NAME: "GitHub", GIT_AUTHOR_EMAIL: "noreply@github.com", GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" };
    const remote = (args, input, env = {}) => {
      const result = Bun.spawnSync(["git", "--git-dir", scenario.remote, ...args], { stdin: input, env: { ...process.env, ...env } });
      if (!result.success) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    let indexes = 0;
    globalThis.fetch = async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "GET" && path === "/repos/acme/app/pulls/7") {
        return Response.json({
          state: "open",
          head: { sha: remote(["rev-parse", "refs/heads/topic"]), ref: "topic", repo: { full_name: "acme/app" } },
          base: { ref: "main", repo: { full_name: "acme/app" } },
        });
      }
      if (method === "POST" && path === "/repos/acme/app/git/blobs") {
        return Response.json({ sha: remote(["hash-object", "-w", "--stdin", "--no-filters"], Buffer.from(body.content, "base64")) }, { status: 201 });
      }
      if (method === "POST" && path === "/repos/acme/app/git/trees") {
        const index = { GIT_INDEX_FILE: scenario.scratch + "/index-" + indexes++ };
        remote(["read-tree", body.base_tree], undefined, index);
        const removed = "0 " + "0".repeat(40);
        const indexInfo = body.tree.map((entry) => (entry.sha === null ? removed : entry.mode + " " + entry.sha) + "\\t" + entry.path + "\\0").join("");
        remote(["update-index", "-z", "--index-info"], Buffer.from(indexInfo), index);
        return Response.json({ sha: remote(["write-tree"], undefined, index) }, { status: 201 });
      }
      if (method === "POST" && path === "/repos/acme/app/git/commits") {
        const parents = body.parents.flatMap((parent) => ["-p", parent]);
        return Response.json({ sha: remote(["commit-tree", body.tree, ...parents, "-m", body.message], undefined, identity) }, { status: 201 });
      }
      if (method === "PATCH" && path === "/repos/acme/app/git/refs/heads/topic") {
        const current = remote(["rev-parse", "refs/heads/topic"]);
        const fastForward = Bun.spawnSync(["git", "--git-dir", scenario.remote, "merge-base", "--is-ancestor", current, body.sha]).success;
        if (!fastForward && body.force !== true) return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
        remote(["update-ref", "refs/heads/topic", body.sha, current]);
        return Response.json({ object: { sha: body.sha } });
      }
      throw new Error("Unexpected request: " + method + " " + path);
    };

    const editor = await conflictMergeFromGitDir(scenario.mirror, "refs/heads/main", "refs/heads/topic", { head: "topic", base: "main" });
    if (scenario.headMovesFirst) {
      const moved = remote(["commit-tree", "refs/heads/topic^{tree}", "-p", "refs/heads/topic", "-m", "pushed meanwhile"], undefined, identity);
      remote(["update-ref", "refs/heads/topic", moved]);
    }
    const resolutions = editor.files.map((file) => ({ path: file.path, content: scenario.resolution }));
    const built = await resolvedMergeFromGitDir(scenario.mirror, editor.baseSha, editor.headSha, resolutions);
    let result = null;
    let error = null;
    try {
      result = await commitPrMerge({ repo: "acme/app", number: 7, expectedHeadOid: editor.headSha, baseOid: editor.baseSha, ...built.merge });
    } catch (caught) {
      error = { name: caught.name, message: caught.message };
    }
    const uploads = built.merge.entries.filter((entry) => entry.content).map((entry) => entry.path).sort();
    console.log(JSON.stringify({ editor, uploads, result, error }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...Bun.env, COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: "", COCKPIT_DATA_DIR: scenario.scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as {
    editor: { headSha: string; baseSha: string; files: Array<{ path: string; content?: string; unsupported?: string }> };
    uploads: string[];
    result: { commitOid: string } | null;
    error: { name: string; message: string } | null;
  };
}

describe("conflict merge commit", () => {
  test("lands a merge commit with both parents, the resolution, and everything Git merged on its own", async () => {
    const { root, mirror, remote } = await conflictingRepository();
    const head = git(remote, "rev-parse", "refs/heads/topic");
    const base = git(remote, "rev-parse", "refs/heads/main");

    const { editor, uploads, result, error } = await resolveAndCommit({ mirror, remote, scratch: root, resolution: resolvedNavigation });

    expect(error).toBeNull();
    expect(editor).toMatchObject({ headSha: head, baseSha: base });
    expect(editor.files).toEqual([{
      path: "navigation.ts",
      content: "<<<<<<< topic\nexport const route = 'settings';\n=======\nexport const route = 'inbox';\n>>>>>>> main\n",
    }]);
    // GitHub already holds topic-only.ts from the head; only blobs neither side has are uploaded.
    expect(uploads).toEqual(["navigation.ts", "shared.ts"]);

    const commit = result!.commitOid;
    expect(git(remote, "rev-parse", "refs/heads/topic")).toBe(commit);
    expect(git(remote, "rev-list", "--parents", "-n", "1", commit).split(" ")).toEqual([commit, head, base]);
    expect(git(remote, "log", "-1", "--format=%B", commit)).toBe("Merge branch 'main' into topic");
    expect(git(remote, "show", `${commit}:navigation.ts`)).toBe(resolvedNavigation.trim());
    const shared = git(remote, "show", `${commit}:shared.ts`);
    expect(shared).toContain("line 2 from topic");
    expect(shared).toContain("line 11 from main");
    expect(git(remote, "ls-tree", "--name-only", commit).split("\n")).toEqual(["base-only.ts", "navigation.ts", "shared.ts", "topic-only.ts"]);
  });

  test("rejects the commit when the head moved after the editor loaded", async () => {
    const { root, mirror, remote } = await conflictingRepository();

    const { result, error } = await resolveAndCommit({ mirror, remote, scratch: root, resolution: resolvedNavigation, headMovesFirst: true });

    expect(result).toBeNull();
    expect(error).toEqual({ name: "StalePrHeadError", message: "PR head changed; reload before committing" });
    expect(git(remote, "log", "-1", "--format=%s", "refs/heads/topic")).toBe("pushed meanwhile");
  });
});
