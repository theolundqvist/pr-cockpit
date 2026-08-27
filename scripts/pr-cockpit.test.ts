import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("listen ignores volatile metadata and transient failures, then exits on a cached PR update", async () => {
  let version = 1;
  let reads = 0;
  let resolveTransientRead!: () => void;
  const transientRead = new Promise<void>((resolve) => {
    resolveTransientRead = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.searchParams.get("format") === "json") {
        reads += 1;
        if (reads === 3) return new Response("temporary failure", { status: 503 });
        if (reads === 4) {
          resolveTransientRead();
          return new Response("malformed");
        }
        return Response.json({
          title: `version ${version}`,
          snapshot: { fetchedAt: String(reads), freshness: "recent" },
          quota: { fetchedAt: String(reads) },
          newCommentsSince: String(reads),
        });
      }
      return new Response(`version ${version}\n`);
    },
  });

  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen", "owner/repo#1"], {
    env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await transientRead;
    expect(process.exitCode).toBeNull();
    version = 2;
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(error).toBe("");
    expect(exitCode).toBe(0);
    expect(output).toBe("version 2\n");
  } finally {
    process.kill();
    server.stop(true);
  }
});

test("listen fails when its initial cached baseline is unavailable", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: "unavailable" }, { status: 503 });
    },
  });
  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen", "owner/repo#1"], {
    env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const [, , exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).not.toBe(0);
  } finally {
    process.kill();
    server.stop(true);
  }
});

test("listen without a ref watches live cached details for the current repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-listen-"));
  const init = Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  expect(init.success).toBe(true);
  const remote = Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "git@github.com:owner/repo.git"]);
  expect(remote.success).toBe(true);

  let version = 1;
  let detailReads = 0;
  let indexReads = 0;
  let resolveTransientIndex!: () => void;
  const transientIndex = new Promise<void>((resolve) => {
    resolveTransientIndex = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/pr-details") {
        detailReads += 1;
        return Response.json({ details: { "owner/repo#1": { reviewDecision: `version ${version}` } } });
      }
      indexReads += 1;
      if (indexReads === 3) {
        resolveTransientIndex();
        return Response.json({ error: "temporary failure" }, { status: 503 });
      }
      return Response.json({
        prs: [{ repo: "owner/repo", number: 1, state: "open", title: "stable", author: "theo", updatedAt: "1" }],
      });
    },
  });
  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen"], {
    cwd: root,
    env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await transientIndex;
    expect(process.exitCode).toBeNull();
    version = 2;
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(error).toBe("");
    expect(exitCode).toBe(0);
    expect(output).toContain("# Pull Requests in owner/repo");
    expect(output).toContain("stable");
    expect(detailReads).toBeGreaterThanOrEqual(3);
    expect(indexReads).toBeGreaterThanOrEqual(4);
  } finally {
    process.kill();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("current-repository forms explain how to provide an explicit PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-no-repo-"));
  try {
    for (const args of [["listen"], ["pr://1"]]) {
      const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), ...args], {
        cwd: root,
        env: { ...Bun.env, HOME: root, COCKPIT_DEFAULT_REPO: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [error, exitCode] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exitCode).toBe(2);
      expect(error).toContain("current repository is unknown");
      expect(error).toContain("use pr://owner/repo/N");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listen returns immediately for current review blockers", async () => {
  const blockers = [
    { ci: { state: "SUCCESS", failed: 0 }, openComments: [{ path: "src/a.ts", comments: [] }] },
    { ci: { state: "FAILURE", failed: 1 }, openComments: [] },
    { ci: { state: "SUCCESS", failed: 0, cancelled: 1 }, openComments: [] },
  ];

  for (const blocker of blockers) {
    let jsonReads = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).searchParams.get("format") === "json") {
          jsonReads += 1;
          return Response.json(blocker);
        }
        return new Response("blocked\n");
      },
    });
    const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen", "owner/repo#1"], {
      env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [output, error, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(error).toBe("");
      expect(output).toBe("blocked\n");
      expect(jsonReads).toBe(1);
    } finally {
      process.kill();
      server.stop(true);
    }
  }
});

test("listen --ci-only ignores comments and unrelated changes, then exits on CI failure", async () => {
  let reads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).searchParams.get("format") === "json") {
        reads += 1;
        const failed = reads >= 4 ? 1 : 0;
        return Response.json({
          title: reads === 1 ? "before" : "after",
          ci: { state: failed ? "FAILURE" : "SUCCESS", failed },
          openComments: [{ path: "src/a.ts", comments: [] }],
        });
      }
      return new Response("ci changed\n");
    },
  });
  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen", "--ci-only", "owner/repo#1"], {
    env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(error).toBe("");
    expect(output).toBe("ci changed\n");
    expect(reads).toBeGreaterThanOrEqual(4);
  } finally {
    process.kill();
    server.stop(true);
  }
});

