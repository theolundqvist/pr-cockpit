import { describe, expect, test } from "bun:test";

// The child imports after COCKPIT_MOCK is set, keeping token lookup out of the user's GitHub session.
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const repo = "base-owner/base-repo";
const number = 42;
const path = "src/value.ts";
const message = "Edit value";
const commitOid = "c".repeat(40);

type CommitInput = {
  branch: { repositoryNameWithOwner: string; branchName: string };
  message: { headline: string };
  fileChanges: { additions: { path: string; contents: string }[] };
  expectedHeadOid: string;
};

type GraphqlCall = {
  variables: {
    owner?: string;
    name?: string;
    number?: number;
    fileExpression?: string;
    parentExpression?: string;
    input?: CommitInput;
  };
};

type HeadFile = { __typename: string; isBinary?: boolean | null } | null;

type HeadParent = {
  __typename: string;
  entries?: Array<{ name: string; type: string; mode: number }> | null;
} | null;

type FileEditScenario = {
  expectedHeadOid: string;
  headOid: string;
  content: string;
  file: HeadFile;
  parent: HeadParent;
  mutationRace?: boolean;
};

type FileEditResult = {
  result?: { commitOid: string };
  error?: { name: string; message: string };
  calls: GraphqlCall[];
};

const editableFile: HeadFile = { __typename: "Blob", isBinary: false };
const editableParent: HeadParent = {
  __typename: "Tree",
  entries: [{ name: "value.ts", type: "blob", mode: 0o100644 }],
};

async function runFileEditScenario(scenario: FileEditScenario): Promise<FileEditResult> {
  const script = `
    const { commitPrFileEdit } = await import(${JSON.stringify(githubModuleUrl)});
    const scenario = ${JSON.stringify(scenario)};
    const calls = [];
    globalThis.fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init.body)));
      if (calls.length === 1) {
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefName: "feature/edit-value",
                headRefOid: scenario.headOid,
                headRepository: {
                  nameWithOwner: "fork-owner/fork-repo",
                  file: scenario.file,
                  parent: scenario.parent,
                },
              },
            },
          },
        });
      }
      if (scenario.mutationRace) {
        return Response.json({
          data: { createCommitOnBranch: null },
          errors: [{
            type: "STALE_DATA",
            path: ["createCommitOnBranch"],
            message: "Expected branch to point to " + JSON.stringify(scenario.headOid) + " but it did not. Pull and try again.",
          }],
        });
      }
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: ${JSON.stringify(commitOid)} } } } });
    };
    try {
      const result = await commitPrFileEdit({
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
  test("targets the fork head and preserves a trailing newline", async () => {
    const expectedHeadOid = "a".repeat(40);
    const content = "export const value = 42;\n";
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      file: editableFile,
      parent: editableParent,
      content,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ commitOid });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]!.variables).toEqual({
      owner: "base-owner",
      name: "base-repo",
      number,
      fileExpression: `${expectedHeadOid}:${path}`,
      parentExpression: `${expectedHeadOid}:src`,
    });

    const input = result.calls[1]!.variables.input!;
    expect(input.branch).toEqual({
      repositoryNameWithOwner: "fork-owner/fork-repo",
      branchName: "feature/edit-value",
    });
    expect(input.message).toEqual({ headline: message });
    expect(input.expectedHeadOid).toBe(expectedHeadOid);
    expect(input.fileChanges.additions).toEqual([{
      path,
      contents: Buffer.from(content).toString("base64"),
    }]);
    expect(Buffer.from(input.fileChanges.additions[0]!.contents, "base64").toString("utf8")).toBe(content);
  });

  test("normalizes an uppercase expected head before preflight and mutation", async () => {
    const expectedHeadOid = "A".repeat(40);
    const normalizedHeadOid = expectedHeadOid.toLowerCase();
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: normalizedHeadOid,
      file: editableFile,
      parent: editableParent,
      content: "export const value = 42;\n",
    });

    expect(result.result).toEqual({ commitOid });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]!.variables.fileExpression).toBe(`${normalizedHeadOid}:${path}`);
    expect(result.calls[0]!.variables.parentExpression).toBe(`${normalizedHeadOid}:src`);
    expect(result.calls[1]!.variables.input!.expectedHeadOid).toBe(normalizedHeadOid);
  });

  test("writes an empty full replacement", async () => {
    const expectedHeadOid = "a".repeat(40);
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      file: editableFile,
      parent: editableParent,
      content: "",
    });

    expect(result.result).toEqual({ commitOid });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1]!.variables.input!.fileChanges.additions).toEqual([{ path, contents: "" }]);
  });

  test("classifies a mutation-time stale race", async () => {
    const expectedHeadOid = "a".repeat(40);
    const result = await runFileEditScenario({
      expectedHeadOid,
      headOid: expectedHeadOid,
      file: editableFile,
      parent: editableParent,
      content: "export const value = 42;\n",
      mutationRace: true,
    });

    expect(result.result).toBeUndefined();
    expect(result.error?.name).toBe("StalePrHeadError");
    expect(result.calls).toHaveLength(2);
  });

  test("does not send a mutation when preflight finds a stale head", async () => {
    const result = await runFileEditScenario({
      expectedHeadOid: "a".repeat(40),
      headOid: "b".repeat(40),
      file: editableFile,
      parent: editableParent,
      content: "export const value = 42;\n",
    });

    expect(result.result).toBeUndefined();
    expect(result.error?.name).toBe("StalePrHeadError");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.variables).toEqual({
      owner: "base-owner",
      name: "base-repo",
      number,
      fileExpression: `${"a".repeat(40)}:${path}`,
      parentExpression: `${"a".repeat(40)}:src`,
    });
  });
  const nonEditableTargets: { description: string; file: HeadFile; parent: HeadParent }[] = [
    { description: "a missing file", file: null, parent: editableParent },
    { description: "a directory file object", file: { __typename: "Tree" }, parent: editableParent },
    { description: "a binary blob", file: { __typename: "Blob", isBinary: true }, parent: editableParent },
    {
      description: "an executable entry",
      file: editableFile,
      parent: { __typename: "Tree", entries: [{ name: "value.ts", type: "blob", mode: 0o100755 }] },
    },
    {
      description: "a symlink entry",
      file: editableFile,
      parent: { __typename: "Tree", entries: [{ name: "value.ts", type: "blob", mode: 0o120000 }] },
    },
    {
      description: "a wrong entry type",
      file: editableFile,
      parent: { __typename: "Tree", entries: [{ name: "value.ts", type: "tree", mode: 0o040000 }] },
    },
    {
      description: "an entry for another path",
      file: editableFile,
      parent: { __typename: "Tree", entries: [{ name: "other.ts", type: "blob", mode: 0o100644 }] },
    },
    { description: "a missing parent entry", file: editableFile, parent: { __typename: "Tree", entries: [] } },
  ];

  for (const { description, file, parent } of nonEditableTargets) {
    test(`does not mutate ${description}`, async () => {
      const expectedHeadOid = "a".repeat(40);
      const result = await runFileEditScenario({
        expectedHeadOid,
        headOid: expectedHeadOid,
        file,
        parent,
        content: "export const value = 42;\n",
      });

      expect(result.result).toBeUndefined();
      expect(result.error).toEqual({
        name: "StalePrHeadError",
        message: "PR file is no longer editable",
      });
      expect(result.calls).toHaveLength(1);
    });
  }
});
