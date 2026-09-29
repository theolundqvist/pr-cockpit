import { expect, mock, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));
// Workers extends SubtleCrypto with timingSafeEqual for webhook signature checks; Bun does not.
Object.assign(crypto.subtle, { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b) });
// Imported after the mock: the Worker module cannot load without the Cloudflare runtime.
const { Events, default: worker } = await import("./index.ts");

type Marker = { seq: number; ts: number; repo: string; number: number | null; event: string; ref?: string };

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

async function signedWebhook(event: string, payload: unknown): Promise<Request> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const signature = [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://relay.test/github", {
    method: "POST",
    headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": `sha256=${signature}` },
    body,
  });
}

test("push refs survive a restart and replay only on push markers", async () => {
  const storage = new Storage();
  storage.data.set("seq", 1);
  storage.data.set("marker:0000000000000001", { seq: 1, ts: 1, repo: "acme/app", number: null, event: "push" });
  let events = await start(storage);
  const env = () => ({ WEBHOOK_SECRET: "secret", EVENTS: { idFromName: () => "events", get: () => events } }) as never;
  const repository = { full_name: "acme/app" };
  for (const [event, payload] of [
    ["push", { ref: "refs/heads/feature/nested/topic", repository }],
    ["push", { ref: "", repository }],
    ["create", { ref: "feature/nested/topic", ref_type: "branch", repository }],
  ] as const) {
    expect((await worker.fetch(await signedWebhook(event, payload), env())).status).toBe(200);
  }

  events = await start(storage);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  try {
    const response = await worker.fetch(
      new Request("https://relay.test/events?since=0", { headers: { Authorization: "Bearer token" } }),
      env(),
    );
    const body = (await response.json()) as { latest: number; events: Marker[] };
    expect(body.latest).toBe(4);
    expect(body.events.map((marker) => [marker.seq, "ref" in marker ? marker.ref : "absent"])).toEqual([
      [1, "absent"],
      [2, "refs/heads/feature/nested/topic"],
      [3, "absent"],
      [4, "absent"],
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
