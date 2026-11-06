import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { readSettings } from "./settings.ts";
import { ATTACHMENT_LIMITS, attachmentKind, hasAttachmentSignature } from "../shared/quickGenerateAttachments.js";

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

export type ProviderId = "cerebras" | "openai" | "anthropic" | "groq" | "openrouter";

// Only these vendors' fixed endpoints ever receive a key, and only the key named for that vendor.
const PROVIDERS: Record<ProviderId, { label: string; envPrefix: string; baseUrl: string }> = {
  cerebras: { label: "Cerebras", envPrefix: "CEREBRAS", baseUrl: "https://api.cerebras.ai/v1" },
  openai: { label: "OpenAI", envPrefix: "OPENAI", baseUrl: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", envPrefix: "ANTHROPIC", baseUrl: "https://api.anthropic.com/v1" },
  groq: { label: "Groq", envPrefix: "GROQ", baseUrl: "https://api.groq.com/openai/v1" },
  openrouter: { label: "OpenRouter", envPrefix: "OPENROUTER", baseUrl: "https://openrouter.ai/api/v1" },
};
const PROVIDER_ORDER: ProviderId[] = ["cerebras", "openai", "anthropic", "groq", "openrouter"];
const KEY_NAME_RE = /^(CEREBRAS|OPENAI|ANTHROPIC|GROQ|OPENROUTER)_API_KEY(?:_([A-Z0-9][A-Z0-9_]*))?$/;

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

export type ModelInput = "text" | "image" | "pdf";
export interface QuickGenerateModel {
  id: string;
  label: string;
  inputs: ModelInput[];
  attachmentLimits?: { imageCount?: number; totalBytes?: number; imageMimeTypes?: string[] };
}
export interface QuickGenerateAttachment {
  name: string;
  mimeType: string;
  data: string;
}
export interface QuickGenerateInput {
  key: string;
  model: string;
  prompt: string;
  attachments?: QuickGenerateAttachment[];
}

export function parseQuickGenerateRequest(body: unknown): QuickGenerateInput {
  const key = field(body, "key") === undefined ? "" : field(body, "key");
  const model = field(body, "model") === undefined ? "" : field(body, "model");
  const prompt = field(body, "prompt");
  const attachments = field(body, "attachments");
  if (typeof key !== "string" || typeof model !== "string" || typeof prompt !== "string") {
    throw new QuickGenerateError(400, "Invalid quick generate request.");
  }
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some((attachment) =>
    typeof field(attachment, "name") !== "string" || !field(attachment, "name")
    || typeof field(attachment, "mimeType") !== "string" || typeof field(attachment, "data") !== "string"
  ))) {
    throw new QuickGenerateError(400, "Each attachment needs a name, file type, and base64 file content.");
  }
  return { key: key.trim(), model: model.trim(), prompt, attachments: attachments as QuickGenerateAttachment[] | undefined };
}

interface ValidatedAttachment extends QuickGenerateAttachment {
  kind: ModelInput;
  bytes: number;
  text?: string;
}

function validateAttachments(attachments: QuickGenerateAttachment[] = []): ValidatedAttachment[] {
  if (attachments.length > ATTACHMENT_LIMITS.count) {
    throw new QuickGenerateError(400, `Attach at most ${ATTACHMENT_LIMITS.count} files.`);
  }
  let totalBytes = 0;
  return attachments.map((attachment) => {
    const mimeType = attachment.mimeType.split(";", 1)[0]!.trim().toLowerCase();
    const kind = attachmentKind(mimeType);
    if (!kind) throw new QuickGenerateError(400, "Unsupported attachment. Use PNG, JPEG, WebP, GIF, PDF, or UTF-8 text.");
    const data = attachment.data;
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const size = data.length / 4 * 3 - padding;
    if (size > ATTACHMENT_LIMITS.fileBytes) throw new QuickGenerateError(400, "Each attachment must be 5 MiB or smaller.");
    totalBytes += size;
    if (totalBytes > ATTACHMENT_LIMITS.totalBytes) throw new QuickGenerateError(400, "Attachments must total 20 MiB or less.");
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new QuickGenerateError(400, "Attachment content must be raw base64, not a URL.");
    }
    const bytes = Buffer.from(data, "base64");
    if (kind === "text") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new QuickGenerateError(400, "Text attachments must contain valid UTF-8.");
      }
      if (text.includes("\0")) throw new QuickGenerateError(400, "Binary files cannot be attached as text.");
      return { ...attachment, mimeType, kind, bytes: bytes.length, text };
    }
    if (!hasAttachmentSignature(bytes, mimeType)) throw new QuickGenerateError(400, "Attachment content does not match its image or PDF file type.");
    return { ...attachment, mimeType, kind, bytes: bytes.length };
  });
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

