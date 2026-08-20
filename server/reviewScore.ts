import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { db, getSetting } from "./db.ts";
import { harnessArgs } from "./harness.ts";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const reviewScoreDir = `${dataDir}/review-score`;
const RESULT_FILE = ".review-score-result.json";

const GREPTILE_LOGIN = "greptile-apps";

const GREPTILE_CONFIDENCE_RE = /Confidence Score:\s*(\d)\/5/i;

export interface ReviewBot {
  login: string;
  patterns: string[];
  staleMarker?: string;
}

interface CompiledReviewBot extends ReviewBot {
  regexes: RegExp[];
}

const BUILTIN_REVIEW_BOTS: ReviewBot[] = [
  { login: GREPTILE_LOGIN, patterns: ["Confidence Score:\\s*(\\d)\\/5"] },
  { login: "cursor", patterns: [] },
];

let cachedReviewBotsRaw: string | null = null;
let cachedReviewBots: CompiledReviewBot[] = [];

function compiledReviewBots(): CompiledReviewBot[] {
  const raw = getSetting("review_bots") ?? Bun.env.COCKPIT_REVIEW_BOTS ?? "[]";
  if (raw === cachedReviewBotsRaw) return cachedReviewBots;

  let invalid = false;
  let configured: ReviewBot[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    configured = parsed.flatMap((value): ReviewBot[] => {
      if (!value || typeof value !== "object") {
        invalid = true;
        return [];
      }
      const bot = value as Record<string, unknown>;
      if (typeof bot.login !== "string" || !bot.login || !Array.isArray(bot.patterns) || !bot.patterns.every((pattern) => typeof pattern === "string")) {
        invalid = true;
        return [];
      }
      if (bot.staleMarker !== undefined && typeof bot.staleMarker !== "string") {
        invalid = true;
        return [];
      }
      return [{ login: bot.login, patterns: bot.patterns as string[], ...(bot.staleMarker ? { staleMarker: bot.staleMarker } : {}) }];
    });
  } catch {
    invalid = true;
  }

  const merged = new Map(BUILTIN_REVIEW_BOTS.map((bot) => [bot.login, bot]));
  for (const bot of configured) merged.set(bot.login, bot);
  cachedReviewBots = [...merged.values()].map((bot) => ({
    ...bot,
    regexes: bot.patterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern, "i")];
      } catch {
        invalid = true;
        return [];
      }
    }),
  }));
  cachedReviewBotsRaw = raw;
  if (invalid) console.warn("Ignoring invalid review_bots configuration");
  return cachedReviewBots;
}

export function reviewBots(): ReviewBot[] {
  return compiledReviewBots().map(({ login, patterns, staleMarker }) => ({
    login,
    patterns: [...patterns],
    ...(staleMarker ? { staleMarker } : {}),
  }));
}

export function parseBotScore(login: string, body: string): number | null {
  const bot = compiledReviewBots().find((candidate) => candidate.login === login);
  if (!bot) return null;
  for (const pattern of bot.regexes) {
    const score = Number(pattern.exec(body)?.[1]);
    if (Number.isFinite(score)) return score;
  }
  return null;
}

export function parseGreptileScore(body: string): number | null {
  const m = GREPTILE_CONFIDENCE_RE.exec(body);
  return m ? Number(m[1]) : null;
}

export interface ScoredText {
  id: string;
  body: string;
  at: string;
}

// narrow local types (not the full PrDetail) so this module stays trivially testable with small fixtures
type TextSourceDetail = {
  reviews: { nodes: Array<{ id: string; author: { login: string } | null; body: string; submittedAt: string }> };
  comments: { nodes: Array<{ id: string; author: { login: string } | null; body: string; createdAt: string }> };
};
type ReviewerSourceDetail = {
  reviews: { nodes: Array<{ author: { login: string } | null }> };
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string } | null }> };
};
type CommitSourceDetail = {
  headRefOid: string;
  commitList: { nodes: Array<{ commit: { oid: string; committedDate: string } }> };
};
type LoginSourceDetail = TextSourceDetail & ReviewerSourceDetail;
type ScoreSourceDetail = LoginSourceDetail & CommitSourceDetail;

