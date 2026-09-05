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
    const sourceSnapshot = await sourceSnapshotResponse.json() as { tables: { prs: unknown[] } };
    expect(sourceSnapshot.tables.prs.length).toBeGreaterThan(0);
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
    await source.exited;
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
