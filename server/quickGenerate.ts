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
function systemRoots(): QuickGenerateRoots {
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

type ProviderId = "cerebras" | "openai" | "anthropic" | "groq";

// Only these vendors' fixed endpoints ever receive a key, and only the key named for that vendor.
const PROVIDERS: Record<ProviderId, { label: string; envPrefix: string; baseUrl: string }> = {
  cerebras: { label: "Cerebras", envPrefix: "CEREBRAS", baseUrl: "https://api.cerebras.ai/v1" },
  openai: { label: "OpenAI", envPrefix: "OPENAI", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", envPrefix: "ANTHROPIC", baseUrl: "https://api.anthropic.com/v1" },
  groq: { label: "Groq", envPrefix: "GROQ", baseUrl: "https://api.groq.com/openai/v1" },
};
const PROVIDER_ORDER: ProviderId[] = ["cerebras", "openai", "anthropic", "groq"];
const KEY_NAME_RE = /^(CEREBRAS|OPENAI|ANTHROPIC|GROQ)_API_KEY(?:_([A-Z0-9][A-Z0-9_]*))?$/;

interface DetectedKey {
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

function detectKeys(roots: QuickGenerateRoots): { keys: DetectedKey[]; files: string[] } {
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

interface Deadline {
  signal: AbortSignal;
  ms: number;
}

async function providerFetch(
  key: DetectedKey,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  deadline: Deadline,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const provider = PROVIDERS[key.provider];
  const headers: Record<string, string> = key.provider === "anthropic"
    ? { "x-api-key": key.secret, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key.secret}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const timeout = deadline.signal;
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${provider.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    text = await response.text();
  } catch (error) {
    if (timeout.aborted) throw new QuickGenerateError(504, `${provider.label} did not answer within ${deadline.ms / 1000}s.`);
    if (signal?.aborted) throw new QuickGenerateError(499, "Request cancelled.");
    const reason = error instanceof Error ? error.message : String(error);
    throw new QuickGenerateError(502, `Couldn't reach ${provider.label}: ${redact(reason, key.secret)}`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new QuickGenerateError(502, `${provider.label} rejected ${key.id} (HTTP ${response.status}).`);
    }
    const error = field(body, "error");
    const nested = typeof error === "string" ? error : field(error, "message");
    const message = field(body, "message");
    const detail = typeof nested === "string" ? nested : typeof message === "string" ? message : "";
    const suffix = detail ? `: ${redact(detail, key.secret)}` : ".";
    throw new QuickGenerateError(502, `${provider.label} request failed (HTTP ${response.status})${suffix}`);
  }
  if (body === null) throw new QuickGenerateError(502, `${provider.label} returned a non-JSON response.`);
  return body;
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

// OpenAI's catalog also lists embedding, audio, image, and Responses-only models that chat completions reject.
const OPENAI_CHAT_MODEL_RE = /^(?:gpt-|o\d|chatgpt-)/;
const OPENAI_NON_CHAT_RE = /audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|-pro(?:-|$)/;
// Groq lists speech and transcription models (told apart by output_modalities) and prompt-guard classifiers.
const GROQ_NON_CHAT_RE = /guard/;

async function fetchModels(
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
