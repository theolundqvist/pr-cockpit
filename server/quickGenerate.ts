import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { readSettings } from "./settings.ts";

export interface QuickGenerateRoots {
  home: string;
  configHome: string;
  processEnv: Record<string, string | undefined>;
}

// Key values stay in memory per request and are never copied into process.env, which agents and actions inherit.
export function systemRoots(): QuickGenerateRoots {
  const home = homedir();
  const xdg = Bun.env.XDG_CONFIG_HOME;
  return { home, configHome: xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), processEnv: Bun.env };
}

// Bun.serve closes a connection idle for 30s, so one deadline covers optional model discovery plus generation
// and must fail visibly before that.
const GENERATE_TIMEOUT_MS = 25_000;
const MODELS_TIMEOUT_MS = 10_000;
const MAX_PROMPT_CHARS = 100_000;
const ANTHROPIC_MAX_TOKENS = 4096;

export type ProviderId = "cerebras" | "openai" | "anthropic" | "groq";

// Only these vendors' fixed endpoints ever receive a key, and only the key named for that vendor.
const PROVIDERS: Record<ProviderId, { label: string; envPrefix: string; baseUrl: string }> = {
  cerebras: { label: "Cerebras", envPrefix: "CEREBRAS", baseUrl: "https://api.cerebras.ai/v1" },
  openai: { label: "OpenAI", envPrefix: "OPENAI", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", envPrefix: "ANTHROPIC", baseUrl: "https://api.anthropic.com/v1" },
  groq: { label: "Groq", envPrefix: "GROQ", baseUrl: "https://api.groq.com/openai/v1" },
};
const PROVIDER_ORDER: ProviderId[] = ["cerebras", "openai", "anthropic", "groq"];
const KEY_NAME_RE = /^(CEREBRAS|OPENAI|ANTHROPIC|GROQ)_API_KEY(?:_([A-Z0-9][A-Z0-9_]*))?$/;

export interface DetectedKey {
  id: string;
  provider: ProviderId;
  label: string;
  secret: string;
}

export class QuickGenerateError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function envFiles(roots: QuickGenerateRoots): { files: string[]; explicit: boolean } {
  const configured = readSettings().quick_generate_env_file;
  if (configured === "") {
    return { files: [...new Set([join(roots.configHome, ".env"), join(roots.home, ".env")])], explicit: false };
  }
  const expanded = configured.replace(
    /^(?:~|\$HOME|\$\{HOME\}|\$XDG_CONFIG_HOME|\$\{XDG_CONFIG_HOME\})(?=\/|$)/,
    (root) => root.includes("XDG") ? roots.configHome : roots.home,
  );
  if (!isAbsolute(expanded)) throw new QuickGenerateError(400, `Env file ${configured} must be an absolute path.`);
  return { files: [resolve(expanded)], explicit: true };
}

// Earlier sources win: the key file(s) in order, then the server's own environment.
export function readKeySources(roots: QuickGenerateRoots): { sources: Array<Map<string, string>>; files: string[] } {
  const { files, explicit } = envFiles(roots);
  const readFiles: string[] = [];
  const sources: Array<Map<string, string>> = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
      if (code === "ENOENT" && !explicit) continue;
      throw new QuickGenerateError(400, code === "ENOENT" ? `Env file ${file} does not exist.` : `Couldn't read env file ${file} (${code}).`);
    }
    readFiles.push(file);
    sources.push(new Map(Object.entries(parseEnv(text) as Record<string, string>)));
  }
  sources.push(new Map(Object.entries(roots.processEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
  return { sources, files: readFiles };
}

export function detectKeys(roots: QuickGenerateRoots): { keys: DetectedKey[]; files: string[] } {
  const { sources, files: readFiles } = readKeySources(roots);
  const keys = new Map<string, DetectedKey>();
  for (const source of sources) {
    for (const [name, value] of source) {
      const match = KEY_NAME_RE.exec(name);
      const secret = value.trim();
      if (!match || secret === "" || keys.has(name)) continue;
      const provider = PROVIDER_ORDER.find((id) => PROVIDERS[id].envPrefix === match[1])!;
      const suffix = match[2]?.toLowerCase().split("_").filter(Boolean).join(" ");
      keys.set(name, {
        id: name,
        provider,
        label: suffix ? `${PROVIDERS[provider].label} (${suffix})` : PROVIDERS[provider].label,
        secret,
      });
    }
  }
  const sorted = [...keys.values()].sort((a, b) =>
    PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider)
    || a.id.length - b.id.length
    || a.id.localeCompare(b.id)
  );
  return { keys: sorted, files: readFiles };
}

function resolveKey(keys: DetectedKey[], requested: string): DetectedKey {
  const saved = readSettings().quick_generate_key;
  const name = requested || (keys.some((key) => key.id === saved) ? saved : keys[0]?.id);
  const key = keys.find((candidate) => candidate.id === name);
  if (!key) {
    throw new QuickGenerateError(400, name ? `API key ${name} is not configured.` : "No supported API key is configured.");
  }
  return key;
}

export function quickGenerateConfig(roots: QuickGenerateRoots = systemRoots()): {
  keys: Array<{ id: string; provider: string; label: string }>;
  defaultKey: string;
  defaultModel: string;
  envFiles: string[];
  defaultEnvFile: string;
} {
  const { keys, files } = detectKeys(roots);
  const settings = readSettings();
  const defaultKey = keys.some((key) => key.id === settings.quick_generate_key) ? settings.quick_generate_key : keys[0]?.id ?? "";
  // A saved model is only valid for the saved key's provider.
  const savedKeyApplies = defaultKey !== "" && (settings.quick_generate_key === "" || settings.quick_generate_key === defaultKey);
  return {
    keys: keys.map(({ id, provider, label }) => ({ id, provider, label })),
    defaultKey,
    defaultModel: savedKeyApplies ? settings.quick_generate_model : "",
    envFiles: files,
    defaultEnvFile: join(roots.configHome, ".env"),
  };
}

function redact(text: string, secret: string): string {
  return text
    .split(secret).join("[redacted]")
    .replace(/\b(?:sk|csk|gsk)[-_][A-Za-z0-9*_.-]{6,}/g, "[redacted]")
    .slice(0, 300);
}

export interface Deadline {
  signal: AbortSignal;
  ms: number;
}

export interface Vendor {
  label: string;
  baseUrl: string;
  headers: Record<string, string>;
}

function vendorFor(key: DetectedKey): Vendor {
  const { label, baseUrl } = PROVIDERS[key.provider];
  const headers: Record<string, string> = key.provider === "anthropic"
    ? { "x-api-key": key.secret, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key.secret}` };
  return { label, baseUrl, headers };
}

export function providerFetch(
  key: DetectedKey,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return vendorFetch(vendorFor(key), key.id, key.secret, path, init, deadline, signal);
}

// Server-sent events from an OpenAI-compatible stream; each `data:` payload goes to onData as parsed JSON.
export function providerStream(
  key: DetectedKey,
  path: string,
  body: unknown,
  deadline: Deadline,
  signal: AbortSignal | undefined,
  onData: (data: unknown) => void,
): Promise<void> {
  return vendorRequest(vendorFor(key), key.id, key.secret, path, { method: "POST", body }, deadline, signal, async (response) => {
    if (!response.body) throw new QuickGenerateError(502, `${PROVIDERS[key.provider].label} returned an empty stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop()!;
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (data === "[DONE]") return;
        if (data) onData(JSON.parse(data));
      }
      if (done) return;
    }
  });
}

