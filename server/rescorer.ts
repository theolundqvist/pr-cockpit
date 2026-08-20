import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { getPr, getRescoreFor, insertRescore, type PrRow } from "./db.ts";
import { diffFromMirror, fetchMirror, INCREMENTAL_FETCH_TIMEOUT_MS } from "./mirror.ts";
import { harnessArgs } from "./harness.ts";
import { agentEnabled, agentModel, agentPromptTemplate } from "./settings.ts";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const rescorerDir = `${dataDir}/rescorer`;

const GREPTILE_LOGIN = "greptile-apps";
const RESULT_FILE = ".rescore-result.json";
const MAX_CONCURRENT = 2;

type GreptileFindingsDetail = {
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      path: string;
      line: number | null;
      comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
    }>;
  };
};

export interface GreptileFinding {
  path: string;
  line: number | null;
  body: string;
  resolved: boolean;
}

export function greptileFindings(detail: GreptileFindingsDetail): GreptileFinding[] {
  return detail.reviewThreads.nodes.flatMap((t) => {
    const first = t.comments.nodes[0];
    if (first?.author?.login !== GREPTILE_LOGIN) return [];
    return [{ path: t.path, line: t.line, body: first.body, resolved: t.isResolved }];
  });
}

// same condition as http.ts's greptileScoreStatus (kept local to avoid a poller<->http<->rescorer import cycle)
export function needsRescoreCandidate(pr: PrRow): boolean {
  return pr.greptile_confidence != null && !!pr.greptile_reviewed_sha && pr.greptile_reviewed_sha !== pr.head_sha;
}

// auto-rescore runs only on the viewer's own PRs — never re-score a colleague's PR
export function shouldAutoRescore(pr: PrRow): boolean {
  return pr.viewer_is_author === 1 && needsRescoreCandidate(pr);
}

export interface RescoreResult {
  score: number;
  verdicts: Array<{ finding: string; verdict: string }>;
}

// The rescorer only checks whether Greptile's existing findings were addressed;
// it cannot discover a new reason to lower Greptile's original confidence.
// Older rescore rows used 0 to mean "nothing addressed", so keep the original
// confidence as the floor when presenting those rows too.
export function effectiveRescoreScore(originalScore: number, rescoreScore: number): number {
  return Math.max(originalScore, rescoreScore);
}

export function isValidRescoreResult(value: unknown): value is RescoreResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.score !== "number" || v.score < 0 || v.score > 5 || Math.round(v.score * 2) !== v.score * 2) return false;
  if (!Array.isArray(v.verdicts)) return false;
  return v.verdicts.every(
    (e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).finding === "string" && typeof (e as Record<string, unknown>).verdict === "string",
  );
}

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

export async function maybeRescore(repo: string, number: number): Promise<void> {
  if (!agentEnabled("rescorer")) return;
  const pr = getPr(repo, number);
  if (!pr || !shouldAutoRescore(pr)) return;
  const reviewSha = pr.greptile_reviewed_sha as string;
  if (getRescoreFor(repo, number, GREPTILE_LOGIN, reviewSha, pr.head_sha)) return;
  const detail = JSON.parse(pr.detail_json) as GreptileFindingsDetail;
  const findings = greptileFindings(detail);
  if (findings.length === 0) return;
  await withSlot(() => runRescorer(repo, number, pr, reviewSha, findings));
}

async function getRangeDiff(repo: string, base: string, head: string): Promise<string | null> {
  let result = await diffFromMirror(repo, base, head, "two-dot");
  if (result.status === "missing-commit" || result.status === "no-mirror") {
    try {
      await fetchMirror(repo, INCREMENTAL_FETCH_TIMEOUT_MS);
    } catch (err) {
      console.error(`mirror fetch failed for ${repo}:`, err);
      return null;
    }
    result = await diffFromMirror(repo, base, head, "two-dot");
  }
  return result.status === "ok" ? result.patch : null;
}

