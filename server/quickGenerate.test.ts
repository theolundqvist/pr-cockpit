import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, getSetting, setSetting } from "./db.ts";
import { startCockpitServer } from "./cockpitServer.ts";
import { buildFetchHandler } from "./http.ts";
import { QuickGenerateError, quickGenerate, quickGenerateConfig, quickGenerateModels, type QuickGenerateRoots } from "./quickGenerate.ts";

const SETTING_NAMES = ["quick_generate_enabled", "quick_generate_key", "quick_generate_model", "quick_generate_env_file", "replica_ssh_host"];
const savedSettings = new Map(SETTING_NAMES.map((name) => [name, getSetting(name)]));
const dirs: string[] = [];

afterEach(() => {
  for (const [name, value] of savedSettings) {
    if (value === null) db.run("DELETE FROM settings WHERE key = ?", [name]);
    else setSetting(name, value);
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
const preconnect = fetch.preconnect;

function mockFetch(impl: (input: FetchInput, init?: FetchInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(impl, { preconnect }));
}

function homeWith(files: { config?: string; home?: string }, processEnv: Record<string, string | undefined> = {}): QuickGenerateRoots {
  const home = mkdtempSync(join(tmpdir(), "quick-generate-home-"));
  dirs.push(home);
  const configHome = join(home, ".config");
  mkdirSync(configHome);
  if (files.config !== undefined) writeFileSync(join(configHome, ".env"), files.config);
  if (files.home !== undefined) writeFileSync(join(home, ".env"), files.home);
  setSetting("quick_generate_env_file", "");
  return { home, configHome, processEnv };
}

async function rejection(promise: Promise<unknown>): Promise<QuickGenerateError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof QuickGenerateError)) throw new Error(`expected QuickGenerateError, got ${String(error)}`);
  return error;
}

function configError(roots: QuickGenerateRoots): QuickGenerateError {
  try {
    quickGenerateConfig(roots);
  } catch (error) {
    if (error instanceof QuickGenerateError) return error;
    throw error;
  }
  throw new Error("expected quickGenerateConfig to fail");
}