// Server-sent events from a provider stream; each `data:` payload goes to onData as parsed JSON.
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
  const requestBody = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const timeout = deadline.signal;
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${vendor.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: requestBody,
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

// Vendor documentation is the source of truth; an unfamiliar family stays text-only.
// OpenAI: /api/docs/models and /api/docs/guides/file-inputs (vision models accept PDFs).
// Anthropic: /docs/en/build-with-claude/{vision,pdf-support} (all active Claude models).
// Groq: https://console.groq.com/docs/vision (these two documented vision models, no PDFs).
// Cerebras: https://inference-docs.cerebras.ai/capabilities/image-inputs (Qwen PNG/JPEG).
// OpenRouter: /docs/api/api-reference/models/list-all-models-and-their-properties;
// /docs/guides/overview/multimodal/pdfs requires engine "native" to prohibit OCR fallback.
function modelCapabilities(provider: ProviderId, model: string, metadata?: unknown): Pick<QuickGenerateModel, "inputs" | "attachmentLimits"> {
  if (provider === "openrouter") {
    // Named-model text generation keeps its existing no-discovery path.
    if (metadata === undefined) return { inputs: ["text"] };
    // Catalog modalities, not author/model-name guesses. "file" is native PDF support;
    // generation pins the native engine so OpenRouter cannot silently substitute OCR.
    const modalities = field(field(metadata, "architecture"), "input_modalities");
    const inputs: ModelInput[] = [];
    if (Array.isArray(modalities) && modalities.includes("text")) inputs.push("text");
    if (Array.isArray(modalities) && modalities.includes("image")) inputs.push("image");
    if (Array.isArray(modalities) && modalities.includes("file")) inputs.push("pdf");
    return { inputs };
  }
  if (provider === "anthropic" && /^claude-(?:3|opus-|sonnet-|haiku-|fable-|mythos-)/.test(model)) return { inputs: ["text", "image", "pdf"] };
  if (provider === "openai" && !OPENAI_NON_CHAT_RE.test(model) && (
    /^gpt-(?:4o|4\.1|4\.5|5(?:\.\d+)?|6(?:\.1)?)(?:-|$)/.test(model)
    || /^(?:o1|o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    || model === "chatgpt-4o-latest"
  )) return { inputs: ["text", "image", "pdf"] };
  if (provider === "groq" && (model === "qwen/qwen3.8-27b" || model === "meta-models/muse-spark-open")) {
    return { inputs: ["text", "image"], attachmentLimits: model === "qwen/qwen3.8-27b"
      ? { imageCount: 3, totalBytes: 13 * 1024 * 1024 }
      : { imageCount: 5 } };
  }
  if (provider === "cerebras" && model === "qwen-3.8-27b") {
    // Account tier is unknown: Free Trial allows two images; base64 and prompt need request headroom.
    return { inputs: ["text", "image"], attachmentLimits: { imageCount: 2, totalBytes: 7 * 1024 * 1024, imageMimeTypes: ["image/png", "image/jpeg"] } };
  }
  return { inputs: ["text"] };
}

function attachmentContent(provider: ProviderId, prompt: string, attachments: ValidatedAttachment[]): string | unknown[] {
  if (attachments.length === 0) return prompt;
  if (attachments.every((attachment) => attachment.kind === "text")) return [
    ...attachments.map((attachment) => `${attachment.name}\n${attachment.text}`),
    ...(prompt.trim() ? [prompt] : []),
  ].join("\n\n");
  const content: unknown[] = attachments.map((attachment) => {
    if (attachment.kind === "text") return { type: "text", text: `${attachment.name}\n${attachment.text}` };
    if (provider === "anthropic") {
      return {
        type: attachment.kind === "image" ? "image" : "document",
        ...(attachment.kind === "pdf" ? { title: attachment.name } : {}),
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
      };
    }
    if (attachment.kind === "image") return {
      type: "image_url", image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
    };
    return { type: "file", file: { filename: attachment.name, file_data: `data:application/pdf;base64,${attachment.data}` } };
  });
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  return content;
}

export async function fetchModels(
  key: DetectedKey,
  signal: AbortSignal | undefined,
  deadline: Deadline = { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS), ms: MODELS_TIMEOUT_MS },
): Promise<QuickGenerateModel[]> {
  const body = await providerFetch(key, key.provider === "anthropic" ? "/models?limit=1000" : "/models", { method: "GET" }, deadline, signal);
  const data = field(body, "data");
  const models = (Array.isArray(data) ? data : []).flatMap((entry: unknown) => {
    const id = field(entry, "id");
    if (typeof id !== "string" || id === "") return [];
    if (key.provider === "openrouter") {
      const outputs = field(field(entry, "architecture"), "output_modalities");
      if (!Array.isArray(outputs) || !outputs.includes("text")) return [];
    }
    if (key.provider === "openai" && (!OPENAI_CHAT_MODEL_RE.test(id) || OPENAI_NON_CHAT_RE.test(id))) return [];
    const outputs = field(entry, "output_modalities");
    if (key.provider === "groq" && (
      field(entry, "active") === false
      || (Array.isArray(outputs) && !outputs.includes("text"))
      || GROQ_NON_CHAT_RE.test(id)
    )) return [];
    const displayName = field(entry, key.provider === "openrouter" ? "name" : "display_name");
    const created = field(entry, "created");
    return [{
      id,
      label: typeof displayName === "string" && displayName ? displayName : id,
      ...modelCapabilities(key.provider, id, entry),
      created: typeof created === "number" ? created : 0,
      // The newest OpenRouter listing is often a multimodal preview; its Auto Router is the sensible default.
      preferred: key.provider === "cerebras" ? /qwen/i.test(id) : key.provider === "openrouter" && id === "openrouter/auto",
    }];
  });
  models.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.created - a.created);
  return models.map(({ id, label, inputs, attachmentLimits }) => ({ id, label, inputs, ...(attachmentLimits ? { attachmentLimits } : {}) }));
}

