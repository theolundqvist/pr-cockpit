import { expect, test } from "bun:test";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;

test("posts single-line and ranged inline comments with GitHub's REST fields", async () => {
  // Import in a child with a fake GitHub CLI so the test never reads the user's token.
  const script = `
    const { postInlineComment } = await import(${JSON.stringify(githubModuleUrl)});
    const calls = [];
    globalThis.fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 201 });
    };
    await postInlineComment("owner/repo", 42, "head-sha", {
      path: "src/value.ts",
      line: 8,
      side: "RIGHT",
      body: "single",
    });
    await postInlineComment("owner/repo", 42, "head-sha", {
      path: "src/value.ts",
      line: 13,
      side: "RIGHT",
      startLine: 9,
      startSide: "RIGHT",
      body: "range",
    });
    console.log(JSON.stringify(calls));
  `;
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_GH_BIN: "/bin/echo", COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);

  expect(JSON.parse(stdout)).toEqual([
    {
      body: "single",
      commit_id: "head-sha",
      path: "src/value.ts",
      line: 8,
      side: "RIGHT",
    },
    {
      body: "range",
      commit_id: "head-sha",
      path: "src/value.ts",
      line: 13,
      side: "RIGHT",
      start_line: 9,
      start_side: "RIGHT",
    },
  ]);
});
