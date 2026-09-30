import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { GithubQuota } from "./github.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port!;
}

async function waitForServer(port: number, process: Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  let lastError = "server did not start";
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) {
      lastError = await new Response(process.stderr).text();
      break;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(lastError);
}

test("a local server imports inbox state and proxies GitHub-backed APIs through its source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-"));
  const sourcePort = reservePort();
  const replicaPort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);

  const source = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      COCKPIT_PORT: String(sourcePort),
      COCKPIT_DATA_DIR: join(root, "source"),
      COCKPIT_MOCK: "1",
      COCKPIT_REPLICA_SSH_HOST: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let replica: Bun.Subprocess | null = null;

  try {
    await waitForServer(sourcePort, source);
    const sourceSnapshotResponse = await fetch(`http://127.0.0.1:${sourcePort}/api/replica/inbox`);
    expect(sourceSnapshotResponse.status).toBe(200);
    const etag = sourceSnapshotResponse.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const sourceSnapshot = await sourceSnapshotResponse.json() as { tables: Record<string, unknown[]> };
    expect(sourceSnapshot.tables.prs.length).toBeGreaterThan(0);
    expect(sourceSnapshot.tables).not.toHaveProperty("review_scores");
    expect(sourceSnapshot.tables).not.toHaveProperty("review_rescores");
    expect(sourceSnapshot.tables).not.toHaveProperty("desktop_notifications");
    expect(sourceSnapshot.tables).not.toHaveProperty("settings");
    expect((await fetch(`http://127.0.0.1:${sourcePort}/api/replica/inbox`, {
      headers: { "if-none-match": etag! },
    })).status).toBe(304);

    replica = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_PORT: String(replicaPort),
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
        COCKPIT_PROXY_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(replicaPort, replica);

    const status = await fetch(`http://127.0.0.1:${replicaPort}/api/replica/status`).then((response) => response.json()) as { connected: boolean; lastError: string | null };
    expect(status).toEqual(expect.objectContaining({ connected: true, lastError: null }));
    expect((await fetch(`http://127.0.0.1:${replicaPort}/api/replica/inbox`)).status).toBe(409);
    const sourceInbox = await fetch(`http://127.0.0.1:${sourcePort}/api/inbox`).then((response) => response.json()) as { prs: Array<{ repo: string; number: number }> };
    const replicaInbox = await fetch(`http://127.0.0.1:${replicaPort}/api/inbox`).then((response) => response.json()) as { prs: Array<{ repo: string; number: number }> };
    expect(replicaInbox.prs.map(({ repo, number }) => `${repo}#${number}`)).toEqual(
      sourceInbox.prs.map(({ repo, number }) => `${repo}#${number}`),
    );
    const sourceQuota = await fetch(`http://127.0.0.1:${sourcePort}/api/quota`).then((response) => response.json()) as GithubQuota;
    const replicaQuota = await fetch(`http://127.0.0.1:${replicaPort}/api/quota`).then((response) => response.json()) as GithubQuota;
    expect(replicaQuota).toEqual({
      ...sourceQuota,
      fetchedAt: expect.any(String),
      rest: { ...sourceQuota.rest, resetAt: expect.any(String) },
      graphql: { ...sourceQuota.graphql, resetAt: expect.any(String) },
    });
    const allPrsPath = "/api/all-prs?repo=fixture%2Fcockpit";
    const sourceAllPrs = await fetch(`http://127.0.0.1:${sourcePort}${allPrsPath}`);
    const replicaAllPrs = await fetch(`http://127.0.0.1:${replicaPort}${allPrsPath}`);
    expect(sourceAllPrs.status).toBe(200);
    expect(replicaAllPrs.status).toBe(200);
    expect(await replicaAllPrs.json()).toEqual(await sourceAllPrs.json());
    source.kill();
    const offlineInbox = await fetch(`http://127.0.0.1:${replicaPort}/api/inbox`).then((response) => response.json());
    expect(offlineInbox).toEqual(replicaInbox);
    const offlineAllPrs = await fetch(`http://127.0.0.1:${replicaPort}${allPrsPath}`);
    expect(offlineAllPrs.status).toBe(503);
    expect((await offlineAllPrs.json()).prs).toBeUndefined();
  } finally {
    replica?.kill();
    source.kill();
    await Promise.all([replica?.exited, source.exited]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replica mirrors the source's failed merges without touching its local mutation queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-merges-"));
  const sourcePort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { replicaFailedMergeKeys, replicaStatus, startReplicaSync } = await import(${JSON.stringify(new URL("./replica.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    db.setSetting("replica_ssh_host", "fixture-source");
    db.db.query(\`INSERT INTO prs (
      repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
      updated_at, additions, deletions, changed_files, commit_count, mergeable,
      ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
    ) VALUES (?, 301, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
      'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
      repo, "a".repeat(40), "2026-09-21T20:00:00Z",
      JSON.stringify({ body: "", comments: { nodes: [] } }), "2026-09-21T20:00:00Z",
    );
    const tables = db.readInboxReplica();
    const localId = db.insertMutation({
      repo, number: 301, kind: "merge", created_at: new Date().toISOString(),
      payload_json: JSON.stringify({ kind: "merge", force: false, baseRef: "main", method: "squash", source: "default" }),
    });
    db.setMutationState(localId, "failed", "local failure");

    let snapshot = { revision: '"old"', lastPollAt: null, viewerLogin: null, tables };
    const source = Bun.serve({
      port: ${sourcePort},
      fetch: (request) => new URL(request.url).pathname === "/healthz" ? new Response("ok") : Response.json(snapshot),
    });
    const handler = buildFetchHandler(4820);
    const sync = async () => {
      (await startReplicaSync())();
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      return {
        mergeFailed: prs.find((pr) => pr.number === 301)?.mergeFailed,
        mirrored: [...replicaFailedMergeKeys()],
        localErrors: db.listMutationsForPr(repo, 301).map((row) => row.error),
        lastError: replicaStatus().lastError,
      };
    };
    const oldSource = await sync();
    snapshot = { ...snapshot, revision: '"failed"', failedMergeKeys: [repo + "#301"] };
    const failedSource = await sync();
    snapshot = { ...snapshot, revision: '"malformed"', failedMergeKeys: [301] };
    const malformedSource = await sync();
    source.stop(true);
    console.log(JSON.stringify({ oldSource, failedSource, malformedSource }));
    process.exit(0);
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.oldSource).toEqual({ mergeFailed: false, mirrored: [], localErrors: ["local failure"], lastError: null });
    expect(result.failedSource).toEqual({ mergeFailed: true, mirrored: ["fixture/cockpit#301"], localErrors: ["local failure"], lastError: null });
    expect(result.malformedSource).toEqual({
      mergeFailed: true,
      mirrored: ["fixture/cockpit#301"],
      localErrors: ["local failure"],
      lastError: "Replica source returned invalid failed merges",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replica mirrors its source's merge-approval flag and rows, and toggles only through the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-approvals-"));
  const sourcePort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { replicaStatus, startReplicaSync } = await import(${JSON.stringify(new URL("./replica.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    db.setSetting("replica_ssh_host", "fixture-source");
    db.db.query(\`INSERT INTO prs (
      repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
      updated_at, additions, deletions, changed_files, commit_count, mergeable,
      ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
    ) VALUES (?, 301, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
      'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
      repo, "a".repeat(40), "2026-09-21T20:00:00Z",
      JSON.stringify({ state: "OPEN", body: "", comments: { nodes: [] } }), "2026-09-21T20:00:00Z",
    );
    const { pr_merge_approvals: _, ...legacyTables } = db.readInboxReplica();
    const source = { legacy: true, confirms: true, enabled: false, approvals: [], settingsBodies: [] };
    const server = Bun.serve({
      port: ${sourcePort},
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path === "/api/settings") {
          const body = await request.json();
          source.settingsBodies.push(body);
          // A source predating the flag ignores it and answers with its other settings.
          if (!source.confirms) return Response.json({ theme: "system" });
          source.enabled = body.safe_merge_approval_enabled;
          if (!source.enabled) source.approvals = [];
          return Response.json({ safe_merge_approval_enabled: source.enabled });
        }
        if (source.legacy) return Response.json({ revision: '"legacy"', lastPollAt: null, viewerLogin: null, tables: legacyTables });
        return Response.json({
          revision: '"' + source.enabled + source.approvals.length + '"',
          lastPollAt: null,
          viewerLogin: null,
          safeMergeApprovalEnabled: source.enabled,
          tables: { ...legacyTables, pr_merge_approvals: source.approvals },
        });
      },
    });
    const handler = buildFetchHandler(4820);
    const observe = async () => {
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      const settings = await (await handler(new Request("http://127.0.0.1:4820/api/settings"))).json();
      return {
        approved: prs.find((pr) => pr.number === 301)?.approvedForSafeMerge,
        flag: settings.safe_merge_approval_enabled,
        theme: settings.theme,
        lastError: replicaStatus().lastError,
      };
    };
    const sync = async () => {
      (await startReplicaSync())();
      return observe();
    };
    const put = async (body) => {
      const response = await handler(new Request("http://127.0.0.1:4820/api/settings", { method: "PUT", body: JSON.stringify(body) }));
      return { status: response.status, ...(await observe()) };
    };
    db.setSetting("safe_merge_approval_enabled", "true");
    const legacySource = await sync();
    source.legacy = false;
    source.enabled = true;
    source.approvals = [{ repo, number: 301, approved_at: "2026-09-21T20:01:00Z" }];
    const approvedSource = await sync();
    source.confirms = false;
    const unconfirmedDisable = await put({ safe_merge_approval_enabled: false, theme: "light" });
    source.confirms = true;
    const confirmedDisable = await put({ safe_merge_approval_enabled: false, theme: "light" });
    const afterDisableSync = await sync();
    // The source re-enabled and gained consent before this replica synced; an explicit disable still reaches it.
    source.enabled = true;
    source.approvals = [{ repo, number: 301, approved_at: "2026-09-21T20:02:00Z" }];
    const staleMirrorDisable = await put({ safe_merge_approval_enabled: false });
    const sourceAfterStaleDisable = { enabled: source.enabled, approvals: source.approvals.length };
    const reenabled = await put({ safe_merge_approval_enabled: true });
    server.stop(true);
    console.log(JSON.stringify({ legacySource, approvedSource, unconfirmedDisable, confirmedDisable, afterDisableSync, staleMirrorDisable, sourceAfterStaleDisable, reenabled, settingsBodies: source.settingsBodies }));
    process.exit(0);
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      legacySource: { approved: false, flag: false, theme: "system", lastError: null },
      approvedSource: { approved: true, flag: true, theme: "system", lastError: null },
      unconfirmedDisable: { status: 502, approved: true, flag: true, theme: "system", lastError: null },
      confirmedDisable: { status: 200, approved: false, flag: false, theme: "light", lastError: null },
      afterDisableSync: { approved: false, flag: false, theme: "light", lastError: null },
      staleMirrorDisable: { status: 200, approved: false, flag: false, theme: "light", lastError: null },
      sourceAfterStaleDisable: { enabled: false, approvals: 0 },
      reenabled: { status: 200, approved: false, flag: true, theme: "light", lastError: null },
      settingsBodies: [
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: true },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
