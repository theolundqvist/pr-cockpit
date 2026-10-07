import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedAttributeLine } from "./github.ts";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const repo = "base-owner/base-repo";
const number = 42;
const path = "src/value.ts";
const message = "Edit value";
const commitOid = "c".repeat(40);

type RestCall = {
  method: string;
  url: string;
  body?: Record<string, unknown>;
};

type FileTarget = {
  type: string;
  mode: string;
} | null;

type FileEditScenario = {
  expectedHeadOid: string;
  headOid: string;
  content: string;
  target: FileTarget;
  currentContent?: string;
  refRace?: boolean;
  // Marks this pattern generated instead of editing `path`; `attributes` is the head's .gitattributes.
  pattern?: string;
  attributes?: string;
};

type FileEditResult = {
  result?: { commitOid: string | null };
  error?: { name: string; message: string };
  calls: RestCall[];
};

const editableTarget: FileTarget = { type: "blob", mode: "100644" };

async function runFileEditScenario(scenario: FileEditScenario): Promise<FileEditResult> {
  const script = `
    const { commitPrFileEdit, markPrPathGenerated } = await import(${JSON.stringify(githubModuleUrl)});
    const scenario = ${JSON.stringify(scenario)};
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const pathname = new URL(url).pathname;

      if (method === "GET" && pathname.endsWith("/pulls/${number}")) {
        return Response.json({
          state: "open",
          head: {
            sha: scenario.headOid,
            ref: "feature/edit-value",
            repo: { full_name: "fork-owner/fork-repo" },
          },
        });
      }
      if (method === "GET" && pathname.includes("/git/commits/")) {
        return Response.json({ tree: { sha: "root-tree" } });
      }
      if (method === "GET" && pathname.endsWith("/git/trees/root-tree")) {
        return Response.json({
          tree: [
            { path: "src", type: "tree", mode: "040000", sha: "src-tree" },
            ...(scenario.attributes === undefined ? [] : [{ path: ".gitattributes", type: "blob", mode: "100644", sha: "attributes-blob" }]),
          ],
        });
      }
      if (method === "GET" && pathname.endsWith("/git/blobs/attributes-blob")) {
        return Response.json({ content: Buffer.from(scenario.attributes).toString("base64"), encoding: "base64" });
      }
      if (method === "GET" && pathname.endsWith("/git/trees/src-tree")) {
        return Response.json({
          tree: scenario.target
            ? [{ path: "value.ts", ...scenario.target, sha: "original-blob" }]
            : [],
        });
      }
      if (method === "GET" && pathname.endsWith("/git/blobs/original-blob")) {
        return Response.json({
          content: Buffer.from(scenario.currentContent ?? "export const value = 1;\\n").toString("base64"),
          encoding: "base64",
        });
      }
      if (method === "POST" && pathname.endsWith("/git/blobs")) {
        return Response.json({ sha: "new-blob" });
      }
      if (method === "POST" && pathname.endsWith("/git/trees")) {
        return Response.json({ sha: "new-tree" });
      }
      if (method === "POST" && pathname.endsWith("/git/commits")) {
        return Response.json({ sha: ${JSON.stringify(commitOid)} });
      }
      if (method === "PATCH" && pathname.includes("/git/refs/heads/")) {
        if (scenario.refRace) {
          return Response.json(
            { message: "Update is not a fast forward" },
            { status: 422 },
          );
        }
        return Response.json({ object: { sha: ${JSON.stringify(commitOid)} } });
      }
      throw new Error("Unexpected request: " + method + " " + url);
    };
    try {
      const result = scenario.pattern
        ? await markPrPathGenerated(${JSON.stringify(repo)}, ${number}, scenario.pattern)
        : await commitPrFileEdit({
          repo: ${JSON.stringify(repo)},
          number: ${number},
          path: ${JSON.stringify(path)},
          expectedHeadOid: scenario.expectedHeadOid,
          content: scenario.content,
          message: ${JSON.stringify(message)},
        });
      console.log(JSON.stringify({ result, calls }));
    } catch (error) {
      console.log(JSON.stringify({
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        calls,
      }));
    }
  `;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout) as FileEditResult;
}

