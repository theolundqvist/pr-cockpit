import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, getSetting, setSetting } from "./db.ts";
import { startCockpitServer } from "./cockpitServer.ts";
import { buildFetchHandler } from "./http.ts";
import { QuickGenerateError, parseQuickGenerateRequest, quickGenerate, quickGenerateConfig, quickGenerateModels, type QuickGenerateAttachment, type QuickGenerateRoots } from "./quickGenerate.ts";
import { ATTACHMENT_LIMITS } from "../shared/quickGenerateAttachments.js";

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

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
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

  test("OpenRouter model discovery puts the Auto Router first, uses catalog names, and sends the key only to OpenRouter", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchSpy = mockFetch(async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [
        { id: "google/gemini-omni-1.2-flash", name: "Google: Gemini Omni 1.2 Flash", created: 30, architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "video"] } },
        { id: "openrouter/auto", name: "Auto Router", created: 10, architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
        { id: "qwen/qwen3.8-27b", name: "Qwen: Qwen3.8 27B", created: 20, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      ] });
    });
    try {
      const roots = homeWith({ config: "OPENROUTER_API_KEY=sk-or-secret\nOPENAI_API_KEY=sk-other" });
      expect(quickGenerateConfig(roots).keys.map((key) => key.label)).toEqual(["OpenAI", "OpenRouter"]);
      const models = await quickGenerateModels("OPENROUTER_API_KEY", undefined, roots);
      expect(models).toEqual([
        { id: "openrouter/auto", label: "Auto Router", inputs: ["text"] },
        { id: "google/gemini-omni-1.2-flash", label: "Google: Gemini Omni 1.2 Flash", inputs: ["text", "image"] },
        { id: "qwen/qwen3.8-27b", label: "Qwen: Qwen3.8 27B", inputs: ["text", "image"] },
      ]);
      expect(calls).toEqual([{ url: "https://openrouter.ai/api/v1/models", auth: "Bearer sk-or-secret" }]);
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
      return sse([
        { choices: [{ delta: { role: "assistant", reasoning: "hidden" } }] },
        { choices: [{ delta: { content: "\n\nHello" } }] },
        { choices: [{ delta: { content: " there.\n" } }] },
      ]);
    });
    try {
      const pieces: string[] = [];
      const text = await quickGenerate({ key: "", model: "", prompt: "Say hello" }, (piece) => pieces.push(piece), undefined, homeWith({ config: "CEREBRAS_API_KEY=csk-secret" }));
      expect(models).toEqual(["qwen-3.8-27b"]);
      expect(pieces).toEqual(["Hello", " there.\n"]);
      expect(text).toBe("Hello there.");
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
        const error = await rejection(quickGenerate({ key: "OPENAI_API_KEY", model: "gpt-x", prompt: "hi" }, () => {}, undefined, roots));
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
      const pending = quickGenerate({ key: "", model: "qwen-3.8-27b", prompt: "hi" }, () => {}, caller.signal, roots);
      caller.abort();
      const error = await rejection(pending);
      expect(error.status).toBe(499);
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  test("a provider error mid-stream fails the generation after the text so far", async () => {
    const fetchSpy = mockFetch(async () => sse([
      { choices: [{ delta: { content: "Partial" } }] },
      { error: { message: "Model is overloaded" } },
    ]));
    try {
      const pieces: string[] = [];
      const roots = homeWith({ config: "GROQ_API_KEY=gsk-secret" });
      const error = await rejection(quickGenerate({ key: "", model: "llama", prompt: "hi" }, (piece) => pieces.push(piece), undefined, roots));
      expect(pieces).toEqual(["Partial"]);
      expect(error.status).toBe(502);
      expect(error.message).toBe("Groq stream failed: Model is overloaded");
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
  test("generated text reaches the client while the provider is still streaming", async () => {
    setSetting("quick_generate_enabled", "true");
    const roots = homeWith({});
    const envFile = join(roots.home, "keys.env");
    writeFileSync(envFile, "CEREBRAS_API_KEY=csk-secret");
    setSetting("quick_generate_env_file", envFile);
    const realFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    let finishUpstream = () => {};
    const upstreamFinished = new Promise<void>((resolve) => (finishUpstream = resolve));
    const fetchSpy = mockFetch(async (input, init) => {
      if (!String(input).startsWith("https://api.cerebras.ai/")) return realFetch(input, init);
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "First" } }] })}\n\n`));
          await upstreamFinished;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " second" } }] })}\n\ndata: [DONE]\n\n`));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const server = startCockpitServer(0, buildFetchHandler(4820), "");
    try {
      const response = await realFetch(`http://127.0.0.1:${server.port}/api/quick-generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "CEREBRAS_API_KEY", model: "qwen-3.8-27b", prompt: "hi" }),
      });
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let received = "";
      while (!received.includes("\n")) received += (await reader.read()).value ?? "";
      expect(received).toBe(`${JSON.stringify({ type: "text", text: "First" })}\n`);
      finishUpstream();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value;
      }
      expect(received.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
        { type: "text", text: "First" },
        { type: "text", text: " second" },
        { type: "done", text: "First second" },
      ]);
    } finally {
      finishUpstream();
      fetchSpy.mockRestore();
      server.stop(true);
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

// Public one-pixel PNG from Anthropic's vision documentation.
const png: QuickGenerateAttachment = {
  name: "pixel.png", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
};
const textFile: QuickGenerateAttachment = { name: "note.md", mimeType: "text/markdown", data: Buffer.from("A café in 日本\n").toString("base64") };

function pdfFixture(): QuickGenerateAttachment {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name: "page.pdf", mimeType: "application/pdf", data: Buffer.from(document).toString("base64") };
}

describe("quick generate attachments", () => {
  test("image-only requests deliver real native image content to each vision vendor with its own key", async () => {
    const cases = [
      { key: "OPENAI_API_KEY", model: "gpt-4.1", endpoint: "https://api.openai.com/v1/chat/completions" },
      { key: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-6", endpoint: "https://api.anthropic.com/v1/messages" },
      { key: "GROQ_API_KEY", model: "qwen/qwen3.8-27b", endpoint: "https://api.groq.com/openai/v1/chat/completions" },
      { key: "CEREBRAS_API_KEY", model: "qwen-3.8-27b", endpoint: "https://api.cerebras.ai/v1/chat/completions" },
    ];
    const roots = homeWith({ config: cases.map(({ key }) => `${key}=secret-${key}`).join("\n") });
    for (const item of cases) {
      const fetchSpy = mockFetch(async (url, init) => {
        expect(String(url)).toBe(item.endpoint);
        const headers = new Headers(init?.headers);
        const anthropic = item.key === "ANTHROPIC_API_KEY";
        expect(headers.get(anthropic ? "x-api-key" : "authorization")).toBe(`${anthropic ? "" : "Bearer "}secret-${item.key}`);
        expect(headers.get(anthropic ? "authorization" : "x-api-key")).toBeNull();
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(item.model);
        expect(body.stream).toBe(true);
        expect(body.messages).toEqual([{ role: "user", content: [anthropic
          ? { type: "image", source: { type: "base64", media_type: "image/png", data: png.data } }
          : { type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } },
        ] }]);
        return sse([anthropic ? { type: "content_block_delta", delta: { type: "text_delta", text: "Red" } } : { choices: [{ delta: { content: "Red" } }] }]);
      });
      try {
        expect(await quickGenerate({ key: item.key, model: item.model, prompt: "", attachments: [png] }, () => {}, undefined, roots)).toBe("Red");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    }
  });

  test("PDFs use native documents/files and UTF-8 text stays decoded, ordered and named", async () => {
    const pdf = pdfFixture();
    const roots = homeWith({ config: "OPENAI_API_KEY=sk-openai\nANTHROPIC_API_KEY=sk-anthropic\nCEREBRAS_API_KEY=csk-secret" });
    for (const anthropic of [false, true]) {
      const fetchSpy = mockFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content).toEqual([
          anthropic ? { type: "document", title: pdf.name, source: { type: "base64", media_type: pdf.mimeType, data: pdf.data } }
            : { type: "file", file: { filename: pdf.name, file_data: `data:application/pdf;base64,${pdf.data}` } },
          { type: "text", text: "note.md\nA café in 日本\n" },
          { type: "text", text: "Summarize exactly" },
        ]);
        return sse([anthropic ? { type: "content_block_delta", delta: { text: "Summary" } } : { choices: [{ delta: { content: "Summary" } }] }]);
      });
      try {
        await quickGenerate({ key: anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY", model: anthropic ? "claude-sonnet-4-6" : "gpt-4.1", prompt: "Summarize exactly", attachments: [pdf, textFile] }, () => {}, undefined, roots);
      } finally {
        fetchSpy.mockRestore();
      }
    }
    const fetchSpy = mockFetch(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).messages).toEqual([{ role: "user", content: "note.md\nA café in 日本\n" }]);
      return sse([{ choices: [{ delta: { content: "Read" } }] }]);
    });
    try {
      await quickGenerate({ key: "CEREBRAS_API_KEY", model: "gpt-oss-120b", prompt: "", attachments: [textFile] }, () => {}, undefined, roots);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("invalid encoding, binary content, mismatched types and oversized attachments fail before any network call", async () => {
    const roots = homeWith({ config: "OPENAI_API_KEY=sk-secret" });
    const oversized = { ...textFile, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 65).toString("base64") };
    const fullSize = { ...textFile, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 65).toString("base64") };
    const batches = [
      Array(ATTACHMENT_LIMITS.count + 1).fill(textFile), Array(Math.floor(ATTACHMENT_LIMITS.totalBytes / ATTACHMENT_LIMITS.fileBytes) + 1).fill(fullSize),
      [{ ...png, data: `data:image/png;base64,${png.data}` }], [{ ...png, data: "https://example.com/file" }],
      [{ ...textFile, data: "!!!!" }],
      [{ ...textFile, data: Buffer.from([0xc3, 0x28]).toString("base64") }],
      [{ ...textFile, data: Buffer.from("binary\0data").toString("base64") }],
      [{ ...textFile, mimeType: "application/octet-stream" }],
      [{ ...png, mimeType: "image/jpeg" }],
    ];
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const attachments of batches) {
        const error = await rejection(quickGenerate({ key: "", model: "gpt-4.1", prompt: "", attachments }, () => {}, undefined, roots));
        expect(error.status).toBe(400);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("model and provider restrictions fail before POST without selecting another provider or dropping files", async () => {
    const roots = homeWith({ config: "CEREBRAS_API_KEY=csk-secret\nOPENAI_API_KEY=sk-secret\nGROQ_API_KEY=gsk-secret" });
    const cases = [
      { key: "CEREBRAS_API_KEY", model: "gpt-oss-120b", attachments: [png] },
      { key: "OPENAI_API_KEY", model: "gpt-3.5-turbo", attachments: [png] },
      { key: "GROQ_API_KEY", model: "qwen/qwen3.8-27b", attachments: [pdfFixture()] },
      { key: "CEREBRAS_API_KEY", model: "qwen-3.8-27b", attachments: [png, png, png] },
      { key: "GROQ_API_KEY", model: "qwen/qwen3.8-27b", attachments: [png, png, png, png] },
      { key: "CEREBRAS_API_KEY", model: "qwen-3.8-27b", attachments: [png, { ...textFile, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 65).toString("base64") }, { ...textFile, data: Buffer.alloc(3 * 1024 * 1024, 65).toString("base64") }] },
    ];
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const item of cases) {
        const error = await rejection(quickGenerate({ ...item, prompt: "" }, () => {}, undefined, roots));
        expect(error.status).toBe(400);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("request parsing accepts image-only prompts and rejects malformed attachment structures", async () => {
    expect(parseQuickGenerateRequest({ key: " OPENAI_API_KEY ", model: " gpt-4.1 ", prompt: "", attachments: [png] })).toEqual({
      key: "OPENAI_API_KEY", model: "gpt-4.1", prompt: "", attachments: [png],
    });
    setSetting("quick_generate_enabled", "true");
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      for (const attachments of [null, {}, [null], [{ name: "bad", mimeType: "image/png", data: 42 }]]) {
        const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/quick-generate", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "", attachments }),
        }));
        expect(response.status).toBe(400);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("quick generate attachment boundaries and streaming", () => {
  test("the exact shared count, file-byte and total-byte boundaries are accepted", async () => {
    const roots = homeWith({ config: "OPENAI_API_KEY=sk-secret" });
    const fetchSpy = mockFetch(async () => sse([{ choices: [{ delta: { content: "Read" } }] }]));
    try {
      const fullSize = { ...textFile, data: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 65).toString("base64") };
      for (const attachments of [Array(ATTACHMENT_LIMITS.count).fill(textFile), Array(4).fill(fullSize), [{ ...textFile, data: "" }]]) {
        expect(await quickGenerate({ key: "", model: "gpt-4.1", prompt: "", attachments }, () => {}, undefined, roots)).toBe("Read");
      }
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("Cerebras rejects a valid but unsupported GIF and enforces exact serialized payload bytes before POST", async () => {
    const roots = homeWith({ config: "CEREBRAS_API_KEY=csk-secret" });
    const gif = { name: "pixel.gif", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" };
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const unsupported = await rejection(quickGenerate({ key: "", model: "qwen-3.8-27b", prompt: "", attachments: [gif] }, () => {}, undefined, roots));
      expect(unsupported.status).toBe(400);
      const oversized = await rejection(quickGenerate({
        key: "", model: "qwen-3.8-27b", prompt: "",
        attachments: [png, { ...textFile, name: "a".repeat(10 * 1024 * 1024) }],
      }, () => {}, undefined, roots));
      expect(oversized.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("HTTP generation accepts image metadata trailers and UTF-8 terminal logs", async () => {
    setSetting("quick_generate_enabled", "true");
    const roots = homeWith({ config: "GROQ_API_KEY=gsk-test-secret" });
    setSetting("quick_generate_env_file", join(roots.configHome, ".env"));
    const attachments = [
      { ...png, data: Buffer.concat([Buffer.from(png.data, "base64"), Buffer.from("image metadata")]).toString("base64") },
      { ...textFile, data: Buffer.from("\u001b[32mInspection WREN-52\u001b[0m").toString("base64") },
    ];
    const fetchSpy = mockFetch(async () => sse([{ choices: [{ delta: { content: "Accepted" } }] }]));
    try {
      const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/quick-generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "GROQ_API_KEY", model: "qwen/qwen3.8-27b", prompt: "Read these files", attachments }),
      }));
      const events = (await response.text()).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(response.status).toBe(200);
      expect(events.at(-1)).toEqual({ type: "done", text: "Accepted" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("HTTP parsing delivers attachments into the native request and preserves partial NDJSON text on a provider error", async () => {
    setSetting("quick_generate_enabled", "true");
    const roots = homeWith({});
    const envFile = join(roots.home, "keys.env");
    writeFileSync(envFile, "OPENAI_API_KEY=sk-private-test-secret");
    setSetting("quick_generate_env_file", envFile);
    const fetchSpy = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
      expect(JSON.parse(String(init?.body)).messages[0].content).toEqual([
        { type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } },
      ]);
      return sse([
        { choices: [{ delta: { content: "Partial" } }] },
        { error: { message: "Provider rejected sk-private-test-secret after first token" } },
      ]);
    });
    try {
      const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/quick-generate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "OPENAI_API_KEY", model: "gpt-4.1", prompt: "", attachments: [png] }),
      }));
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      expect((await response.text()).trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
        { type: "text", text: "Partial" },
        { type: "error", message: "OpenAI stream failed: Provider rejected [redacted] after first token" },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

});

function openRouterModel(id: string, inputs: string[], outputs = ["text"]) {
  return { id, name: id, architecture: { input_modalities: inputs, output_modalities: outputs } };
}

describe("OpenRouter attachment capabilities and delivery", () => {
  test("catalog modalities, not model names, advertise image/native PDF support and require text output", async () => {
    const roots = homeWith({ config: "OPENROUTER_API_KEY=sk-or-secret" });
    const fetchSpy = mockFetch(async () => Response.json({ data: [
      openRouterModel("unknown-author/native-document", ["text", "file"]),
      openRouterModel("unknown-author/vision", ["text", "image"]),
      openRouterModel("unknown-author/image-only-input", ["image"]),
      openRouterModel("google/gemini-text-only", ["text"]),
      openRouterModel("unknown-author/multimodal", ["text", "image", "file"]),
      openRouterModel("unknown-author/image-generator", ["text", "image"], ["image"]),
      { id: "unknown-author/missing-output", architecture: { input_modalities: ["image", "file"] } },
    ] }));
    try {
      const models = await quickGenerateModels("OPENROUTER_API_KEY", undefined, roots);
      expect(models).toEqual([
        { id: "unknown-author/native-document", label: "unknown-author/native-document", inputs: ["text", "pdf"] },
        { id: "unknown-author/vision", label: "unknown-author/vision", inputs: ["text", "image"] },
        { id: "unknown-author/image-only-input", label: "unknown-author/image-only-input", inputs: ["image"] },
        { id: "google/gemini-text-only", label: "google/gemini-text-only", inputs: ["text"] },
        { id: "unknown-author/multimodal", label: "unknown-author/multimodal", inputs: ["text", "image", "pdf"] },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("binary generation revalidates current catalog per request and sends native content only to OpenRouter with its key", async () => {
    const roots = homeWith({ config: "OPENROUTER_API_KEY=sk-or-secret\nOPENAI_API_KEY=sk-other\nANTHROPIC_API_KEY=sk-ant-other" });
    const calls: string[] = [];
    const pdf = pdfFixture();
    const fetchSpy = mockFetch(async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-or-secret");
      expect(new Headers(init?.headers).get("x-api-key")).toBeNull();
      if (String(url) === "https://openrouter.ai/api/v1/models") {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return Response.json({ data: [openRouterModel("vendor/native", ["text", "image", "file"])] });
      }
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("vendor/native");
      expect(body.stream).toBe(true);
      if (calls.length === 2) {
        expect(body.messages[0].content).toEqual([
          { type: "file", file: { filename: pdf.name, file_data: `data:application/pdf;base64,${pdf.data}` } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } },
          { type: "text", text: "Describe both" },
        ]);
        expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
      } else {
        expect(body.messages[0].content).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${png.data}` } }]);
        expect(body.plugins).toBeUndefined();
      }
      return sse([{ choices: [{ delta: { content: "Read" } }] }]);
    });
    try {
      await quickGenerate({ key: "OPENROUTER_API_KEY", model: "vendor/native", prompt: "Describe both", attachments: [pdf, png] }, () => {}, undefined, roots);
      await quickGenerate({ key: "OPENROUTER_API_KEY", model: "vendor/native", prompt: "", attachments: [png] }, () => {}, undefined, roots);
      expect(calls).toEqual([
        "https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/chat/completions",
        "https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/chat/completions",
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });


  test("unknown, unsupported and non-text-output models are refused after GET without any provider POST", async () => {
    const roots = homeWith({ config: "OPENROUTER_API_KEY=sk-or-secret" });
    const fetchSpy = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
      expect(init?.method).toBe("GET");
      return Response.json({ data: [
        openRouterModel("google/gemini-text-only", ["text"]),
        openRouterModel("vendor/vision-no-native-files", ["text", "image"]),
        openRouterModel("vendor/non-chat-output", ["text", "image", "file"], ["image"]),
      ] });
    });
    try {
      const cases = [
        { model: "vendor/not-listed", attachments: [png] },
        { model: "google/gemini-text-only", attachments: [png] },
        { model: "vendor/vision-no-native-files", attachments: [pdfFixture()] },
        { model: "vendor/non-chat-output", attachments: [pdfFixture()] },
      ];
      for (const input of cases) {
        const error = await rejection(quickGenerate({ ...input, key: "", prompt: "" }, () => {}, undefined, roots));
        expect(error.status).toBe(400);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(cases.length);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("named-model text and UTF-8 attachment requests retain the no-catalog text flow", async () => {
    const roots = homeWith({ config: "OPENROUTER_API_KEY=sk-or-secret" });
    const fetchSpy = mockFetch(async (url, init) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("vendor/text");
      expect(body.plugins).toBeUndefined();
      return sse([{ choices: [{ delta: { content: "Read" } }] }]);
    });
    try {
      await quickGenerate({ key: "", model: "vendor/text", prompt: "Original prompt" }, () => {}, undefined, roots);
      await quickGenerate({ key: "", model: "vendor/text", prompt: "", attachments: [textFile] }, () => {}, undefined, roots);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

});