export function vendorFetch(
  vendor: Vendor,
  keyName: string,
  secret: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return vendorRequest(vendor, keyName, secret, path, init, deadline, signal, async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new QuickGenerateError(502, `${vendor.label} returned a non-JSON response.`);
    }
  });
}

async function vendorRequest<T>(
  vendor: Vendor,
  keyName: string,
  secret: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  deadline: Deadline,
  signal: AbortSignal | undefined,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const headers = { ...vendor.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const timeout = deadline.signal;
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${vendor.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) return await read(response);
    text = await response.text();
  } catch (error) {
    if (error instanceof QuickGenerateError) throw error;
    if (timeout.aborted) throw new QuickGenerateError(504, `${vendor.label} did not answer within ${deadline.ms / 1000}s.`);
    if (signal?.aborted) throw new QuickGenerateError(499, "Request cancelled.");
    const reason = error instanceof Error ? error.message : String(error);
    throw new QuickGenerateError(502, `Couldn't reach ${vendor.label}: ${redact(reason, secret)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new QuickGenerateError(502, `${vendor.label} rejected ${keyName} (HTTP ${response.status}).`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const error = field(body, "error");
  const nested = typeof error === "string" ? error : field(error, "message");
  const message = field(body, "message");
  const detail = typeof nested === "string" ? nested : typeof message === "string" ? message : "";
  const suffix = detail ? `: ${redact(detail, secret)}` : ".";
  throw new QuickGenerateError(502, `${vendor.label} request failed (HTTP ${response.status})${suffix}`);
}

export function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

// OpenAI's catalog also lists embedding, audio, image, and Responses-only models that chat completions reject.
const OPENAI_CHAT_MODEL_RE = /^(?:gpt-|o\d|chatgpt-)/;
const OPENAI_NON_CHAT_RE = /audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|-pro(?:-|$)/;
// Groq lists speech and transcription models (told apart by output_modalities) and prompt-guard classifiers.
const GROQ_NON_CHAT_RE = /guard/;

export async function fetchModels(
  key: DetectedKey,
  signal: AbortSignal | undefined,
  deadline: Deadline = { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS), ms: MODELS_TIMEOUT_MS },
): Promise<Array<{ id: string; label: string }>> {
  const body = await providerFetch(key, key.provider === "anthropic" ? "/models?limit=1000" : "/models", { method: "GET" }, deadline, signal);
  const data = field(body, "data");
  const models = (Array.isArray(data) ? data : []).flatMap((entry: unknown) => {
    const id = field(entry, "id");
    if (typeof id !== "string" || id === "") return [];
    if (key.provider === "openai" && (!OPENAI_CHAT_MODEL_RE.test(id) || OPENAI_NON_CHAT_RE.test(id))) return [];
    const outputs = field(entry, "output_modalities");
    if (key.provider === "groq" && (
      field(entry, "active") === false
      || (Array.isArray(outputs) && !outputs.includes("text"))
      || GROQ_NON_CHAT_RE.test(id)
    )) return [];
    const displayName = field(entry, "display_name");
    const created = field(entry, "created");
    return [{
      id,
      label: typeof displayName === "string" && displayName ? displayName : id,
      created: typeof created === "number" ? created : 0,
      preferred: key.provider === "cerebras" && /qwen/i.test(id),
    }];
  });
  models.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.created - a.created);
  return models.map(({ id, label }) => ({ id, label }));
}

export async function quickGenerateModels(
  keyName: string,
  signal?: AbortSignal,
  roots: QuickGenerateRoots = systemRoots(),
): Promise<Array<{ id: string; label: string }>> {
  return fetchModels(resolveKey(detectKeys(roots).keys, keyName), signal);
}

export async function quickGenerate(
  input: { key: string; model: string; prompt: string },
  signal?: AbortSignal,
  roots: QuickGenerateRoots = systemRoots(),
): Promise<string> {
  if (input.prompt.trim() === "") throw new QuickGenerateError(400, "Prompt is empty.");
  if (input.prompt.length > MAX_PROMPT_CHARS) throw new QuickGenerateError(400, "Prompt is too long.");
  const key = resolveKey(detectKeys(roots).keys, input.key);
  const label = PROVIDERS[key.provider].label;
  const deadline: Deadline = { signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS), ms: GENERATE_TIMEOUT_MS };
  let model = input.model;
  if (model === "") {
    model = (await fetchModels(key, signal, deadline))[0]?.id ?? "";
    if (model === "") throw new QuickGenerateError(502, `${label} listed no usable models.`);
  }
  const messages = [{ role: "user", content: input.prompt }];
  let text: unknown;
  if (key.provider === "anthropic") {
    const body = await providerFetch(key, "/messages", {
      method: "POST",
      body: { model, max_tokens: ANTHROPIC_MAX_TOKENS, messages },
    }, deadline, signal);
    const content = field(body, "content");
    text = Array.isArray(content)
      ? content.map((part: unknown) => field(part, "type") === "text" ? field(part, "text") : "")
        .filter((part): part is string => typeof part === "string").join("")
      : undefined;
  } else {
    const body = await providerFetch(key, "/chat/completions", {
      method: "POST",
      body: { model, messages, stream: false },
    }, deadline, signal);
    const choices = field(body, "choices");
    text = field(field(Array.isArray(choices) ? choices[0] : undefined, "message"), "content");
  }
  if (typeof text !== "string" || text.trim() === "") throw new QuickGenerateError(502, `${label} returned no text.`);
  return text.trim();
}