// review body first, then issue comments - newest of either kind first, since either can carry a bot's real content
export function candidateTexts(detail: TextSourceDetail, login: string): ScoredText[] {
  const fromReviews = detail.reviews.nodes.filter((r) => r.author?.login === login && r.body.trim().length > 0).map((r) => ({ id: r.id, body: r.body, at: r.submittedAt }));
  const fromComments = detail.comments.nodes.filter((c) => c.author?.login === login && c.body.trim().length > 0).map((c) => ({ id: c.id, body: c.body, at: c.createdAt }));
  return [...fromReviews, ...fromComments].reverse();
}

// the head commit a reviewer saw when they left a review/comment at time `at` - newest commit at or before that time. null when history is unknown (empty list, or the reviewed commit predates the last-100 window), which reads as "can't prove stale". compares epoch millis: committedDate is a git timestamp with the author's offset, `at` is UTC Z, so string order lies
export function reviewedShaAt(detail: CommitSourceDetail, at: string): string | null {
  const atMs = Date.parse(at);
  let best: { oid: string; ms: number } | null = null;
  for (const { commit } of detail.commitList?.nodes ?? []) {
    const ms = Date.parse(commit.committedDate);
    if (ms <= atMs && (!best || ms > best.ms)) best = { oid: commit.oid, ms };
  }
  return best?.oid ?? null;
}

export function reviewerLogins(detail: LoginSourceDetail): Set<string> {
  const logins = new Set<string>();
  for (const r of detail.reviews.nodes) if (r.author?.login) logins.add(r.author.login);
  for (const req of detail.reviewRequests.nodes) {
    const login = req.requestedReviewer?.login;
    if (login) logins.add(login);
  }
  // known bots can leave their only review signal as an issue comment; arbitrary human commenters are not reviewers
  const botLogins = new Set(reviewBots().map((bot) => bot.login));
  for (const c of detail.comments.nodes) if (c.author?.login && botLogins.has(c.author.login)) logins.add(c.author.login);
  return logins;
}

db.exec(`
CREATE TABLE IF NOT EXISTS review_scores (
  node_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  score REAL,
  basis TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_scores_pr ON review_scores (repo, number, reviewer);
`);

export interface ReviewScoreRow {
  node_id: string;
  repo: string;
  number: number;
  reviewer: string;
  score: number | null;
  basis: string | null;
  source: string;
  created_at: string;
}

const getScoreStmt = db.prepare<ReviewScoreRow, [string]>("SELECT * FROM review_scores WHERE node_id = ?");
const insertScoreStmt = db.prepare(`
INSERT INTO review_scores (node_id, repo, number, reviewer, score, basis, source, created_at)
VALUES ($node_id, $repo, $number, $reviewer, $score, $basis, $source, $created_at)
ON CONFLICT (node_id) DO NOTHING
`);

export function getReviewScore(nodeId: string): ReviewScoreRow | null {
  return getScoreStmt.get(nodeId) ?? null;
}

export interface ReviewScoreResult {
  score: number | null;
  basis: string | null;
}

function persistScore(nodeId: string, repo: string, number: number, reviewer: string, result: ReviewScoreResult, source: "regex" | "llm"): void {
  insertScoreStmt.run({
    $node_id: nodeId,
    $repo: repo,
    $number: number,
    $reviewer: reviewer,
    $score: result.score,
    $basis: result.basis,
    $source: source,
    $created_at: new Date().toISOString(),
  });
}

export interface ReviewerScoreView {
  score: number | null;
  basis: string | null;
  stale: boolean;
}

// score on a reviewer's most recent candidate text; stale when the head moved past the commit that text was left on
export function currentReviewerScores(detail: ScoreSourceDetail): Record<string, ReviewerScoreView> {
  const out: Record<string, ReviewerScoreView> = {};
  for (const login of reviewerLogins(detail)) {
    const latest = candidateTexts(detail, login)[0];
    if (!latest) continue;
    const row = getReviewScore(latest.id);
    if (!row) continue;
    const reviewedSha = reviewedShaAt(detail, latest.at);
    const stale = reviewedSha != null && reviewedSha !== detail.headRefOid;
    out[login] = { score: row.score, basis: row.basis, stale };
  }
  return out;
}

// does a non-greptile reviewer whose score sets the aggregate min carry a stale score? drives the inbox chip's stale styling (greptile's own staleness is handled separately)
export function aggregateReviewStale(perReviewer: Record<string, ReviewerScoreView>, aggregateScore: number | null): boolean {
  if (aggregateScore == null) return false;
  return Object.entries(perReviewer).some(([login, rs]) => login !== GREPTILE_LOGIN && rs.stale && rs.score === aggregateScore);
}

