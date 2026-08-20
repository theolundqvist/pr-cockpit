import { Database } from "bun:sqlite";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-registration-"));
const legacyDb = new Database(join(dataDir, "cockpit.db"));
legacyDb.exec(`
  CREATE TABLE webhook_registrations (
    window_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    last_webhook_at TEXT
  );
  INSERT INTO webhook_registrations VALUES ('@1', 'acme/widget', 7, '2026-07-24T10:00:00Z');
  INSERT INTO webhook_registrations VALUES ('@2', 'acme/widget', 7, '2026-07-24T11:00:00Z');
  INSERT INTO webhook_registrations VALUES ('@3', 'acme/widget', 8, '2026-07-24T12:00:00Z');
`);
legacyDb.close();
Bun.env.COCKPIT_DATA_DIR = dataDir;

const refreshPr = mock(async (_repo: string, _number: number) => {});

// Modules load after the legacy database is in place so the migration sees it.
const { db, listWebhookRegistrations } = await import("./db.ts");
const { buildWebhookRoutes } = await import("./webhooks.ts");
const route = buildWebhookRoutes(refreshPr);
const migratedRows = listWebhookRegistrations().sort((a, b) => a.number - b.number);

async function request(path: string, body?: unknown): Promise<Response> {
  const response = await route(
    new Request(`http://127.0.0.1${path}`, body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    new URL(`http://127.0.0.1${path}`),
  );
  if (!response) throw new Error(`No route for ${path}`);
  return response;
}

async function workflowEvent(repo: string, number: number): Promise<Response | null> {
  return route(
    new Request("http://127.0.0.1/hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
      },
      body: JSON.stringify({
        repository: { full_name: repo },
        workflow_run: { pull_requests: [{ number }] },
      }),
    }),
    new URL("http://127.0.0.1/hook"),
  );
}

function clearRegistrations(): void {
  db.exec("DELETE FROM webhook_registrations");
  refreshPr.mockClear();
}

function registrations(): Array<{ repo: string; number: number; window_id: string | null }> {
  return listWebhookRegistrations()
    .map(({ repo, number, window_id }) => ({ repo, number, window_id }))
    .sort((a, b) => a.number - b.number);
}

describe("webhook registrations", () => {
  test("migrates legacy window-keyed registrations to newest rows keyed by PR", () => {
    expect(migratedRows).toEqual([
      { repo: "acme/widget", number: 7, window_id: "@2", last_webhook_at: "2026-07-24T11:00:00Z" },
      { repo: "acme/widget", number: 8, window_id: "@3", last_webhook_at: "2026-07-24T12:00:00Z" },
    ]);
    expect(db.query("PRAGMA table_info(webhook_registrations)").all()).toContainEqual(expect.objectContaining({ name: "repo", pk: 1 }));
    expect(db.query("PRAGMA table_info(webhook_registrations)").all()).toContainEqual(expect.objectContaining({ name: "number", pk: 2 }));
    expect(db.query("PRAGMA table_info(webhook_registrations)").all()).toContainEqual(expect.objectContaining({ name: "window_id", pk: 0, notnull: 0 }));
  });

  test("preserves the first PR when a second registration binds its window", async () => {
    clearRegistrations();

    expect(await (await request("/register", { repo: "acme/widget", number: 11, windowId: "@11" })).text()).toBe("ok");
    expect(await (await request("/register", { repo: "acme/widget", number: 12, windowId: "@11" })).text()).toBe("ok");

    expect(registrations()).toEqual([
      { repo: "acme/widget", number: 11, window_id: null },
      { repo: "acme/widget", number: 12, window_id: "@11" },
    ]);
    expect(refreshPr).toHaveBeenCalledWith("acme/widget", 11);
    expect(refreshPr).toHaveBeenCalledWith("acme/widget", 12);
  });

  test("logs rebinding and reports registrations by PR key", async () => {
    clearRegistrations();
    const log = spyOn(console, "log").mockImplementation(() => {});

    await request("/register", { repo: "acme/widget", number: 21, windowId: "@21" });
    await request("/register", { repo: "acme/widget", number: 22, windowId: "@21" });
    const status = await (await request("/status")).json() as {
      registrations: Record<string, { repo: string; number: number; windowId: string | null; lastWebhookAt: number | null }>;
    };

    expect(log.mock.calls.some((args) => args.includes("window rebound: @21 acme/widget#21 -> acme/widget#22"))).toBe(true);
    expect(status.registrations).toEqual({
      "acme/widget#21": { repo: "acme/widget", number: 21, windowId: null, lastWebhookAt: null },
      "acme/widget#22": { repo: "acme/widget", number: 22, windowId: "@21", lastWebhookAt: null },
    });
    log.mockRestore();
  });

  test("unregister by window deletes every registration on it; by PR deletes only that row", async () => {
    clearRegistrations();
    db.exec(`
      INSERT INTO webhook_registrations (repo, number, window_id, last_webhook_at) VALUES
        ('acme/widget', 31, '@31', NULL),
        ('acme/widget', 32, '@31', NULL),
        ('acme/widget', 33, '@33', NULL);
    `);

    expect(await (await request("/unregister", { windowId: "@31" })).text()).toBe("ok");
    expect(registrations()).toEqual([
      { repo: "acme/widget", number: 33, window_id: "@33" },
    ]);

    expect(await (await request("/unregister", { repo: "acme/widget", number: 33 })).text()).toBe("ok");
    expect(registrations()).toEqual([]);
  });

  test("refreshes a registered PR from workflow events through the injected callback", async () => {
    clearRegistrations();
    await request("/register", { repo: "acme/widget", number: 41 });
    refreshPr.mockClear();

    const response = await workflowEvent("acme/widget", 41);

    expect(await response?.text()).toBe("ok");
    expect(refreshPr).toHaveBeenCalledWith("acme/widget", 41);
    expect(listWebhookRegistrations()).toContainEqual(expect.objectContaining({
      repo: "acme/widget",
      number: 41,
      last_webhook_at: expect.any(String),
    }));
  });

  test("ignores workflow events for unconfigured and unregistered repositories", async () => {
    clearRegistrations();

    expect(await (await workflowEvent("other/widget", 42))?.text()).toBe("ignored");
    expect(refreshPr).not.toHaveBeenCalled();
  });
});

process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
