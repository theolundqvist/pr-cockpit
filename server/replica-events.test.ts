import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("replica details follow source events outside the inbox, after merge, and after source reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-events-"));
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const sourcePort = reservation.port!;
  reservation.stop(true);
  const second = Bun.serve({ port: 0, fetch: () => new Response() });
  const replicaPort = second.port!;
  second.stop(true);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["ssh", "gh", "git"]) {
    writeFileSync(join(bin, name), name === "ssh"
      ? '#!/bin/sh\nwhile kill -0 "$PPID" 2>/dev/null; do sleep 0.1; done\n'
      : "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, name), 0o755);
  }
  // Separate child imports intentionally exercise each server's module-level DB and publisher.
  const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const script = `
    const db = await import(${url("./db.ts")});
    const { seedSettings } = await import(${url("./settings.ts")});
    const { installMockNetworkGuard, seedMockDatabase } = await import(${url("./mockGithub.ts")});
    const { buildFetchHandler } = await import(${url("./http.ts")});
    const { startCockpitServer } = await import(${url("./cockpitServer.ts")});
    const { invalidatePr } = await import(${url("./rendererInvalidation.ts")});
    installMockNetworkGuard();
    seedSettings();
    seedMockDatabase(db.db, Bun.env.COCKPIT_DATA_DIR);
    const original = db.listPrs()[0];
    const detail = { ...JSON.parse(original.detail_json), comments: { nodes: [] } };
    db.db.query("DELETE FROM prs").run();
    db.upsertPr({ ...original, repo: "fixture/cockpit", number: 301, fetched_at: new Date().toISOString(), detail_json: JSON.stringify(detail) });
    db.upsertCachedPrDetail({ repo: "fixture/cockpit", number: 901, head_sha: original.head_sha, fetched_at: new Date().toISOString(), detail_json: JSON.stringify(detail) });
    const handler = buildFetchHandler(${sourcePort});
    const serve = () => startCockpitServer(${sourcePort}, (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/__update") {
        const number = Number(url.searchParams.get("number"));
        const tracked = db.getPr("fixture/cockpit", number);
        const row = tracked ?? db.getCachedPrDetail("fixture/cockpit", number);
        const detail = JSON.parse(row.detail_json);
        detail.comments.nodes = [{ id: "preview", body: url.searchParams.get("body"), author: { login: "preview-bot" }, createdAt: "2026-10-28T12:00:00Z" }];
        if (url.searchParams.has("merge")) {
          detail.state = "MERGED";
          db.upsertCachedPrDetail({ repo: row.repo, number, head_sha: row.head_sha, fetched_at: new Date().toISOString(), detail_json: JSON.stringify(detail) });
          db.db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(row.repo, number);
        } else {
          db.db.query("UPDATE " + (tracked ? "prs" : "pr_detail_cache") + " SET detail_json = ? WHERE repo = ? AND number = ?")
            .run(JSON.stringify(detail), row.repo, number);
        }
        if (!url.searchParams.has("silent")) invalidatePr(row.repo, number);
        return new Response("ok");
      }
      if (url.pathname === "/__restart") {
        // Closing the real server drops its event clients. The next successful replica sync
        // reconnects them; this intentionally crosses a real process/socket lifecycle.
        setImmediate(() => { server.stop(true); server = serve(); });
        return new Response("ok");
      }
      return handler(request);
    });
    let server = serve();
    console.log("source-ready");
  `;
  const env = { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}` };
  const source = Bun.spawn([process.execPath, "-e", script], {
    env: { ...env, COCKPIT_DATA_DIR: join(root, "source"), COCKPIT_MOCK: "1", COCKPIT_REPLICA_SSH_HOST: "" },
    stdout: "pipe", stderr: "pipe",
  });
  let replica: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let socket: WebSocket | undefined;
  try {
    const reader = source.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("source-ready");
    reader.releaseLock();
    replica = Bun.spawn([process.execPath, "server/main.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...env, COCKPIT_DATA_DIR: join(root, "replica"), COCKPIT_MOCK: "", COCKPIT_PORT: String(replicaPort), COCKPIT_REPLICA_SSH_HOST: "fixture-source", COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort) },
      stdout: "pipe", stderr: "pipe",
    });
    const replicaReader = replica.stdout.getReader();
    let boot = "";
    while (!boot.includes("pr-cockpit server listening")) {
      const chunk = await replicaReader.read();
      if (chunk.done) throw new Error("replica exited before listening");
      boot += new TextDecoder().decode(chunk.value);
    }
    replicaReader.releaseLock();
    socket = new WebSocket(`ws://127.0.0.1:${replicaPort}/api/events`);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("replica socket failed")), { once: true });
    });
    const detail = (number: number) => fetch(`http://127.0.0.1:${replicaPort}/api/pr/fixture/cockpit/${number}`);
    const update = async (number: number, body: string, flags = "") => {
      // The detail is already open before the source changes, including untracked keys.
      expect((await detail(number)).status).toBe(200);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const currentSocket = socket!;
      const assertDetail = async () => {
        const response = await detail(number);
        expect(response.status).toBe(200);
        const snapshot = await response.json() as { comments: { nodes: Array<{ body: string }> } };
        expect(snapshot.comments.nodes.at(-1)?.body).toBe(body);
      };
      // Child-process clocks cannot be faked here; this deadline only bounds missing socket events.
      const timer = setTimeout(() => reject(new Error(`No detail event for ${number}: ${body}`)), 12_000);
      const listener = (message: MessageEvent) => {
        const event = JSON.parse(String(message.data));
        if (event.type !== "pr" || event.repo !== "fixture/cockpit" || event.number !== number) return;
        void assertDetail().then(resolve, reject);
      };
      const reconnect = async (event: CloseEvent) => {
        try {
          expect(event.code).toBe(1012);
          // Model the existing renderer onOpen catch-up: only the event socket reconnects.
          socket = new WebSocket(`ws://127.0.0.1:${replicaPort}/api/events`);
          await new Promise<void>((opened, failed) => {
            socket!.addEventListener("open", () => opened(), { once: true });
            socket!.addEventListener("error", () => failed(new Error("catch-up socket failed")), { once: true });
          });
          await assertDetail();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      currentSocket.addEventListener("message", listener);
      if (flags.includes("silent")) currentSocket.addEventListener("close", reconnect, { once: true });
      try {
        expect((await fetch(`http://127.0.0.1:${sourcePort}/__update?number=${number}&body=${encodeURIComponent(body)}${flags}`)).ok).toBe(true);
        if (flags.includes("silent")) {
          // The control response may be cut off by the deliberate source restart.
          await fetch(`http://127.0.0.1:${sourcePort}/__restart`).catch(() => {});
        }
        await promise;
      } finally {
        clearTimeout(timer);
        currentSocket.removeEventListener("message", listener);
        currentSocket.removeEventListener("close", reconnect);
      }
    };
    await update(901, "Untracked preview is building");
    await update(901, "Untracked preview is ready");
    await update(301, "Tracked preview is building");
    await update(301, "Merged preview is ready", "&merge=1");
    await update(301, "Edited after leaving inbox");
    await update(901, "Caught up after source reconnect", "&silent=1");
  } finally {
    socket?.close();
    replica?.kill();
    source.kill();
    await Promise.all([replica?.exited, source.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
