import { createConcurrencyLimit } from "./concurrency.ts";
import {
  QuickGenerateError,
  detectKeys,
  fetchModels,
  field,
  providerStream,
  readKeySources,
  systemRoots,
  vendorFetch,
  type Deadline,
  type DetectedKey,
  type QuickGenerateRoots,
  type Vendor,
} from "./quickGenerate.ts";

// Bun.serve closes a connection idle for 30s; the whole ask (Jev passes plus every Qwen turn) must answer first.
const ASK_TIMEOUT_MS = 25_000;
const MAX_QUESTION_CHARS = 2_000;
const JEV_MODEL = "jev-latest";
const JEV_KEY = "TYPESAFE_API_KEY";
const JEV_BASE_URL = "https://api.typesafe.ai/v1";
const JEV_CONCURRENCY = 4;
// Jev allows 32k tokens per question, but its accuracy drops as one state grows, so states stay near 12k tokens.
const JEV_STATE_CHARS = 48_000;
const JEV_STATE_ITEMS = 50;
const RELEVANT = 0.5;
const ITEM_CHARS = 12_000;
const PAGE_SECTION_CHARS = 2_000;
const TOTAL_ITEM_CHARS = 1_500_000;
const LIST_BODY_CHARS = 1_200;
const QWEN_ROWS = 400;
const QWEN_EXCERPT_CHARS = 60_000;
const TOOL_ROUNDS = 1;
const MODEL_CACHE_MS = 10 * 60_000;

export interface AskPr {
  key: string;
  title: string;
  author: string;
  state: string;
  isDraft: boolean;
  ciStatus: string | null;
  reviewDecision: string | null;
  labels: string[];
  section: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export type AskView =
  | { kind: "list"; title: string; prs: AskPr[] }
  | { kind: "pr"; key: string; detail: unknown; diff: string | null }
  | { kind: "page"; title: string; text: string };

interface Item {
  label: string;
  text: string;
  // What the user sees in the answer's source list; parts of one file or thread share it.
  source: string;
}

interface AskResult {
  answer: string;
  filters: string[];
  matches: Array<{ key: string; probability: number }> | null;
  sources: Array<{ label: string; detail: string }> | null;
  skipped: number;
}

export interface AskAnswer extends AskResult {
  provider: string;
  model: string;
  fallback: string | null;
}

interface Generator {
  key: DetectedKey;
  model: string;
}

interface AskContext {
  jev: Vendor;
  jevSecret: string;
  generators: DetectedKey[];
  active: Generator | null;
  fallback: string | null;
  deadline: Deadline;
  signal: AbortSignal | undefined;
  emit: (event: AskEvent) => void;
}

// Progress streamed to the client before the answer: steps name the work in flight, text deltas build the
// answer, and discard drops streamed text that turned out to precede a tool call or a failed provider.
export type AskEvent = { type: "step"; text: string } | { type: "text"; text: string } | { type: "discard" };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const modelCache = new Map<string, { model: string; at: number }>();

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nodes(value: unknown): unknown[] {
  const list = field(value, "nodes");
  return Array.isArray(list) ? list : [];
}

function login(value: unknown): string {
  return text(field(field(value, "author"), "login")) || "ghost";
}

// Bot posts carry HTML badges and hidden state markers that only cost tokens.
function cleanBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<picture>[\s\S]*?<\/picture>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseQuestion(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new QuickGenerateError(400, "Question is empty.");
  if (value.length > MAX_QUESTION_CHARS) throw new QuickGenerateError(400, "Question is too long.");
  return value.trim();
}

function parsePr(value: unknown): AskPr {
  const key = field(value, "key");
  const title = field(value, "title");
  if (typeof key !== "string" || typeof title !== "string") throw new QuickGenerateError(400, "invalid ask request");
  const optional = (name: string) => {
    const entry = field(value, name);
    return typeof entry === "string" ? entry : null;
  };
  const labels = field(value, "labels");
  return {
    key,
    title,
    author: text(field(value, "author")),
    state: text(field(value, "state")),
    isDraft: field(value, "isDraft") === true,
    ciStatus: optional("ciStatus"),
    reviewDecision: optional("reviewDecision"),
    labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [],
    section: optional("section"),
    createdAt: text(field(value, "createdAt")),
    updatedAt: text(field(value, "updatedAt")),
    body: text(field(value, "body")),
  };
}

export function parseAskRequest(body: unknown): { question: string; view: AskView } {
  const view = field(body, "view");
  const question = parseQuestion(field(body, "question"));
  const kind = field(view, "kind");
  const prs = field(view, "prs");
  const key = field(view, "key");
  const detail = field(view, "detail");
  const diff = field(view, "diff");
  const page = field(view, "text");
  if (kind === "list" && Array.isArray(prs)) {
    return { question, view: { kind: "list", title: text(field(view, "title")), prs: prs.map(parsePr) } };
  }
  if (kind === "pr" && typeof key === "string" && detail !== null && typeof detail === "object") {
    return { question, view: { kind: "pr", key, detail, diff: typeof diff === "string" ? diff : null } };
  }
  if (kind === "page" && typeof page === "string") {
    return { question, view: { kind: "page", title: text(field(view, "title")), text: page } };
  }
  throw new QuickGenerateError(400, "invalid ask request");
}

function splitText(label: string, body: string, source = label): Item[] {
  if (body.length <= ITEM_CHARS) return [{ label, text: body, source }];
  const parts: string[] = [];
  let current = "";
  for (const line of body.split("\n")) {
    if (current && current.length + line.length + 1 > ITEM_CHARS) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line.slice(0, ITEM_CHARS);
  }
  if (current) parts.push(current);
  return parts.map((part, index) => ({ label: `${label}, part ${index + 1} of ${parts.length}`, text: part, source }));
}

function diffFiles(diff: string): Item[] {
  const items: Item[] = [];
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    if (!header) continue;
    const path = header[2]!;
    const label = header[1] === path ? `File ${path}` : `File ${path} (moved from ${header[1]})`;
    const hunks = section.slice(section.search(/^@@/m) >= 0 ? section.search(/^@@/m) : section.length);
    items.push(...splitText(label, hunks || "(no textual changes)", path.split("/").pop()!));
  }
  return items;
}