export async function quickGenerateModels(
  keyName: string,
  signal?: AbortSignal,
  roots: QuickGenerateRoots = systemRoots(),
): Promise<QuickGenerateModel[]> {
  return fetchModels(resolveKey(detectKeys(roots).keys, keyName), signal);
}

export async function quickGenerate(
  input: QuickGenerateInput,
  onText: (text: string) => void,
  signal?: AbortSignal,
  roots: QuickGenerateRoots = systemRoots(),
): Promise<string> {
  const attachments = validateAttachments(input.attachments);
  if (input.prompt.trim() === "" && attachments.length === 0) throw new QuickGenerateError(400, "Prompt is empty.");
  if (input.prompt.length > MAX_PROMPT_CHARS) throw new QuickGenerateError(400, "Prompt is too long.");
  const key = resolveKey(detectKeys(roots).keys, input.key);
  const label = PROVIDERS[key.provider].label;
  const deadline: Deadline = { signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS), ms: GENERATE_TIMEOUT_MS };
  let model = input.model;
  let models: QuickGenerateModel[] | undefined;
  if (model === "") {
    models = await fetchModels(key, signal, deadline);
    model = models[0]?.id ?? "";
    if (model === "") throw new QuickGenerateError(502, `${label} listed no usable models.`);
  }
  let capabilities = modelCapabilities(key.provider, model);
  if (key.provider === "openrouter" && attachments.some((attachment) => attachment.kind !== "text")) {
    // Validate each binary request against current vendor metadata under the generation's
    // existing deadline. Default-model discovery already supplied this request's catalog.
    models ??= await fetchModels(key, signal, deadline);
    const selected = models.find((candidate) => candidate.id === model);
    if (!selected) throw new QuickGenerateError(400, "The selected OpenRouter model is no longer available for attachments. Choose a listed image- or PDF-capable model; nothing has been sent.");
    capabilities = selected;
  }
  const { inputs, attachmentLimits } = capabilities;
  const unsupported = attachments.find((attachment) => !inputs.includes(attachment.kind));
  if (unsupported) throw new QuickGenerateError(400, `${label}'s selected model does not support ${unsupported.kind === "pdf" ? "PDFs" : unsupported.kind === "image" ? "images" : "text files"}. Choose a model that supports this attachment; nothing has been sent.`);
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  if (attachmentLimits?.imageCount !== undefined && imageCount > attachmentLimits.imageCount) {
    throw new QuickGenerateError(400, `This ${label} model accepts at most ${attachmentLimits.imageCount} images per request.`);
  }
  if (attachmentLimits?.imageMimeTypes && attachments.some((attachment) =>
    attachment.kind === "image" && !attachmentLimits.imageMimeTypes!.includes(attachment.mimeType)
  )) throw new QuickGenerateError(400, `${label} accepts ${attachmentLimits.imageMimeTypes.map((mime) => mime.split("/")[1]!.toUpperCase()).join(", ")} images for this model.`);
  if (attachmentLimits?.totalBytes !== undefined && attachments.reduce((total, attachment) => total + attachment.bytes, 0) > attachmentLimits.totalBytes) {
    throw new QuickGenerateError(400, `This ${label} model accepts at most ${attachmentLimits.totalBytes / 1024 / 1024} MiB of attachments.`);
  }
  const messages = [{ role: "user", content: attachmentContent(key.provider, input.prompt, attachments) }];
  const anthropic = key.provider === "anthropic";
  const body = anthropic
    ? { model, max_tokens: ANTHROPIC_MAX_TOKENS, messages, stream: true }
    : {
      model, messages, stream: true,
      ...(key.provider === "openrouter" && attachments.some((attachment) => attachment.kind === "pdf")
        ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] }
        : {}),
    };
  const requestBody = JSON.stringify(body);
  if (key.provider === "cerebras" && imageCount > 0 && Buffer.byteLength(requestBody) > 10 * 1024 * 1024) {
    throw new QuickGenerateError(400, `${label} image requests must fit within 10 MiB including base64 encoding. Remove or shrink attachments.`);
  }
  let text = "";
  await providerStream(key, anthropic ? "/messages" : "/chat/completions", requestBody, deadline, signal, (data) => {
    const failure = field(data, "error");
    if (failure) {
      const detail = typeof failure === "string" ? failure : field(failure, "message");
      const suffix = typeof detail === "string" && detail ? `: ${redact(detail, key.secret)}` : ".";
      throw new QuickGenerateError(502, `${label} stream failed${suffix}`);
    }
    const choices = field(data, "choices");
    const part = anthropic
      ? field(data, "type") === "content_block_delta" ? field(field(data, "delta"), "text") : undefined
      : field(field(Array.isArray(choices) ? choices[0] : undefined, "delta"), "content");
    const piece = typeof part === "string" ? text ? part : part.trimStart() : "";
    if (!piece) return;
    text += piece;
    onText(piece);
  });
  if (text === "") throw new QuickGenerateError(502, `${label} returned no text.`);
  return text.trimEnd();
}