// editable persona only; rescorePrompt appends the findings, diff and result-JSON contract so an override can't break parsing
export const RESCORE_INSTRUCTION_DEFAULT = `You are re-scoring a code review for {{REPO}}#{{NUMBER}} after new commits landed. Greptile originally gave the PR {{ORIGINAL_SCORE}}/5 and raised the findings below. Commits have since been pushed - the diff between the reviewed commit and the current head is included so you can see exactly what changed.

For each finding, decide whether the new commits addressed it, whether it's still valid as-is, or whether it no longer applies. Then give the PR an updated overall confidence score out of 5, halves allowed. This is a confidence score, not a percentage of findings addressed: use Greptile's original score as the baseline and only raise it when the new commits justify that. If the diff provides no useful evidence, retain the original score. Never use 0 to mean missing or unknown.`;

export function defaultRescorePrompt(): string {
  return RESCORE_INSTRUCTION_DEFAULT;
}

export function rescorePrompt(repo: string, number: number, originalScore: number, findings: GreptileFinding[], diffPatch: string): string {
  const instruction = (agentPromptTemplate("rescorer").trim() || RESCORE_INSTRUCTION_DEFAULT)
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{NUMBER}}", String(number))
    .replaceAll("{{ORIGINAL_SCORE}}", String(originalScore));
  const findingsText = findings
    .map((f, i) => `${i + 1}. ${f.path}${f.line ? `:${f.line}` : ""} (${f.resolved ? "resolved" : "unresolved"})\n${f.body}`)
    .join("\n\n");
  return `${instruction}

GREPTILE FINDINGS (from the earlier review):
${findingsText}

DIFF SINCE THAT REVIEW:
${diffPatch || "(no diff available)"}

SCORING CONTRACT:
Greptile's original confidence was ${originalScore}/5. Return an updated overall confidence score, not remediation progress. The score must not be lower than ${originalScore}. If no updated score can be established from the diff, return ${originalScore}; never use 0 as an unavailable-score fallback.

Last action, always: write valid JSON matching exactly this shape to the file ${RESULT_FILE} in the current directory, and nothing else:
{"score": <number>, "verdicts": [{"finding": "<short label for the finding>", "verdict": "<one short sentence>"}]}`;
}

async function spawnRescoreAgent(workdir: string, prompt: string): Promise<void> {
  rmSync(`${workdir}/${RESULT_FILE}`, { force: true });
  const logFd = openSync(`${workdir}.log`, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  const args = harnessArgs(prompt, agentModel("rescorer"));
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  await proc.exited;
  closeSync(logFd);
}

export async function readRescoreResult(workdir: string): Promise<RescoreResult | null> {
  const file = Bun.file(`${workdir}/${RESULT_FILE}`);
  if (!(await file.exists())) return null;
  try {
    const parsed = JSON.parse(await file.text());
    return isValidRescoreResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runRescorer(repo: string, number: number, pr: PrRow, reviewSha: string, findings: GreptileFinding[]): Promise<void> {
  const diffPatch = await getRangeDiff(repo, reviewSha, pr.head_sha);
  const workdir = `${rescorerDir}/${repo.replace("/", "-")}-${number}`;
  mkdirSync(workdir, { recursive: true });
  const originalScore = pr.greptile_confidence as number;
  const prompt = rescorePrompt(repo, number, originalScore, findings, diffPatch ?? "");
  await spawnRescoreAgent(workdir, prompt);
  const result = await readRescoreResult(workdir);
  if (!result) return;

  insertRescore({
    repo,
    number,
    reviewer: GREPTILE_LOGIN,
    review_sha: reviewSha,
    head_sha: pr.head_sha,
    score: effectiveRescoreScore(originalScore, result.score),
    verdicts_json: JSON.stringify(result.verdicts),
    created_at: new Date().toISOString(),
  });
}