export function prTitle(key: string, detail: unknown): string {
  const draft = field(detail, "isDraft") === true ? "draft, " : "";
  const state = text(field(detail, "state")).toLowerCase() || "open";
  const rollup = text(field(field(field(nodes(field(detail, "lastCommit"))[0], "commit"), "statusCheckRollup"), "state"));
  const review = text(field(detail, "reviewDecision"));
  return [
    `Pull request ${key}: ${text(field(detail, "title"))}`,
    `By @${login(detail)}, ${draft}${state}, ${text(field(detail, "headRefName"))} into ${text(field(detail, "baseRefName"))}.`,
    `CI ${rollup.toLowerCase() || "unknown"}, review ${review.toLowerCase().replaceAll("_", " ") || "none"}.`,
  ].join("\n");
}

export function prItems(detail: unknown, diff: string | null): Item[] {
  const items: Item[] = [];
  const body = cleanBody(text(field(detail, "body")));
  items.push(...splitText("Description", body || "(no description)"));
  for (const comment of nodes(field(detail, "comments"))) {
    const content = cleanBody(text(field(comment, "body")));
    if (content) items.push(...splitText(`Comment by @${login(comment)}`, content));
  }
  const verdicts: string[] = [];
  for (const review of nodes(field(detail, "reviews"))) {
    const state = text(field(review, "state"));
    const content = cleanBody(text(field(review, "body")));
    if (content) items.push(...splitText(`Review by @${login(review)} (${state.toLowerCase().replaceAll("_", " ")})`, content));
    else if (state && state !== "COMMENTED") verdicts.push(`@${login(review)}: ${state}`);
  }
  if (verdicts.length) items.push(...splitText("Review verdicts", verdicts.join("\n")));
  for (const thread of nodes(field(detail, "reviewThreads"))) {
    const comments = nodes(field(thread, "comments"));
    const first = comments[0];
    const line = field(thread, "line");
    const where = `${text(field(thread, "path"))}${typeof line === "number" ? `:${line}` : ""}`;
    const status = field(thread, "isResolved") === true ? "resolved" : "unresolved";
    const hunk = text(field(first, "diffHunk"));
    const replies = comments.map((comment) => `@${login(comment)}: ${cleanBody(text(field(comment, "body")))}`).join("\n\n");
    const name = `${text(field(thread, "path")).split("/").pop()}${typeof line === "number" ? `:${line}` : ""}`;
    items.push(...splitText(`Review thread on ${where} (${status})`, `${hunk ? `${hunk}\n\n` : ""}${replies}`, `Thread on ${name}`));
  }
  const commit = field(nodes(field(detail, "lastCommit"))[0], "commit");
  const checks = nodes(field(field(commit, "statusCheckRollup"), "contexts")).map((check) => {
    const name = text(field(check, "name")) || text(field(check, "context"));
    const outcome = text(field(check, "conclusion")) || text(field(check, "status")) || text(field(check, "state"));
    return `${name}: ${outcome.toLowerCase()}`;
  });
  if (checks.length) items.push(...splitText("Checks on the latest commit", checks.join("\n"), "Checks"));
  const commits = nodes(field(detail, "commitList")).map((node) => {
    const entry = field(node, "commit");
    return `${text(field(entry, "abbreviatedOid"))} ${text(field(entry, "messageHeadline"))}`;
  });
  if (commits.length) items.push(...splitText("Commits", commits.join("\n")));
  if (diff) items.push(...diffFiles(diff));
  else {
    const files = nodes(field(detail, "files")).map((file) =>
      `${text(field(file, "path"))} (+${Number(field(file, "additions")) || 0} -${Number(field(file, "deletions")) || 0})`
    );
    if (files.length) items.push(...splitText("Changed files (diff not loaded)", files.join("\n"), "Changed files"));
  }
  return items;
}