// the PR's headline score is its most pessimistic reviewer - the lowest non-null score across all of them. greptile is passed in already resolved (rescore over raw confidence), so skip its raw entry here
export function aggregateReviewScore(perReviewer: Record<string, ReviewScoreResult>, greptileEffective: number | null): number | null {
  const scores: number[] = [];
  if (greptileEffective != null) scores.push(greptileEffective);
  for (const [login, rs] of Object.entries(perReviewer)) {
    if (login === GREPTILE_LOGIN) continue;
    if (rs.score != null) scores.push(rs.score);
  }
  return scores.length ? Math.min(...scores) : null;
}

export function isValidLlmScoreResult(value: unknown): value is ReviewScoreResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.score !== null && (typeof v.score !== "number" || v.score < 0 || v.score > 5 || Math.round(v.score * 2) !== v.score * 2)) return false;
  if (v.basis !== null && typeof v.basis !== "string") return false;
  return true;
}

function llmScorePrompt(body: string): string {
  return `Read this code review comment. Does it contain an explicit quality/confidence verdict or score, in any scale (stars, percent, X/5, X/10, a Ship/Ready/Blocked-style verdict, etc)? If yes, normalize it to a 0-5 scale, halves allowed. If it's discussion, a question, or a plain approve/request-changes with no quality verdict, the score is null.

REVIEW BODY:
${body}

Last action, always: write valid JSON matching exactly this shape to the file ${RESULT_FILE} in the current directory, and nothing else:
{"score": <number 0-5, halves allowed, or null>, "basis": "<one short sentence, or null if score is null>"}`;
}

async function runLlmFallback(text: ScoredText): Promise<ReviewScoreResult> {
  const workdir = `${reviewScoreDir}/${text.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  mkdirSync(workdir, { recursive: true });
  rmSync(`${workdir}/${RESULT_FILE}`, { force: true });
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const logFd = openSync(`${workdir}.log`, "a");
  const args = harnessArgs(llmScorePrompt(text.body), "opus");
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  await proc.exited;
  closeSync(logFd);
  const file = Bun.file(`${workdir}/${RESULT_FILE}`);
  // a died agent (rate limit, retired model alias, crash) must never persist as a legitimate "no verdict" - the aggregate is a min, so a swallowed failure silently raises a PR's score. throwing leaves the row absent, and the next poll re-scores.
  if (!(await file.exists())) throw new Error(`agent exited ${proc.exitCode} without writing ${RESULT_FILE} - see ${workdir}.log`);
  const raw = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agent wrote unparseable ${RESULT_FILE}: ${raw.slice(0, 120)}`);
  }
  if (!isValidLlmScoreResult(parsed)) throw new Error(`agent wrote out-of-contract ${RESULT_FILE}: ${raw.slice(0, 120)}`);
  return parsed;
}

// bounded concurrency, mirrors the rescorer - several reviewers on one PR can need the LLM tier at once
const MAX_CONCURRENT = 2;
let activeCount = 0;
const queue: Array<() => void> = [];

function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeCount++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          activeCount--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (activeCount < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

// fire-and-forget: deterministic bots score synchronously (cheap regex), unknown reviewers queue a memoized LLM one-shot
export function scoreReviewers(repo: string, number: number, detail: ScoreSourceDetail): void {
  const botLogins = new Set(reviewBots().map((bot) => bot.login));
  for (const login of reviewerLogins(detail)) {
    const texts = candidateTexts(detail, login);
    if (botLogins.has(login)) {
      for (const text of texts) {
        if (getReviewScore(text.id)) continue;
        persistScore(text.id, repo, number, login, { score: parseBotScore(login, text.body), basis: null }, "regex");
      }
      continue;
    }
    // only the latest text per reviewer is ever read by currentReviewerScores - never score older ones here
    const latest = texts[0];
    if (!latest || getReviewScore(latest.id)) continue;
    withSlot(() => runLlmFallback(latest))
      .then((result) => persistScore(latest.id, repo, number, login, result, "llm"))
      .catch((err) => console.error(`review-score LLM fallback failed for ${latest.id}:`, err));
  }
}
