import { expect, test } from "bun:test";

// Install the isolated transport before module evaluation; db must load first to break the settings cycle.
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const dbModuleUrl = new URL("./db.ts", import.meta.url).href;

test("repository open PR listing completes more than 100 results and rejects incomplete pages", async () => {
  const script = `
    const requests = [];
    let mode = "complete";
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(init.body);
      requests.push(request.variables);
      if (mode === "missing") return Response.json({ data: { repository: null } });
      if (mode === "failure" && request.variables.cursor) {
        return Response.json({ errors: [{ type: "RATE_LIMITED", message: "quota exhausted" }] });
      }
      const offset = request.variables.cursor ? 100 : 0;
      const nodes = Array.from({ length: offset ? 3 : 100 }, (_, i) => ({
        number: offset + i + 1, title: "Pull request " + (offset + i + 1),
        author: i === 0 ? null : { login: "unrelated-contributor" },
        isDraft: i === 1, updatedAt: "2026-09-01T00:00:00Z",
      }));
      if (mode === "overlap" && offset) nodes.push({
        number: 1, title: "Updated during pagination", author: { login: "unrelated-contributor" },
        isDraft: false, updatedAt: "2026-09-02T00:00:00Z",
      });
      return Response.json({ data: { repository: { pullRequests: {
        nodes,
        pageInfo: {
          hasNextPage: mode === "repeat" || !offset,
          endCursor: mode === "cursor" ? null : "next-page",
        },
      } } } });
    };
    await import(${JSON.stringify(dbModuleUrl)});
    const { fetchRepositoryOpenPrs, GithubRequestError } = await import(${JSON.stringify(githubModuleUrl)});
    const eagerRequests = requests.length;
    const prs = await fetchRepositoryOpenPrs("acme/widgets");
    const completeRequests = requests.splice(0);
    mode = "overlap";
    const overlapping = await fetchRepositoryOpenPrs("acme/widgets");
    const errors = [];
    for (mode of ["missing", "cursor", "repeat", "failure"]) {
      try {
        await fetchRepositoryOpenPrs("acme/widgets");
        errors.push({ mode, succeeded: true });
      } catch (error) {
        errors.push({ mode, githubError: error instanceof GithubRequestError, status: error.status });
      }
    }
    console.log(JSON.stringify({ eagerRequests, prs, completeRequests, overlapping, errors }));
  `;
  const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_GH_BIN: "/bin/echo", COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.eagerRequests).toBe(0);
  expect(result.completeRequests).toEqual([
    { owner: "acme", name: "widgets", cursor: null },
    { owner: "acme", name: "widgets", cursor: "next-page" },
  ]);
  expect(result.prs.map((pr: { number: number }) => pr.number)).toEqual(Array.from({ length: 103 }, (_, i) => i + 1));
  expect(result.prs[1]).toEqual({
    repo: "acme/widgets", number: 2, title: "Pull request 2", author: "unrelated-contributor",
    state: "OPEN", isDraft: true, updatedAt: "2026-09-01T00:00:00Z",
  });
  expect(result.prs[0].author).toBe("unknown");
  expect(result.overlapping.map((pr: { number: number }) => pr.number)).toEqual(Array.from({ length: 103 }, (_, i) => i + 1));
  expect(result.overlapping[0].title).toBe("Updated during pagination");
  expect(result.errors).toEqual([
    { mode: "missing", githubError: true, status: 404 },
    { mode: "cursor", githubError: true, status: 502 },
    { mode: "repeat", githubError: true, status: 502 },
    { mode: "failure", githubError: true, status: 502 },
  ]);
});

test("mock repository listing includes open fixtures without network access", async () => {
  const script = `
    globalThis.fetch = async () => { throw new Error("unexpected network request"); };
    await import(${JSON.stringify(dbModuleUrl)});
    const { fetchRepositoryOpenPrs } = await import(${JSON.stringify(githubModuleUrl)});
    const prs = await fetchRepositoryOpenPrs("fixture/cockpit");
    console.log(JSON.stringify(prs));
  `;
  const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_MOCK: "1", COCKPIT_MOCK_DATA: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  const prs = JSON.parse(stdout);
  expect(prs.find((pr: { number: number }) => pr.number === 102)).toMatchObject({ repo: "fixture/cockpit", state: "OPEN" });
  expect(prs.find((pr: { number: number }) => pr.number === 106)).toBeUndefined();
});