export function pageItems(page: string): Item[] {
  const items: Item[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    const first = current.split("\n", 1)[0]!.slice(0, 60);
    items.push(...splitText(`Section "${first}"`, current, first.length > 40 ? `${first.slice(0, 40)}…` : first));
    current = "";
  };
  for (const line of page.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (current && current.length + trimmed.length > PAGE_SECTION_CHARS) flush();
    current += (current ? "\n" : "") + trimmed;
  }
  flush();
  return items;
}

function chunk<T>(entries: T[], size: (entry: T) => number): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const entry of entries) {
    const length = size(entry);
    if (current.length && (chars + length > JEV_STATE_CHARS || current.length >= JEV_STATE_ITEMS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(entry);
    chars += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// One noul per entry over a shared state; entries are judged in bounded parallel chunks.
async function jevNouls<T>(
  ctx: AskContext,
  entries: T[],
  state: (chunk: T[]) => Record<string, unknown>,
  instruction: (index: number) => string,
): Promise<number[]> {
  const limit = createConcurrencyLimit(JEV_CONCURRENCY);
  const chunks = chunk(entries, (entry) => JSON.stringify(entry).length);
  const answers = await Promise.all(chunks.map((part) => limit(async () => {
    const questions = Object.fromEntries(part.map((_, index) => [`q${index}`, { type: "noul", instructions: instruction(index) }]));
    const body = await vendorFetch(ctx.jev, JEV_KEY, ctx.jevSecret, "/systemone", {
      method: "POST",
      body: { model: JEV_MODEL, state: state(part), questions },
    }, ctx.deadline, ctx.signal);
    return part.map((_, index) => {
      const noul = field(field(field(body, "answers"), `q${index}`), "noul");
      if (typeof noul !== "number") throw new QuickGenerateError(502, "TypeSafe returned an incomplete answer.");
      return noul;
    });
  })));
  return answers.flat();
}

async function qwenModel(key: DetectedKey, ctx: AskContext): Promise<string> {
  const cached = modelCache.get(key.id);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.model;
  const model = (await fetchModels(key, ctx.signal, ctx.deadline)).find((entry) => /qwen/i.test(entry.id))?.id;
  if (!model) throw new QuickGenerateError(502, `${key.label} lists no Qwen model.`);
  modelCache.set(key.id, { model, at: Date.now() });
  return model;
}

// Reasoning blocks are dropped as they stream; a half-received opening tag is held back until it resolves.
function visibleText(raw: string): string {
  return raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/, "").trimStart();
}

// Cerebras first; Groq answers when Cerebras has no key or fails, for the rest of this ask. The deadline
// is shared, so a timeout or cancellation ends the ask instead of moving on.
async function chat(ctx: AskContext, messages: ChatMessage[], tools?: { choice: "auto" | "none"; list: unknown[] }): Promise<ChatMessage> {
  for (;;) {
    const key = ctx.generators[0]!;
    let raw = "";
    let shown = "";
    const calls: ToolCall[] = [];
    try {
      const model = ctx.active?.model ?? await qwenModel(key, ctx);
      ctx.active = { key, model };
      const body = { model, messages, stream: true, ...(tools ? { tools: tools.list, tool_choice: tools.choice } : {}) };
      await providerStream(key, "/chat/completions", body, ctx.deadline, ctx.signal, (data) => {
        const failure = field(data, "error");
        if (failure !== undefined) throw new QuickGenerateError(502, `${key.label} stream failed: ${text(field(failure, "message")) || "unknown error"}`);
        const choices = field(data, "choices");
        const delta = field(Array.isArray(choices) ? choices[0] : undefined, "delta");
        const parts = field(delta, "tool_calls");
        for (const part of Array.isArray(parts) ? parts : []) {
          const index = field(part, "index");
          const at = typeof index === "number" ? index : calls.length;
          calls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          const call = calls[at];
          call.id += text(field(part, "id"));
          call.function.name += text(field(field(part, "function"), "name"));
          call.function.arguments += text(field(field(part, "function"), "arguments"));
        }
        raw += text(field(delta, "content"));
        const visible = visibleText(raw);
        if (visible.length > shown.length && !calls.length) {
          ctx.emit({ type: "text", text: visible.slice(shown.length) });
          shown = visible;
        }
      });
      const toolCalls = calls.filter((call) => call.id && call.function.name);
      if (toolCalls.length && shown) ctx.emit({ type: "discard" });
      return { role: "assistant", content: visibleText(raw).trim(), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    } catch (error) {
      if (!(error instanceof QuickGenerateError) || error.status === 499 || error.status === 504 || ctx.generators.length < 2) throw error;
      if (shown) ctx.emit({ type: "discard" });
      ctx.fallback = `${key.label}: ${error.message}`;
      ctx.generators = ctx.generators.slice(1);
      ctx.active = null;
      ctx.emit({ type: "step", text: `${key.label} failed, asking ${ctx.generators[0]!.label}` });
    }
  }
}

function prStatus(pr: AskPr): string[] {
  const review = (pr.reviewDecision ?? "none").toLowerCase().replaceAll("_", " ");
  return [pr.isDraft ? "draft" : pr.state.toLowerCase(), `CI ${(pr.ciStatus ?? "none").toLowerCase()}`, `review ${review}`];
}

function prRow(pr: AskPr): string {
  return [pr.key, pr.title, `@${pr.author}`, ...prStatus(pr), pr.labels.join(", ") || "-", pr.section ?? "-", pr.updatedAt.slice(0, 10)].join(" | ");
}

function jevPr(pr: AskPr): Record<string, unknown> {
  return {
    pr: pr.key,
    title: pr.title,
    author: pr.author,
    status: prStatus(pr).join(", "),
    labels: pr.labels,
    section: pr.section,
    opened: pr.createdAt.slice(0, 10),
    updated: pr.updatedAt.slice(0, 10),
    description: cleanBody(pr.body).slice(0, LIST_BODY_CHARS),
  };
}

async function filterPrs(ctx: AskContext, question: string, condition: string | null, prs: AskPr[]): Promise<Array<{ key: string; probability: number }>> {
  const rows = prs.map(jevPr);
  const probabilities = await jevNouls(
    ctx,
    rows,
    (part) => (condition ? { question, condition, prs: part } : { question, prs: part }),
    (index) => condition
      ? `Is \`condition\` true of the pull request \`prs[${index}]\`?`
      : `Is the pull request \`prs[${index}]\` one that answers \`question\` or that the person asking would want listed?`,
  );
  return prs
    .map((pr, index) => ({ key: pr.key, probability: probabilities[index]! }))
    .filter((entry) => entry.probability >= RELEVANT)
    .sort((a, b) => b.probability - a.probability);
}

const FILTER_TOOL = {
  type: "function",
  function: {
    name: "filter_prs",
    description: "A classifier checks every listed PR, including its description, against one yes/no condition and returns the keys it holds for.",
    parameters: {
      type: "object",
      properties: { condition: { type: "string", description: "A yes/no condition about one PR, e.g. \"The PR changes the billing API.\"" } },
      required: ["condition"],
    },
  },
};

const LIST_PROMPT = [
  "Answer the user's question about the pull requests listed in their PR Cockpit view.",
  "Rows: key | title | author | state | CI | review | labels | section | updated.",
  "Call filter_prs once when the answer depends on what PRs contain (topic, code, intent) that the rows can't show; decide anything visible in the rows (title, type prefix, state, CI, labels) yourself.",
  "Reply in at most three short sentences of Markdown and name every PR you mean by #number: exactly those appear as a list under your reply.",
].join("\n");

async function askList(ctx: AskContext, question: string, view: { title: string; prs: AskPr[] }): Promise<AskResult> {
  const shown = view.prs.slice(0, QWEN_ROWS).map(prRow);
  const more = view.prs.length - shown.length;
  const messages: ChatMessage[] = [
    { role: "system", content: LIST_PROMPT },
    {
      role: "user",
      content: `View: ${view.title || "Pull requests"}, ${view.prs.length} PRs.\n${shown.join("\n")}${more > 0 ? `\n(${more} more not shown; filter_prs checks them too)` : ""}\n\nQuestion: ${question}`,
    },
  ];
  // Jev reads the raw question against every PR while Qwen plans, so a reply without filters still lists what's relevant.
  const relevant = filterPrs(ctx, question, null, view.prs);
  relevant.catch(() => {});
  const filters: string[] = [];
  let matches: AskAnswer["matches"] = null;
  ctx.emit({ type: "step", text: `Thinking about ${view.prs.length} PRs` });
  for (let round = 0; ; round++) {
    const reply = await chat(ctx, messages, { choice: round < TOOL_ROUNDS ? "auto" : "none", list: [FILTER_TOOL] });
    if (!reply.tool_calls || round >= TOOL_ROUNDS) {
      // PRs the answer names are the list, so the two never disagree; the raw-question pass covers answers that name none.
      const named = new Set([...reply.content.matchAll(/#(\d+)\b/g)].map((match) => match[1]));
      const cited = view.prs.filter((pr) => named.has(pr.key.split("#")[1])).map((pr) => ({ key: pr.key, probability: 1 }));
      if (!matches && !cited.length) ctx.emit({ type: "step", text: `Matching ${view.prs.length} PRs` });
      return {
        answer: reply.content,
        filters,
        matches: cited.length ? cited : matches ?? await relevant,
        sources: null,
        skipped: 0,
      };
    }
    messages.push(reply);
    for (const call of reply.tool_calls) {
      let condition = "";
      try {
        condition = text(field(JSON.parse(call.function.arguments), "condition")).trim();
      } catch {}
      if (call.function.name !== "filter_prs" || !condition) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Call filter_prs with a condition." }) });
        continue;
      }
      ctx.emit({ type: "step", text: `Checking “${condition}” on ${view.prs.length} PRs` });
      matches = await filterPrs(ctx, question, condition, view.prs);
      filters.push(condition);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ matched: matches.length, of: view.prs.length, keys: matches.map((entry) => entry.key) }) });
      ctx.emit({ type: "step", text: `${matches.length} of ${view.prs.length} match, writing` });
    }
  }
}

const ITEMS_PROMPT = [
  "Answer the user's question about what they are viewing in PR Cockpit, using only the excerpts a classifier selected as relevant.",
  "Lead with the answer in under 150 words unless the question asks for detail. Cite files by path and comments by author.",
  "Mention the excerpts only when they lack the answer, and then say what is missing. Markdown, no preamble.",
].join("\n");

async function askItems(ctx: AskContext, question: string, title: string, all: Item[]): Promise<AskResult> {
  let total = 0;
  const items = all.filter((item) => (total += item.text.length) <= TOTAL_ITEM_CHARS);
  ctx.emit({ type: "step", text: `Reading ${items.length} part${items.length === 1 ? "" : "s"}` });
  const probabilities = items.length
    ? await jevNouls(
      ctx,
      items,
      (part) => ({ question, view: title, items: part.map(({ label, text }) => ({ label, text })) }),
      (index) => `Does \`items[${index}]\` contain information that helps answer \`question\` about \`view\`?`,
    )
    : [];
  const ranked = items
    .map((item, index) => ({ ...item, probability: probabilities[index]! }))
    .filter((item) => item.probability >= RELEVANT)
    .sort((a, b) => b.probability - a.probability);
  let budget = QWEN_EXCERPT_CHARS;
  const excerpts = ranked.filter((item) => (budget -= item.text.length) >= 0 || item === ranked[0]);
  const context = excerpts.length
    ? excerpts.map((item) => `### ${item.label}\n${item.text}`).join("\n\n")
    : "(No excerpt was judged relevant.)";
  ctx.emit({ type: "step", text: `Writing from ${excerpts.length} relevant part${excerpts.length === 1 ? "" : "s"}` });
  const reply = await chat(ctx, [
    { role: "system", content: ITEMS_PROMPT },
    { role: "user", content: `${title}\n\nExcerpts:\n\n${context}\n\nQuestion: ${question}` },
  ]);
  return {
    answer: reply.content,
    filters: [],
    matches: null,
    sources: [...Map.groupBy(excerpts, (item) => item.source)].map(([label, group]) => ({ label, detail: group.map((item) => item.label).join("\n") })),
    skipped: all.length - items.length,
  };
}

function jevSecret(roots: QuickGenerateRoots): string {
  for (const source of readKeySources(roots).sources) {
    const secret = source.get(JEV_KEY)?.trim();
    if (secret) return secret;
  }
  throw new QuickGenerateError(400, `Add ${JEV_KEY} to the key file.`);
}

export async function askView(
  question: string,
  view: AskView,
  emit: (event: AskEvent) => void,
  signal?: AbortSignal,
  roots: QuickGenerateRoots = systemRoots(),
): Promise<AskAnswer> {
  const keys = detectKeys(roots).keys;
  const jev = jevSecret(roots);
  const done = new AbortController();
  const ctx: AskContext = {
    jev: { label: "TypeSafe", baseUrl: JEV_BASE_URL, headers: { authorization: `Bearer ${jev}` } },
    jevSecret: jev,
    generators: (["cerebras", "groq"] as const).flatMap((provider) => keys.find((key) => key.provider === provider) ?? []),
    active: null,
    fallback: null,
    deadline: { signal: AbortSignal.timeout(ASK_TIMEOUT_MS), ms: ASK_TIMEOUT_MS },
    // Ends background Jev passes (the unfiltered list pass, queued chunks) once the answer settles.
    signal: signal ? AbortSignal.any([signal, done.signal]) : done.signal,
    emit,
  };
  if (!ctx.generators.length) throw new QuickGenerateError(400, "Add CEREBRAS_API_KEY or GROQ_API_KEY to the key file.");
  try {
    const result = view.kind === "list"
      ? await askList(ctx, question, view)
      : view.kind === "pr"
        ? await askItems(ctx, question, prTitle(view.key, view.detail), prItems(view.detail, view.diff))
        : await askItems(ctx, question, `PR Cockpit page: ${view.title}`, pageItems(view.text));
    return { ...result, provider: ctx.active?.key.label ?? "", model: ctx.active?.model ?? "", fallback: ctx.fallback };
  } finally {
    done.abort();
  }
}
