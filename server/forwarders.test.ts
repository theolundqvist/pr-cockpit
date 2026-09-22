import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forwardersUrl = new URL("./forwarders.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;
const settingsUrl = new URL("./settings.ts", import.meta.url).href;

test("forwarders distinguish local shutdown, rate limits, and an existing owner's hook", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-forwarders-"));
  try {
    const script = `
      import { mock } from "bun:test";
      let repos = ["acme/local"];
      mock.module(${JSON.stringify(dbUrl)}, () => ({ listWebhookRegistrations: () => [] }));
      mock.module(${JSON.stringify(settingsUrl)}, () => ({
        cockpitWebhooksEnabled: () => true,
        settingsRepos: () => [...repos],
      }));

      const errors = [];
      const logs = [];
      console.error = (...args) => errors.push(args.map(String).join(" "));
      console.log = (...args) => logs.push(args.map(String).join(" "));
      const timers = [];
      globalThis.setInterval = () => 0;
      globalThis.setTimeout = (fn, delay) => {
        const timer = { fn, delay };
        timers.push(timer);
        return timer;
      };

      class FakeProcess {
        pid;
        killed = false;
        exitCode = null;
        exited;
        stderr;
        #done = Promise.withResolvers();
        #writer;
        constructor(pid) {
          this.pid = pid;
          this.exited = this.#done.promise;
          const stream = new TransformStream();
          this.stderr = stream.readable;
          this.#writer = stream.writable.getWriter();
        }
        async finish(stderr, code = 1) {
          if (stderr) await this.#writer.write(new TextEncoder().encode(stderr));
          await this.#writer.close();
          this.exitCode = code;
          this.#done.resolve(code);
        }
        kill() {
          this.killed = true;
          this.exitCode = 143;
          void this.#writer.close();
          this.#done.resolve(143);
        }
      }

      const processes = [];
      Bun.spawn = (command) => {
        if (command[0] !== "gh" || command[1] !== "webhook") throw new Error("unexpected command: " + command.join(" "));
        const process = new FakeProcess(100 + processes.length);
        processes.push(process);
        return process;
      };
      const flush = async () => {
        for (let index = 0; index < 10; index++) await Promise.resolve();
      };

      // Import after installing module and process fakes to exercise the public lifecycle deterministically.
      const { forwarderStatuses, reconcileForwarders, startForwarders } = await import(${JSON.stringify(forwardersUrl)});
      startForwarders(4821);
      repos = [];
      reconcileForwarders();
      await flush();
      const local = { errors: [...errors], timers: timers.length, killed: processes[0].killed };

      repos = ["acme/rate-limited"];
      reconcileForwarders();
      await processes[1].finish("error creating webhook: HTTP 403: API rate limit exceeded\\nAuthorization: bearer ghp_12345678901234567890");
      await flush();
      const rateLimited = { errors: [...errors], timer: timers[0]?.delay, status: forwarderStatuses() };
      timers.shift().fn();

      repos = ["acme/rate-limited", "acme/owned"];
      reconcileForwarders();
      await processes.at(-1).finish("error creating webhook: HTTP 422: Hook already exists on this repository");
      await flush();
      const existingOwner = { errors: [...errors], timers: timers.length, processCount: processes.length, logs: [...logs] };

      process.stdout.write(JSON.stringify({ local, rateLimited, existingOwner }));
      process.exit(0);
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result.local).toEqual({ errors: [], timers: 0, killed: true });
    expect(result.rateLimited.timer).toBe(5_000);
    expect(result.rateLimited.errors.join("\n")).toContain("HTTP 403: API rate limit exceeded");
    expect(result.rateLimited.errors.join("\n")).not.toContain("ghp_12345678901234567890");
    expect(result.rateLimited.status).toEqual([{ repo: "acme/rate-limited", pid: null, alive: false }]);
    expect(result.existingOwner.errors).toEqual(result.rateLimited.errors);
    expect(result.existingOwner.timers).toBe(0);
    expect(result.existingOwner.processCount).toBe(4);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
