import { expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));
// Imported after the mock: the Worker module cannot load without the Cloudflare runtime.
const { Events } = await import("./index.ts");

type Marker = { seq: number; ts: number; repo: string; number: number | null; event: string };

// Enforces the Durable Object limits the relay depends on: 128 keys per call, keys listed in order.
class Storage {
  data = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return structuredClone(this.data.get(key));
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    if (Object.keys(entries).length > 128) throw new RangeError("put accepts at most 128 keys");
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value));
  }
  async delete(keys: string | string[]): Promise<unknown> {
    const list = typeof keys === "string" ? [keys] : keys;
    if (list.length > 128) throw new RangeError("delete accepts at most 128 keys");
    for (const key of list) this.data.delete(key);
  }
  async list({ prefix }: { prefix: string }): Promise<Map<string, unknown>> {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key))]));
  }
}

async function start(storage: Storage): Promise<InstanceType<typeof Events>> {
  let loaded: Promise<unknown> = Promise.resolve();
  const ctx = { storage, blockConcurrencyWhile: (load: () => Promise<unknown>) => (loaded = load()) };
  const events = new Events(ctx as never, {} as never);
  await loaded;
  return events;
}

test("a restarted relay keeps its capped backlog in order after upgrading the stored format", async () => {
  const storage = new Storage();
  const marker = (seq: number): Marker => ({ seq, ts: seq, repo: "acme/app", number: seq, event: "pull_request" });
  storage.data.set("seq", 999);
  storage.data.set("coverage", { acme: { all: true, repos: [] } });
  storage.data.set("events", Array.from({ length: 999 }, (_, index) => marker(index + 1)));

  const upgraded = await start(storage);
  await upgraded.append({ ts: 1000, repo: "acme/app", number: 1000, event: "pull_request" });
  await upgraded.append({ ts: 1001, repo: "acme/app", number: 1001, event: "pull_request" });

  await start(storage);
  const restarted = await start(storage);
  expect((await restarted.list(996, "token")).events.map((event) => event.seq)).toEqual([997, 998, 999, 1000, 1001]);
  expect((await restarted.list(0, "token")).events[0]?.seq).toBe(2);
});