describe("quick generate keys", () => {
  test("discovers keys from the config-root and home env files ahead of the process env, without exposing secrets", () => {
    setSetting("quick_generate_key", "");
    setSetting("quick_generate_model", "saved-model");
    const roots = homeWith(
      {
        config: "OPENAI_API_KEY=sk-config-openai-secret\nexport CEREBRAS_API_KEY_WORK_ACCOUNT=\"csk-work-secret\"\nGROQ_API_KEY=\nMISTRAL_API_KEY=unsupported-secret",
        home: "OPENAI_API_KEY=sk-home-openai-secret\nCEREBRAS_API_KEY=csk-home-secret",
      },
      { ANTHROPIC_API_KEY: "sk-ant-process-secret", HOME: "/elsewhere" },
    );
    const config = quickGenerateConfig(roots);
    expect(config).toEqual({
      keys: [
        { id: "CEREBRAS_API_KEY", provider: "cerebras", label: "Cerebras" },
        { id: "CEREBRAS_API_KEY_WORK_ACCOUNT", provider: "cerebras", label: "Cerebras (work account)" },
        { id: "OPENAI_API_KEY", provider: "openai", label: "OpenAI" },
        { id: "ANTHROPIC_API_KEY", provider: "anthropic", label: "Anthropic" },
      ],
      defaultKey: "CEREBRAS_API_KEY",
      defaultModel: "saved-model",
      envFiles: [join(roots.configHome, ".env"), join(roots.home, ".env")],
      defaultEnvFile: join(roots.configHome, ".env"),
    });
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  test("quoted config-root keys with inline comments override the home file", async () => {
    const roots = homeWith({ config: "export CEREBRAS_API_KEY=\"csk-config\" # account key", home: "CEREBRAS_API_KEY=csk-home" });
    const auth: Array<string | null> = [];
    const fetchSpy = mockFetch(async (_input, init) => {
      auth.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ data: [] });
    });
    try {
      await quickGenerateModels("CEREBRAS_API_KEY", undefined, roots);
      expect(auth).toEqual(["Bearer csk-config"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("only env files that exist are reported as read", () => {
    const roots = homeWith({ home: "GROQ_API_KEY=gsk-home" });
    expect(quickGenerateConfig(roots).envFiles).toEqual([join(roots.home, ".env")]);
  });

  test("a configured env file replaces the automatic files but keeps process env keys", () => {
    const roots = homeWith({ config: "OPENAI_API_KEY=sk-auto" }, { GROQ_API_KEY: "gsk-process" });
    writeFileSync(join(roots.configHome, "keys.env"), "CEREBRAS_API_KEY=csk-explicit");
    setSetting("quick_generate_env_file", "$XDG_CONFIG_HOME/keys.env");
    const config = quickGenerateConfig(roots);
    expect(config.keys.map((key) => key.id)).toEqual(["CEREBRAS_API_KEY", "GROQ_API_KEY"]);
    expect(config.envFiles).toEqual([join(roots.configHome, "keys.env")]);
    setSetting("quick_generate_env_file", "~/.config/keys.env");
    expect(quickGenerateConfig(roots).envFiles).toEqual([join(roots.configHome, "keys.env")]);
  });

  test("a missing or relative configured env file is an error, not a fallback to the automatic files", () => {
    const roots = homeWith({ config: "CEREBRAS_API_KEY=csk-auto" });
    setSetting("quick_generate_env_file", "${HOME}/missing.env");
    const missing = configError(roots);
    expect(missing.status).toBe(400);
    expect(missing.message).toContain(join(roots.home, "missing.env"));
    setSetting("quick_generate_env_file", "keys.env");
    expect(configError(roots).status).toBe(400);
  });

  test("a saved key that is no longer configured falls back without carrying its model", () => {
    setSetting("quick_generate_key", "OPENAI_API_KEY");
    setSetting("quick_generate_model", "gpt-saved");
    const config = quickGenerateConfig(homeWith({ config: "CEREBRAS_API_KEY=csk-secret" }));
    expect(config.defaultKey).toBe("CEREBRAS_API_KEY");
    expect(config.defaultModel).toBe("");
  });
});

describe("quick generate provider calls", () => {
  test("Cerebras model discovery lists Qwen first and sends the key only to Cerebras", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchSpy = mockFetch(async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "gpt-oss-120b" }, { id: "qwen-3.8-27b" }] });
    });
    try {
      const roots = homeWith({ config: "CEREBRAS_API_KEY=csk-secret\nOPENAI_API_KEY=sk-other" });
      const models = await quickGenerateModels("CEREBRAS_API_KEY", undefined, roots);
      expect(models.map((model) => model.id)).toEqual(["qwen-3.8-27b", "gpt-oss-120b"]);
      expect(calls).toEqual([{ url: "https://api.cerebras.ai/v1/models", auth: "Bearer csk-secret" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("an empty model generates with the provider's preferred discovered model", async () => {
    const models: unknown[] = [];
    const fetchSpy = mockFetch(async (input, init) => {
      if (String(input).endsWith("/models")) return Response.json({ data: [{ id: "gpt-oss-120b" }, { id: "qwen-3.8-27b" }] });
      const body: unknown = JSON.parse(String(init?.body));
      models.push(body && typeof body === "object" && "model" in body ? body.model : undefined);
      return Response.json({ choices: [{ message: { content: "\n\nHello there.", reasoning: "hidden" } }] });
    });
    try {
      await quickGenerate({ key: "", model: "", prompt: "Say hello" }, undefined, homeWith({ config: "CEREBRAS_API_KEY=csk-secret" }));
      expect(models).toEqual(["qwen-3.8-27b"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("provider failures never echo the key", async () => {
    const secret = "sk-live-abcdef123456";
    const roots = homeWith({ config: `OPENAI_API_KEY=${secret}` });
    const responses = [
      Response.json({ error: { message: `Incorrect API key provided: ${secret}` } }, { status: 401 }),
      Response.json({ error: { message: `Bad request for key ${secret} and sk-proj-zzzzzzzzzz` } }, { status: 400 }),
    ];
    const fetchSpy = mockFetch(async () => responses.shift() ?? Response.json({}, { status: 500 }));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await rejection(quickGenerate({ key: "OPENAI_API_KEY", model: "gpt-x", prompt: "hi" }, undefined, roots));
        expect(error.status).toBe(502);
        expect(error.message).toContain("OpenAI");
        expect(error.message).not.toContain(secret);
        expect(error.message).not.toContain("sk-proj-zzzzzzzzzz");
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("cancelling the caller aborts the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchSpy = mockFetch(async (_input, init) => {
      const signal = init?.signal ?? undefined;
      upstreamSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) signal.addEventListener("abort", () => reject(signal.reason));
      });
    });
    try {
      const caller = new AbortController();
      const roots = homeWith({ config: "CEREBRAS_API_KEY=csk-secret" });
      const pending = quickGenerate({ key: "", model: "qwen-3.8-27b", prompt: "hi" }, caller.signal, roots);
      caller.abort();
      const error = await rejection(pending);
      expect(error.status).toBe(499);
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("quick generate routes", () => {
  test("generation is refused while the feature is off, before any provider call", async () => {
    setSetting("quick_generate_enabled", "false");
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/quick-generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "CEREBRAS_API_KEY", model: "qwen-3.8-27b", prompt: "hi" }),
      }));
      expect(response.status).toBe(403);
      const body: unknown = await response.json();
      expect(body && typeof body === "object" && "error" in body ? typeof body.error : undefined).toBe("string");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("replica mode answers quick generate locally instead of proxying to the source", async () => {
    setSetting("replica_ssh_host", "replica-source");
    setSetting("quick_generate_env_file", "/nonexistent/quick-generate.env");
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/quick-generate/config"));
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(body && typeof body === "object" && "error" in body ? body.error : undefined).toContain("/nonexistent/quick-generate.env");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("cross-site pages cannot trigger provider model discovery", async () => {
    const reached: string[] = [];
    const server = startCockpitServer(0, (request) => {
      reached.push(new URL(request.url).pathname);
      return Response.json({});
    }, "");
    try {
      const base = `http://127.0.0.1:${server.port}/api/quick-generate`;
      expect((await fetch(`${base}/models?key=CEREBRAS_API_KEY`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(`${base}/models?key=CEREBRAS_API_KEY`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect(reached).toEqual([]);
      expect((await fetch(`${base}/models?key=CEREBRAS_API_KEY`, { headers: { origin: `http://127.0.0.1:${server.port}` } })).status).toBe(200);
      expect((await fetch(`${base}/config`, { headers: { origin: "https://evil.example" } })).status).toBe(200);
      expect(reached).toEqual(["/api/quick-generate/models", "/api/quick-generate/config"]);
    } finally {
      server.stop(true);
    }
  });
});
