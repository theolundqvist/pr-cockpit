import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port!;
}

function startServer(port: number, dataDir: string) {
  return Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...Bun.env, COCKPIT_PORT: String(port), COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1", COCKPIT_REPLICA_SSH_HOST: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a second server on another port refuses a data dir that a running server owns", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-data-lock-"));
  const ownerPort = reservePort();
  const owner = startServer(ownerPort, dataDir);
  let intruder: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await fetch(`http://127.0.0.1:${ownerPort}/healthz`).then((response) => response.ok, () => false)) break;
      expect(owner.exitCode).toBeNull();
      await Bun.sleep(50);
    }
    intruder = startServer(reservePort(), dataDir);
    expect(await intruder.exited).toBe(1);
    expect(await new Response(intruder.stderr).text()).toContain(`another server is using ${dataDir}`);
    expect((await fetch(`http://127.0.0.1:${ownerPort}/healthz`)).ok).toBe(true);
  } finally {
    intruder?.kill();
    owner.kill();
    await Promise.all([intruder?.exited, owner.exited]);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
