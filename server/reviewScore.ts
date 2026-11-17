import { getSetting } from "./db.ts";

const GREPTILE_LOGIN = "greptile-apps";

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

const LABELLED_SCORE_RE = /\b(?:quality|confidence)(?:\s+(?:score|rating))?\s*(?:[:=-]\s*)?(\d+(?:\.\d+)?)\s*(?:\/\s*(5|10)|(%))/i;

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
    const captured = Number(pattern.exec(body)?.[1]);
    const score = Number.isFinite(captured) && captured >= 0 && captured <= 5 ? captured : null;
    if (score != null) return score;
  }
  return null;
}

export function parseLabelledScore(body: string): number | null {
  const match = LABELLED_SCORE_RE.exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  const scale = match[3] ? 100 : Number(match[2]);
  if (!Number.isFinite(value) || value < 0 || value > scale) return null;
  return value * 5 / scale;
}

function postedScore(login: string, body: string): number | null {
  const bot = compiledReviewBots().find((candidate) => candidate.login === login);
  return bot?.patterns.length ? parseBotScore(login, body) : parseLabelledScore(body);
}

interface ScoredText {
  id: string;
  body: string;
  at: string;
}

type TextSourceDetail = {
  reviews: { nodes: Array<{ id: string; author: { login: string } | null; body: string; submittedAt: string }> };
  comments: { nodes: Array<{ id: string; author: { login: string; __typename?: string } | null; body: string; createdAt: string }> };
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

export function candidateTexts(detail: TextSourceDetail, login: string): ScoredText[] {
  const fromReviews = detail.reviews.nodes
    .filter((review) => review.author?.login === login && review.body.trim().length > 0)
    .map((review) => ({ id: review.id, body: review.body, at: review.submittedAt }));
  const fromComments = detail.comments.nodes
    .filter((comment) => comment.author?.login === login && comment.body.trim().length > 0)
    .map((comment) => ({ id: comment.id, body: comment.body, at: comment.createdAt }));
  return [...fromReviews, ...fromComments].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function reviewedShaAt(detail: CommitSourceDetail, at: string): string | null {
  const atMs = Date.parse(at);
  let best: { oid: string; ms: number } | null = null;
  for (const { commit } of detail.commitList?.nodes ?? []) {
    const ms = Date.parse(commit.committedDate);
    if (ms <= atMs && (!best || ms > best.ms)) best = { oid: commit.oid, ms };
  }
  return best?.oid ?? null;
}

const REVIEWED_COMMIT_RE = /Last reviewed commit:.*?\/commit\/([0-9a-f]{40})/is;

export function reviewedCommitIn(body: string): string | null {
  return body.match(REVIEWED_COMMIT_RE)?.[1] ?? null;
}

export function reviewerLogins(detail: LoginSourceDetail): Set<string> {
  const logins = new Set<string>();
  for (const review of detail.reviews.nodes) if (review.author?.login) logins.add(review.author.login);
  for (const request of detail.reviewRequests.nodes) {
    const login = request.requestedReviewer?.login;
    if (login) logins.add(login);
  }
  const botLogins = new Set(reviewBots().map((bot) => bot.login));
  for (const comment of detail.comments.nodes) {
    const author = comment.author;
    if (author && (botLogins.has(author.login)
      || ((author.__typename === "Bot" || author.login.endsWith("[bot]")) && postedScore(author.login, comment.body) !== null))) {
      logins.add(author.login);
    }
  }
  return logins;
}

export interface ReviewerScoreView {
  score: number;
  stale: boolean;
}

export function currentReviewerScores(detail: ScoreSourceDetail): Record<string, ReviewerScoreView> {
  const out: Record<string, ReviewerScoreView> = {};
  for (const login of reviewerLogins(detail)) {
    let scored: { text: ScoredText; score: number } | null = null;
    for (const text of candidateTexts(detail, login)) {
      const score = postedScore(login, text.body);
      if (score != null) {
        scored = { text, score };
        break;
      }
    }
    if (!scored) continue;
    // A bot that edits its summary in place keeps the comment's creation time, so the commit it names wins.
    const reviewedSha = reviewedCommitIn(scored.text.body) ?? reviewedShaAt(detail, scored.text.at);
    out[login] = {
      score: scored.score,
      stale: reviewedSha != null && reviewedSha !== detail.headRefOid,
    };
  }
  return out;
}

export function aggregateReviewStale(perReviewer: Record<string, ReviewerScoreView>, aggregateScore: number | null): boolean {
  if (aggregateScore == null) return false;
  return Object.entries(perReviewer).some(([login, score]) => login !== GREPTILE_LOGIN && score.stale && score.score === aggregateScore);
}

export function aggregateReviewScore(perReviewer: Record<string, { score: number | null }>, greptileScore: number | null): number | null {
  const scores: number[] = [];
  if (greptileScore != null) scores.push(greptileScore);
  for (const [login, result] of Object.entries(perReviewer)) {
    if (login !== GREPTILE_LOGIN && result.score != null) scores.push(result.score);
  }
  return scores.length ? Math.min(...scores) : null;
}
