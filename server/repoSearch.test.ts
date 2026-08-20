import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureShaLocal, findDefinition, grep, localFileHistoryPatch, parseGrepOutput, symbolMentionHistory } from "./repoSearch.ts";
import { lsTree, showFile } from "./gitShow.ts";

const SHA = "a".repeat(40);

function git(root: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed in ${root}`);
  return proc.stdout.toString();
}

describe("parseGrepOutput", () => {
  test("parses path, line and text", () => {
    const out = parseGrepOutput(`${SHA}:src/app.ts:12:const x = 1;`, SHA);
    expect(out).toEqual([{ path: "src/app.ts", line: 12, text: "const x = 1;" }]);
  });

  test("keeps colons that appear inside the matched text", () => {
    const out = parseGrepOutput(`${SHA}:a.ts:3:foo: bar: baz`, SHA);
    expect(out[0]).toEqual({ path: "a.ts", line: 3, text: "foo: bar: baz" });
  });

  test("ignores lines without the sha prefix", () => {
    const out = parseGrepOutput(`noise\n${SHA}:a.ts:1:1:hit\n`, SHA);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("a.ts");
  });

  test("returns empty for no matches", () => {
    expect(parseGrepOutput("", SHA)).toEqual([]);
  });
});

describe("grep / lsTree / showFile against a real repo", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function makeRepo(): { root: string; sha: string } {
    const root = mkdtempSync(join(tmpdir(), "repo-search-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "export function Widget() { return 1; }\nconst other = 2;\n");
    writeFileSync(join(root, "README.md"), "widget docs\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    return { root, sha };
  }

  test("grep is case-insensitive for a lowercase query (smart-case)", async () => {
    const { root, sha } = makeRepo();
    const hits = await grep(root, sha, "widget");
    const paths = hits.map((h) => h.path).sort();
    expect(paths).toEqual(["README.md", "src/app.ts"]);
    expect(hits.find((h) => h.path === "src/app.ts")!.line).toBe(1);
  });

  test("grep is case-sensitive when the query has an uppercase letter", async () => {
    const { root, sha } = makeRepo();
    const hits = await grep(root, sha, "Widget");
    expect(hits.map((h) => h.path)).toEqual(["src/app.ts"]);
  });

  test("grep with an already-aborted signal returns without throwing", async () => {
    const { root, sha } = makeRepo();
    const controller = new AbortController();
    controller.abort();
    const hits = await grep(root, sha, "widget", controller.signal);
    expect(Array.isArray(hits)).toBe(true);
  });
  test("findDefinition returns a unique source declaration", async () => {
    const { root, sha } = makeRepo();
    const result = await findDefinition(root, sha, "Widget", "src/consumer.ts");
    expect(result.definition).toEqual({
      path: "src/app.ts",
      line: 1,
      text: "export function Widget() { return 1; }",
      symbol: "Widget",
    });
  });


  test("findDefinition resolves an exact source position through the TypeScript worker", async () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "src/consumer.ts"), 'import { Widget } from "./app";\nWidget();\n');
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "consumer"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();

    const result = await findDefinition(root, sha, "Widget", "src/consumer.ts", undefined, {
      repo: "owner/repo",
      position: { line: 2, character: 0 },
    });

    expect(result.definition).toEqual({
      path: "src/app.ts",
      line: 1,
      text: "export function Widget() { return 1; }",
      symbol: "Widget",
    });
  });
  test("findDefinition follows an aliased relative import with duplicate global symbols", async () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "src/other.ts"), "export function Widget() { return 2; }\n");
    writeFileSync(join(root, "src/consumer.ts"), 'import { Widget as LocalWidget } from "./app";\nLocalWidget();\n');
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "duplicates"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    const result = await findDefinition(root, sha, "LocalWidget", "src/consumer.ts");
    expect(result.definition?.path).toBe("src/app.ts");
  });

  test("findDefinition returns candidates instead of guessing between duplicate symbols", async () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "src/other.ts"), "export function Widget() { return 2; }\n");
    writeFileSync(join(root, "src/consumer.ts"), "Widget();\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "duplicates"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    const result = await findDefinition(root, sha, "Widget", "src/consumer.ts");
    expect(result.definition).toBeNull();
    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual(["src/app.ts", "src/other.ts"]);
  });

  test("findDefinition rejects non-identifiers", async () => {
    const { root, sha } = makeRepo();
    expect(await findDefinition(root, sha, "../Widget", "src/app.ts")).toEqual({ definition: null, candidates: [] });
  });


  test("symbolMentionHistory returns commits whose changed lines mention the identifier", async () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "src/app.ts"), "export function Widget() {\n  return 1;\n}\nconst other = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "make multiline"]);
    writeFileSync(join(root, "src/app.ts"), "export function Widget() {\n  return 2;\n}\nconst other = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "body only"]);
    writeFileSync(join(root, "src/app.ts"), "export function Gadget() {\n  return 2;\n}\nconst other = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "rename Widget"]);
    writeFileSync(join(root, "README.md"), "updated docs\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "docs only"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();

    expect((await symbolMentionHistory(root, sha, "src/app.ts", "Widget")).map((commit) => commit.subject)).toEqual([
      "rename Widget",
      "make multiline",
      "init",
    ]);
  });
  test("symbolMentionHistory surfaces git failures", async () => {
    const { root } = makeRepo();
    await expect(symbolMentionHistory(root, "0".repeat(40), "src/app.ts", "Widget")).rejects.toThrow("git log failed");
  });


  test("localFileHistoryPatch returns a complete diff from the checkout", async () => {
    const { root } = makeRepo();
    writeFileSync(join(root, "src/app.ts"), "export function Gadget() { return 1; }\nconst other = 2;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "rename Widget"]);
    const sha = git(root, ["rev-parse", "HEAD"]).trim();

    const patch = await localFileHistoryPatch(root, sha, "src/app.ts");
    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).toContain("-export function Widget()");
    expect(patch).toContain("+export function Gadget()");
  });

  test("ensureShaLocal surfaces failed fetches, retries, and caches a successful miss", async () => {
    const { root } = makeRepo();
    const missingSha = "0".repeat(40);
    const repo = `test/retry-${Date.now()}`;
    let fetchCount = 0;
    const fetch = () => ({ exited: Promise.resolve(++fetchCount === 1 ? 1 : 0) });

    expect(ensureShaLocal(root, repo, "main", missingSha, fetch)).toBe("fetching");
    expect(ensureShaLocal(root, repo, "main", missingSha, fetch)).toBe("fetching");
    expect(fetchCount).toBe(1);
    await Bun.sleep(0);

    expect(ensureShaLocal(root, repo, "main", missingSha, fetch)).toBe("fetch-failed");
    expect(ensureShaLocal(root, repo, "main", missingSha, fetch)).toBe("fetching");
    expect(fetchCount).toBe(2);
    await Bun.sleep(0);
    expect(ensureShaLocal(root, repo, "main", missingSha, fetch)).toBe("not-found");
  });

  test("ensureShaLocal does not poison the sha when spawning fetch throws", () => {
    const { root } = makeRepo();
    const missingSha = "0".repeat(40);
    const repo = `test/spawn-${Date.now()}`;
    expect(() =>
      ensureShaLocal(root, repo, "main", missingSha, () => {
        throw new Error("spawn failed");
      })
    ).toThrow("spawn failed");

    let fetchCount = 0;
    expect(ensureShaLocal(root, repo, "main", missingSha, () => {
      fetchCount += 1;
      return { exited: Promise.resolve(0) };
    })).toBe("fetching");
    expect(fetchCount).toBe(1);
  });

  test("lsTree lists every tracked path at the sha", () => {
    const { root, sha } = makeRepo();
    expect(lsTree(root, "o/r", sha).sort()).toEqual(["README.md", "src/app.ts"]);
  });

  test("showFile returns file contents at the sha, null for a missing path", () => {
    const { root, sha } = makeRepo();
    expect(showFile(root, sha, "README.md")).toBe("widget docs\n");
    expect(showFile(root, sha, "nope.txt")).toBeNull();
  });
});
