import { Session } from "node:inspector";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Handler = (request: Request) => Response | Promise<Response>;
let recording = false;
interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
  samples: number[];
  timeDeltas: number[];
}

export function profileDirectory(): string {
  const logs = process.platform === "darwin"
    ? join(homedir(), "Library/Logs/PR Cockpit")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pr-cockpit");
  return join(logs, "profiles", new Date().toISOString().replace(/[:.]/g, "-"));
}

function timings(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0, max: sorted.at(-1) ?? 0, total: values.reduce((a, b) => a + b, 0) };
}

function topFunctions(profile: CpuProfile) {
  const times = new Map<number, number>();
  for (const id of profile.samples) {
    times.set(id, (times.get(id) ?? 0) + 1);
  }
  return profile.nodes.map((node) => ({ name: node.callFrame.functionName || "(anonymous)", url: node.callFrame.url, line: node.callFrame.lineNumber + 1, selfMs: times.get(node.id) ?? 0 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 15);
}

export async function recordProfile(seconds: number, handler: Handler, install: (handler: Handler) => void) {
  if (recording) throw new Error("A performance recording is already active");
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) throw new Error("seconds must be between 1 and 120");
  recording = true;
  const session = new Session();
  const post = (method: string, params = {}) => new Promise<unknown>((resolve, reject) => session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  const routes = new Map<string, number[]>();
  const queries = new Map<string, number[]>();
  const github: { path: string; startedAt: number; ms?: number; status?: number }[] = [];
  const children: { command: string; startedAt: number; ms?: number }[] = [];
  const lag: number[] = [];
  const restores: (() => void)[] = [];
  let timer: Timer | undefined;
  const start = process.memoryUsage();
  const startedAt = new Date().toISOString();
  try {
    session.connect();
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 1000 });
    await post("Profiler.start");
    install(async (request) => {
      const time = performance.now();
      try { return await handler(request); }
      finally {
        const key = `${request.method} ${new URL(request.url).pathname}`;
        const values = routes.get(key) ?? [];
        values.push(performance.now() - time);
        routes.set(key, values);
      }
    });
    restores.push(() => install(handler));
    const probe = new Database(":memory:");
    const statement = probe.query("SELECT 1");
    const statementPrototype = Object.getPrototypeOf(statement.native);
    statement.finalize();
    probe.close();
    for (const method of ["all", "get", "run", "values", "iterate", "raw"] as const) {
      const original = statementPrototype[method];
      const wrapped = function (this: { toString(): string }, ...args: unknown[]) {
        const time = performance.now();
        try { return Reflect.apply(original, this, args); }
        finally {
          const sql = this.toString();
          const values = queries.get(sql) ?? [];
          values.push(performance.now() - time);
          queries.set(sql, values);
        }
      };
      Object.defineProperty(statementPrototype, method, { ...Object.getOwnPropertyDescriptor(statementPrototype, method), value: wrapped });
      restores.push(() => { Object.defineProperty(statementPrototype, method, { value: original }); });
    }
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "api.github.com") return originalFetch(...args);
      const time = performance.now();
      const entry = { path: url.pathname, startedAt: time, ms: undefined as number | undefined, status: undefined as number | undefined };
      github.push(entry);
      try { const response = await originalFetch(...args); entry.status = response.status; return response; }
      finally { entry.ms = performance.now() - time; }
    }) as typeof fetch;
    restores.push(() => { globalThis.fetch = originalFetch; });
    for (const method of ["spawn", "spawnSync"] as const) {
      const original = Bun[method];
      const wrapped = (...args: unknown[]) => {
        const time = performance.now();
        const input = args[0] as string[] | { cmd: string[] };
        const command = Array.isArray(input) ? input[0] : input.cmd?.[0];
        const entry = { command: String(command), startedAt: time, ms: undefined as number | undefined };
        children.push(entry);
        const result = Reflect.apply(original, Bun, args);
        if (method === "spawnSync") entry.ms = performance.now() - time;
        else void result.exited.then(() => { entry.ms = performance.now() - time; });
        return result;
      };
      Object.defineProperty(Bun, method, { ...Object.getOwnPropertyDescriptor(Bun, method), value: wrapped });
      restores.push(() => { Object.defineProperty(Bun, method, { value: original }); });
    }
    let expected = performance.now() + 100;
    timer = setInterval(() => { const now = performance.now(); lag.push(Math.max(0, now - expected)); expected = now + 100; }, 100);
    await Bun.sleep(seconds * 1000);
    const { profile } = await post("Profiler.stop") as { profile: CpuProfile };
    const directory = profileDirectory();
    const now = performance.now();
    const requests = github.map((entry) => ({ ...entry, ms: entry.ms ?? now - entry.startedAt, running: entry.ms === undefined }));
    const summary = {
      startedAt, seconds, memory: { start, end: process.memoryUsage() },
      serverCpu: { sampleIntervalUs: 1000, note: "Server self time is estimated from 1 ms samples. Bun omits idle samples; native cpuprofile timeDeltas include idle gaps, not CPU time." },
      routes: [...routes].map(([route, values]) => ({ route, ...timings(values) })).sort((a, b) => b.max - a.max),
      sqlite: [...queries].map(([sql, values]) => ({ sql, ...timings(values) })).sort((a, b) => b.total - a.total).slice(0, 50),
      eventLoopLag: { ...timings(lag), samples: lag }, github: { ...timings(requests.map((entry) => entry.ms)), requests },
      children: children.map((entry) => ({ ...entry, ms: entry.ms ?? now - entry.startedAt, running: entry.ms === undefined })),
      serverTopFunctions: topFunctions(profile), renderer: { note: "CLI records the server only; use View → Record Performance Profile in the shell to include the renderer." },
    };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "server.cpuprofile"), JSON.stringify(profile));
    writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    const markdown = `# Performance profile\n\nRecorded ${seconds}s at ${startedAt}. Times in milliseconds.\n\n## Server self time\n${summary.serverCpu.note}\n\n${summary.serverTopFunctions.map((x) => `- ${x.selfMs.toFixed(1)}: ${x.name} (${x.url}:${x.line})`).join("\n")}\n\n## Slowest routes\n${summary.routes.map((x) => `- ${x.route}: ${x.count} requests, p50 ${x.p50.toFixed(1)}, p95 ${x.p95.toFixed(1)}, max ${x.max.toFixed(1)}`).join("\n")}\n\n## SQLite (by total time)\n${summary.sqlite.slice(0, 10).map((x) => `- ${x.total.toFixed(1)} total / ${x.max.toFixed(1)} max (${x.count} calls): ${x.sql.replace(/\s+/g, " ")}`).join("\n")}\n\n${summary.renderer.note}\n`;
    writeFileSync(join(directory, "summary.md"), markdown);
    return { directory, summary: markdown };
  } finally {
    clearInterval(timer);
    for (const restore of restores.reverse()) restore();
    session.disconnect();
    recording = false;
  }
}
