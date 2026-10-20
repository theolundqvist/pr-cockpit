import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, getSetting, setSetting } from "./db.ts";
import { askView, type AskPr } from "./askView.ts";
import { field, type QuickGenerateRoots } from "./quickGenerate.ts";

const savedEnvFile = getSetting("quick_generate_env_file");
const dirs: string[] = [];

afterEach(() => {
  if (savedEnvFile === null) db.run("DELETE FROM settings WHERE key = ?", ["quick_generate_env_file"]);
  else setSetting("quick_generate_env_file", savedEnvFile);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
const preconnect = fetch.preconnect;

interface Call {
  url: string;
  auth: string | null;
  body: unknown;
}

function mockVendors(handle: (call: Call) => Response) {
  const calls: Call[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: FetchInput, init?: FetchInit) => {
    const call = { url: String(input), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return handle(call);
  }, { preconnect }));
  return { calls, restore: () => spy.mockRestore() };
}

function keyFile(contents: string): QuickGenerateRoots {
  const home = mkdtempSync(join(tmpdir(), "ask-view-home-"));
  dirs.push(home);
  mkdirSync(join(home, ".config"));
  writeFileSync(join(home, ".config", ".env"), contents);
  setSetting("quick_generate_env_file", "");
  return { home, configHome: join(home, ".config"), processEnv: {} };
}

function pr(number: number, title: string): AskPr {
  return {
    key: `acme/app#${number}`, title, author: "dev", state: "OPEN", isDraft: false, ciStatus: "SUCCESS",
    reviewDecision: null, labels: [], section: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", body: "",
  };
}

// Jev answers yes for every PR title or excerpt that mentions billing work.
function jevAnswer(body: unknown): Response {
  const state = field(body, "state");
  const prs = field(state, "prs");
  const entries: unknown[] = Array.isArray(prs) ? prs : [field(state, "items")].flat();
  const answers = Object.fromEntries(entries.map((entry, index) => {
    const text = String(field(entry, "title") ?? field(entry, "text"));
    return [`q${index}`, { type: "noul", noul: /billing|invoice/i.test(text) ? 0.9 : 0.1 }];
  }));
  return Response.json({ model: "jev", answers, usage: { input_tokens: 1, output_tokens: 1 } });
}

const models = (id: string) => Response.json({ data: [{ id: "gpt-oss-120b" }, { id }] });

describe("ask about a list", () => {
  test("Qwen's filter condition is judged by Jev for every listed PR across chunks, and its matches are the result", async () => {
    const prs = Array.from({ length: 120 }, (_, index) => pr(index + 1, index % 40 === 7 ? `fix(billing): invoice rounding ${index}` : `chore: tidy ${index}`));
    const chatBodies: unknown[] = [];
    const vendors = mockVendors((call) => {
      if (call.url.startsWith("https://api.typesafe.ai/")) return jevAnswer(call.body);
      if (call.url.endsWith("/models")) return models("qwen-3.8-27b");
      chatBodies.push(call.body);
      const messages = field(call.body, "messages");
      const tool = (Array.isArray(messages) ? messages : []).find((message) => field(message, "role") === "tool");
      if (!tool) {
        return Response.json({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "filter_prs", arguments: JSON.stringify({ condition: "The PR changes billing." }) } }] } }] });
      }
      return Response.json({ choices: [{ message: { content: `Found ${field(JSON.parse(String(field(tool, "content"))), "matched")} billing PRs.` } }] });
    });
    try {
      const result = await askView("Which PRs touch billing?", { kind: "list", title: "Queue", prs }, undefined, keyFile("TYPESAFE_API_KEY=ts-secret\nCEREBRAS_API_KEY=csk-secret\nGROQ_API_KEY=gsk-secret"));
      expect(result.answer).toBe("Found 3 billing PRs.");
      expect(result.filters).toEqual(["The PR changes billing."]);
      expect(result.matches?.map((match) => match.key)).toEqual(["acme/app#8", "acme/app#48", "acme/app#88"]);
      expect(result.provider).toBe("Cerebras");
      const jevCalls = vendors.calls.filter((call) => call.url.startsWith("https://api.typesafe.ai/"));
      // Two passes (the raw question and Qwen's condition), each split into chunks of at most 50 PRs.
      expect(jevCalls.length).toBe(6);
      expect(jevCalls.every((call) => call.auth === "Bearer ts-secret")).toBe(true);
      expect(chatBodies.length).toBe(2);
    } finally {
      vendors.restore();
    }
  });
});

describe("Qwen provider", () => {
  test("Groq answers when Cerebras fails, and each key reaches only its own vendor", async () => {
    const vendors = mockVendors((call) => {
      if (call.url.startsWith("https://api.typesafe.ai/")) return jevAnswer(call.body);
      if (call.url.startsWith("https://api.cerebras.ai/")) return Response.json({ error: { message: "overloaded" } }, { status: 503 });
      if (call.url.endsWith("/models")) return models("qwen/qwen3.8-27b");
      return Response.json({ choices: [{ message: { content: "The invoice change is in the description." } }] });
    });
    try {
      const detail = { title: "Invoice rounding", state: "OPEN", author: { login: "dev" }, body: "Rounds invoice totals.", comments: { nodes: [{ author: { login: "bot" }, body: "Looks fine." }] } };
      const result = await askView("What changes for invoices?", { kind: "pr", key: "acme/app#1", detail, diff: null }, undefined, keyFile("TYPESAFE_API_KEY=ts-secret\nCEREBRAS_API_KEY=csk-secret\nGROQ_API_KEY=gsk-secret"));
      expect(result.provider).toBe("Groq");
      expect(result.model).toBe("qwen/qwen3.8-27b");
      expect(result.fallback).toContain("Cerebras");
      expect(result.sources?.map((source) => source.label)).toEqual(["Description"]);
      for (const call of vendors.calls) {
        const expected = call.url.startsWith("https://api.typesafe.ai/") ? "Bearer ts-secret"
          : call.url.startsWith("https://api.cerebras.ai/") ? "Bearer csk-secret"
          : "Bearer gsk-secret";
        expect(call.auth).toBe(expected);
      }
    } finally {
      vendors.restore();
    }
  });

  test("an ask without a TypeSafe key fails before any provider is called", async () => {
    const vendors = mockVendors(() => Response.json({}));
    try {
      const error = await askView("anything", { kind: "page", title: "Actions", text: "Runs" }, undefined, keyFile("CEREBRAS_API_KEY=csk-secret"))
        .then(() => null, (reason: unknown) => reason);
      expect(error).toMatchObject({ status: 400, message: "Add TYPESAFE_API_KEY to the key file." });
      expect(vendors.calls).toEqual([]);
    } finally {
      vendors.restore();
    }
  });
});