describe("commitPrFileEdit", () => {
  test("commits to the fork head through REST and preserves a trailing newline", async () => {
    const expectedHeadOid = "a".repeat(40);
    const content = "export const value = 42;\n";
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      target: editableTarget,
      content,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ commitOid });
    expect(result.calls).toHaveLength(9);
    expect(result.calls[0]).toMatchObject({
      method: "GET",
      url: `https://api.github.com/repos/base-owner/base-repo/pulls/${number}`,
    });
    expect(result.calls[1]!.url).toBe(
      `https://api.github.com/repos/fork-owner/fork-repo/git/commits/${expectedHeadOid}`,
    );
    expect(result.calls[5]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/fork-owner/fork-repo/git/blobs",
      body: {
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      },
    });
    expect(result.calls[6]!.body).toEqual({
      base_tree: "root-tree",
      tree: [{ path, mode: "100644", type: "blob", sha: "new-blob" }],
    });
    expect(result.calls[7]!.body).toEqual({
      message,
      tree: "new-tree",
      parents: [expectedHeadOid],
    });
    expect(result.calls[8]).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/fork-owner/fork-repo/git/refs/heads/feature/edit-value",
      body: { sha: commitOid, force: false },
    });
  });

  test("normalizes an uppercase expected head before REST preflight and commit", async () => {
    const expectedHeadOid = "A".repeat(40);
    const normalizedHeadOid = expectedHeadOid.toLowerCase();
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: normalizedHeadOid,
      target: editableTarget,
      content: "export const value = 42;\n",
    });

    expect(result.result).toEqual({ commitOid });
    expect(result.calls[1]!.url).toEndWith(`/git/commits/${normalizedHeadOid}`);
    expect(result.calls[7]!.body!.parents).toEqual([normalizedHeadOid]);
  });

  test("writes an empty full replacement", async () => {
    const expectedHeadOid = "a".repeat(40);
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      target: editableTarget,
      content: "",
    });

    expect(result.result).toEqual({ commitOid });
    expect(result.calls[5]!.body).toEqual({ content: "", encoding: "base64" });
  });

  test("classifies a non-fast-forward ref update as a stale race", async () => {
    const expectedHeadOid = "a".repeat(40);
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      target: editableTarget,
      content: "export const value = 42;\n",
      refRace: true,
    });

    expect(result.result).toBeUndefined();
    expect(result.error?.name).toBe("StalePrHeadError");
    expect(result.calls).toHaveLength(9);
  });

  test("does not create Git objects when preflight finds a stale head", async () => {
    const result = await runFileEditScenario({
      expectedHeadOid: "a".repeat(40),
      headOid: "b".repeat(40),
      target: editableTarget,
      content: "export const value = 42;\n",
    });

    expect(result.result).toBeUndefined();
    expect(result.error?.name).toBe("StalePrHeadError");
    expect(result.calls).toHaveLength(1);
  });

  for (const { description, target } of [
    { description: "a missing file", target: null },
    { description: "a directory", target: { type: "tree", mode: "040000" } },
    { description: "an executable", target: { type: "blob", mode: "100755" } },
    { description: "a symlink", target: { type: "blob", mode: "120000" } },
  ] satisfies Array<{ description: string; target: FileTarget }>) {
    test(`does not mutate ${description}`, async () => {
      const expectedHeadOid = "a".repeat(40);
      const result = await runFileEditScenario({
        expectedHeadOid,
        headOid: expectedHeadOid,
        target,
        content: "export const value = 42;\n",
      });

      expect(result.result).toBeUndefined();
      expect(result.error).toEqual({
        name: "StalePrHeadError",
        message: "PR file is no longer editable",
      });
      expect(result.calls).toHaveLength(4);
    });
  }

  test("does not mutate binary content", async () => {
    const expectedHeadOid = "a".repeat(40);
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      target: editableTarget,
      currentContent: "\0binary",
      content: "replacement",
    });

    expect(result.result).toBeUndefined();
    expect(result.error).toEqual({
      name: "StalePrHeadError",
      message: "PR file is no longer editable",
    });
    expect(result.calls).toHaveLength(5);
  });
});

describe("markPrPathGenerated", () => {
  const headOid = "a".repeat(40);
  const mark = (pattern: string, attributes?: string) =>
    runFileEditScenario({ expectedHeadOid: headOid, headOid, target: editableTarget, content: "", pattern, attributes });
  const written = (result: FileEditResult) =>
    Buffer.from(String(result.calls.find((call) => call.url.endsWith("/git/blobs") && call.method === "POST")?.body?.content), "base64").toString();

  test("creates .gitattributes on the current head when the PR has none", async () => {
    const result = await mark("ui/generated/**");

    expect(result.result).toEqual({ commitOid });
    expect(written(result)).toBe("ui/generated/** linguist-generated=true\n");
    expect(result.calls.find((call) => call.url.endsWith("/git/trees") && call.method === "POST")?.body).toEqual({
      base_tree: "root-tree",
      tree: [{ path: ".gitattributes", mode: "100644", type: "blob", sha: "new-blob" }],
    });
    expect(result.calls.find((call) => call.url.endsWith("/git/commits") && call.method === "POST")?.body).toMatchObject({
      message: "chore: mark ui/generated/** as generated",
      parents: [headOid],
    });
  });

  test("appends to existing attributes, adding a missing final newline", async () => {
    const result = await mark("bun.lock", "*.png binary");

    expect(written(result)).toBe("*.png binary\nbun.lock linguist-generated=true\n");
  });

  test("makes no commit when the rule is already present", async () => {
    const result = await mark("bun.lock", "*.png binary\r\nbun.lock linguist-generated=true\r\n");

    expect(result.result).toEqual({ commitOid: null });
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("generatedAttributeLine", () => {
  test("marks exactly the chosen file or folder, however its name reads to Git", async () => {
    const paths = [
      "src/[id].ts", "src/i.ts", "src/d.ts",
      "docs/a b.md", "docs/a",
      "#notes.md", "!bang.md",
      "lib/*star.ts", "lib/xstar.ts",
      "gen api/out.ts", "gen api/deep/out.ts", "gen/out.ts",
      "q\"uote.md",
    ];
    const patterns = ["src/[id].ts", "docs/a b.md", "#notes.md", "!bang.md", "lib/*star.ts", "gen api/**", "q\"uote.md"];
    const dir = mkdtempSync(join(tmpdir(), "cockpit-attributes-"));
    try {
      await Bun.$`git init -q ${dir}`;
      writeFileSync(join(dir, ".gitattributes"), patterns.map((pattern) => `${generatedAttributeLine(pattern)}\n`).join(""));
      const output = await Bun.$`git -C ${dir} check-attr -z --stdin linguist-generated < ${Buffer.from(paths.join("\0"))}`.arrayBuffer();
      const fields = Buffer.from(output).toString().split("\0");
      const generated: string[] = [];
      for (let index = 0; index + 2 < fields.length; index += 3) if (fields[index + 2] === "true") generated.push(fields[index]!);

      expect(generated).toEqual(["src/[id].ts", "docs/a b.md", "#notes.md", "!bang.md", "lib/*star.ts", "gen api/out.ts", "gen api/deep/out.ts", "q\"uote.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
