import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prewarmCodeSearch, searchCodeSnippets } from "./codeSearch.ts";

function git(root: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

const LONG_MATCH = "z".repeat(450);
const SNAPSHOT = "fixture/snapshot";
const GIT_ONLY = "fixture/git-only";

describe("code search snapshots against a real repo", () => {
  let root = "";
  let current = "";
  let changed = "";
  let consoleError: Mock<typeof console.error>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "code-search-"));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    const files: Record<string, string> = {
      "src/app.ts": "export function Widget() { return 1; }\nconst other = 2;\n",
      "README.md": "widget docs\n",
      "crlf.txt": "widget crlf\r\nnext\r\n",
      "binary.bin": "widget\0binary\n",
      "late-nul.txt": `widget early\n${"x".repeat(9000)}\0 widget late\n`,
      "forced.txt": "widget forced binary by attributes\n",
      ".gitattributes": "forced.txt -diff\n",
      "kelvin.txt": "\u212Aelvin unit\nlong \u017Ftring\n",
      "bom.txt": "\uFEFFwidget bom\n",
      "cafe.txt": "café Widget\nCAFÉ upper\n",
      "dist/min.js": `${"a".repeat(5000)}needleWidget${"b".repeat(5000)}\n`,
      "long.txt": `start ${LONG_MATCH} end\n`,
    };
    for (const [path, content] of Object.entries(files)) {
      Bun.spawnSync(["mkdir", "-p", join(root, path, "..")]);
      writeFileSync(join(root, path), content);
    }
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "current"]);
    current = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, "README.md"), "widget docs v2\nnew Widget line\n");
    rmSync(join(root, "crlf.txt"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "changed"]);
    changed = git(root, ["rev-parse", "HEAD"]).trim();

    consoleError = spyOn(console, "error").mockImplementation(() => {});
    for (const sha of [current, changed]) {
      await prewarmCodeSearch(join(root, "missing-checkout"), GIT_ONLY, sha);
      await prewarmCodeSearch(root, SNAPSHOT, sha);
    }
  });

  afterAll(() => {
    consoleError.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  test("snapshot results equal git grep for case, Unicode, binary, CRLF, BOM and long-line queries", async () => {
    const queries = ["widget", "Widget", "WIDGET", "kelvin", "string", "café", "CAFÉ", "needleWidget", LONG_MATCH, "late", "zzabsent", "a.b", "absent\nneedleWidget"];
    for (const sha of [current, changed]) {
      for (const query of queries) {
        const fromSnapshot = await searchCodeSnippets(root, SNAPSHOT, sha, query);
        const fromGit = await searchCodeSnippets(root, GIT_ONLY, sha, query);
        expect({ sha, query, matches: fromSnapshot }).toEqual({ sha, query, matches: fromGit });
      }
    }
  });

  test("each commit answers from its own tree, with Git's binary and line decisions", async () => {
    const at = async (sha: string) => (await searchCodeSnippets(root, SNAPSHOT, sha, "widget")).map((m) => `${m.path}:${m.line}`);
    expect(await at(current)).toEqual(["README.md:1", "bom.txt:1", "cafe.txt:1", "crlf.txt:1", "dist/min.js:1", "late-nul.txt:1", "late-nul.txt:2", "src/app.ts:1"]);
    expect(await at(changed)).toEqual(["README.md:1", "README.md:2", "bom.txt:1", "cafe.txt:1", "dist/min.js:1", "late-nul.txt:1", "late-nul.txt:2", "src/app.ts:1"]);
    const crlf = (await searchCodeSnippets(root, SNAPSHOT, current, "crlf")).find((m) => m.path === "crlf.txt");
    expect(crlf?.text).toBe("widget crlf\r");
  });

  test("result text is a bounded snippet that keeps the whole first match", async () => {
    const [minified] = await searchCodeSnippets(root, SNAPSHOT, current, "needleWidget");
    expect(minified!.text.length).toBeLessThanOrEqual(402);
    expect(minified!.text.startsWith("…")).toBe(true);
    expect(minified!.text.endsWith("…")).toBe(true);
    expect(minified!.text).toContain("needleWidget");
    const [multiline] = await searchCodeSnippets(root, SNAPSHOT, current, "absent\nneedleWidget");
    expect(multiline!.text).toContain("needleWidget");
    const [long] = await searchCodeSnippets(root, SNAPSHOT, current, LONG_MATCH);
    expect(long!.text).toContain(LONG_MATCH);
    expect(long!.text.length).toBeLessThanOrEqual(LONG_MATCH.length + 82);
  });

  test("an aborted query returns nothing on both the snapshot and git paths", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await searchCodeSnippets(root, SNAPSHOT, current, "widget", controller.signal)).toEqual([]);
    expect(await searchCodeSnippets(root, GIT_ONLY, current, "widget", controller.signal)).toEqual([]);
  });
});