test("listen --comments-only ignores failed CI and unrelated changes, then exits on comment changes", async () => {
  let reads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).searchParams.get("format") === "json") {
        reads += 1;
        return Response.json({
          title: reads === 1 ? "before" : "after",
          ci: { state: "FAILURE", failed: 1 },
          openComments: reads >= 4 ? [{ path: "src/a.ts", comments: [] }] : [],
          openCommentsComplete: true,
        });
      }
      return new Response("comments changed\n");
    },
  });
  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "listen", "--comments-only", "owner/repo#1"], {
    env: { ...Bun.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.01" },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(error).toBe("");
    expect(output).toBe("comments changed\n");
    expect(reads).toBeGreaterThanOrEqual(4);
  } finally {
    process.kill();
    server.stop(true);
  }
});

test("resolve posts the displayed thread handle", async () => {
  let requestPath = "";
  let requestMethod = "";
  let requestTrustHeader = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestPath = url.pathname;
      requestMethod = request.method;
      requestTrustHeader = request.headers.get("x-pr-cockpit-cli") ?? "";
      return Response.json({ resolved: true, alreadyResolved: false });
    },
  });
  const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), "resolve", "owner/repo#17", "0123456789"], {
    env: { ...Bun.env, COCKPIT_PORT: String(server.port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const [output, error, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(error).toBe("");
    expect(output).toBe('{"resolved":true,"alreadyResolved":false}\n');
    expect(requestMethod).toBe("POST");
    expect(requestPath).toBe("/api/agent/pr/owner/repo/17/threads/0123456789");
    expect(requestTrustHeader).toBe("1");
  } finally {
    server.stop(true);
  }
});

test("resolve rejects PR resource query options", async () => {
  const process = Bun.spawn([
    join(import.meta.dir, "pr-cockpit"),
    "resolve",
    "pr://owner/repo/17?comments=0",
    "0123456789",
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(exitCode).toBe(2);
});


test("jobs and logs activate the lease before their cache-only GET", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      return new Response(url.pathname.endsWith("actions-lease") ? "" : "cached\n");
    },
  });
  try {
    for (const args of [
      ["owner/repo#17", "--jobs"],
      ["owner/repo#17", "--logs"],
    ]) {
      const process = Bun.spawn([join(import.meta.dir, "pr-cockpit"), ...args], {
        env: { ...Bun.env, COCKPIT_PORT: String(server.port) },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(0);
    }
    expect(requests).toEqual([
      { method: "POST", path: "/api/agent/pr/owner/repo/17/actions-lease" },
      { method: "GET", path: "/api/agent/pr/owner/repo/17/jobs" },
      { method: "POST", path: "/api/agent/pr/owner/repo/17/actions-lease" },
      { method: "GET", path: "/api/agent/pr/owner/repo/17/logs" },
    ]);
  } finally {
    server.stop(true);
  }
});

test("cache-run requests one Actions run through the trusted local endpoint", async () => {
  const requests: Array<{ method: string; path: string; trusted: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, trusted: request.headers.get("x-pr-cockpit-cli") });
      return new Response("Actions run 987: fetched\n");
    },
  });
  try {
    const process = Bun.spawn([
      join(import.meta.dir, "pr-cockpit"),
      "cache-run",
      "owner/repo#17",
      "987",
    ], {
      env: { ...Bun.env, COCKPIT_PORT: String(server.port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    expect(await new Response(process.stdout).text()).toBe("Actions run 987: fetched\n");
    expect(requests).toEqual([{
      method: "POST",
      path: "/api/agent/pr/owner/repo/17/runs/987/cache",
      trusted: "1",
    }]);
  } finally {
    server.stop(true);
  }
});

test("update delegates to the running server and waits for the new revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-update-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const command = join(bin, "pr-cockpit");
  const requests: string[] = [];
  mkdirSync(scripts);
  mkdirSync(bin);
  writeFileSync(join(root, "app.ts"), "seed\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@t.t"],
    ["config", "user.name", "t"],
    ["add", "app.ts"],
    ["commit", "-q", "-m", "seed"],
  ]) {
    expect(Bun.spawnSync(["git", "-C", root, ...args]).success).toBe(true);
  }
  const targetRev = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
  let updateStarted = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/version") {
        return Response.json({ updateAvailable: !updateStarted, rev: updateStarted ? targetRev : "old-revision" });
      }
      if (url.pathname === "/api/update" && request.method === "POST") {
        updateStarted = true;
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  copyFileSync(join(import.meta.dir, "pr-cockpit"), join(scripts, "pr-cockpit"));
  chmodSync(join(scripts, "pr-cockpit"), 0o755);
  symlinkSync(join(scripts, "pr-cockpit"), command);

  try {
    const update = Bun.spawn([command, "update"], {
      env: { ...Bun.env, COCKPIT_PORT: String(server.port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, exitCode] = await Promise.all([
      new Response(update.stdout).text(),
      new Response(update.stderr).text(),
      update.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(error).toBe("");
    expect(output).toBe(`pr-cockpit: updated to ${targetRev.slice(0, 7)}\n`);
    expect(requests).toEqual(["GET /api/version", "POST /api/update", "GET /api/version"]);

    const invalid = Bun.spawn([command, "update", "unexpected"], {
      env: { ...Bun.env, COCKPIT_PORT: String(server.port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [invalidError, invalidExitCode] = await Promise.all([
      new Response(invalid.stderr).text(),
      invalid.exited,
    ]);
    expect(invalidExitCode).toBe(2);
    expect(invalidError).toContain("pr-cockpit update");
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});