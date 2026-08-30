import {
  deleteWebhookRegistrationsForWindow,
  deleteWebhookRegistration,
  deleteWebhookRegistrationsForPr,
  getPrByBranch,
  listWebhookRegistrations,
  listPrs,
  openPrNumbersForBranch,
  recordPrWebhookActivity,
  setWebhookRegistration,
  touchWebhookRegistrations,
  type PrRow,
} from "./db.ts";
import { fetchGithubQuota, fetchReviewItems, type ReviewItem } from "./github.ts";
import { checkState, type PrCheck } from "./checkState.ts";
import { checkName, liveCheckNames } from "../ui/src/lib/checks.js";
import { eligibleWebhookRepos, forwarderStatuses, reconcileForwarders, wantedRepos } from "./forwarders.ts";
import { prKeyOf } from "./prKey.ts";
import { prDetailScopeForEvent, refreshPrFromEvent } from "./eventRefresh.ts";
import { backgroundPollAllowed, refreshPr } from "./poller.ts";
import { listWorktrees } from "./worktreeScan.ts";
import { compactActionsPayload, ingestActionsState } from "./runLogs.ts";

const REVIEW_POLL_INTERVAL_MS = 1_800_000;

let reviewPollInFlight = false;
let discoveredReviewItems: ReviewItem[] = [];

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[webhooks]", ...args);
}

function cachedReviewItems(): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const pr of listPrs()) {
    if (pr.state !== "OPEN") continue;
    let detail: {
      viewerLogin?: string;
      viewerReviewRequested?: boolean;
      assignees?: { nodes?: Array<{ login?: string }> };
      body?: string;
      comments?: { nodes?: Array<{ body?: string }> };
      reviews?: { nodes?: Array<{ body?: string }> };
      reviewThreads?: { nodes?: Array<{ comments?: { nodes?: Array<{ body?: string }> } }> };
      url?: string;
    };
    try {
      detail = JSON.parse(pr.detail_json);
    } catch {
      continue;
    }
    const login = detail.viewerLogin;
    let bucket: ReviewItem["bucket"] | null = null;
    if (detail.viewerReviewRequested || pr.viewer_review_requested === 1) {
      bucket = "review-requested";
    } else if (login && detail.assignees?.nodes?.some((assignee) => assignee.login === login)) {
      bucket = "assigned";
    } else if (login) {
      const mention = new RegExp(`(^|[^A-Za-z0-9_-])@${login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`, "i");
      const text = [
        detail.body,
        ...(detail.comments?.nodes ?? []).map((comment) => comment.body),
        ...(detail.reviews?.nodes ?? []).map((review) => review.body),
        ...(detail.reviewThreads?.nodes ?? []).flatMap((thread) => (thread.comments?.nodes ?? []).map((comment) => comment.body)),
      ].filter((value): value is string => typeof value === "string").join("\n");
      if (mention.test(text)) bucket = "mentioned";
    }
    if (!bucket) continue;
    const ci = pr.ci_status;
    const state = pr.is_draft === 1
      ? "draft"
      : ci === "FAILURE" || ci === "ERROR"
        ? "open.failing.none"
        : ci === "PENDING" || ci === "EXPECTED"
          ? "open.running.none"
          : pr.review_decision === "APPROVED" ? "open.passing.approved" : "open.passing.none";
    items.push({
      repo: pr.repo,
      number: pr.number,
      url: detail.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`,
      title: pr.title,
      branch: pr.head_ref,
      bucket,
      isDraft: pr.is_draft === 1,
      state,
    });
  }
  return items;
}

async function pollReviews(): Promise<void> {
  if (reviewPollInFlight) return;
  reviewPollInFlight = true;
  try {
    if (!await backgroundPollAllowed()) return;
    const discovered = await fetchReviewItems();
    discoveredReviewItems = discovered.items;
  } catch (error) {
    console.error("pollReviews failed:", error);
  } finally {
    reviewPollInFlight = false;
  }
}

function extractHookRepoAndNumber(body: Record<string, unknown>): { repo: string | null; number: number | null } {
  const repository = body.repository as { full_name?: string } | undefined;
  const pullRequest = body.pull_request as { number?: number } | undefined;
  const issue = body.issue as { number?: number } | undefined;
  const checkRun = body.check_run as { pull_requests?: Array<{ number?: number }> } | undefined;
  const checkSuite = body.check_suite as { pull_requests?: Array<{ number?: number }> } | undefined;
  const workflowRun = body.workflow_run as { pull_requests?: Array<{ number?: number }> } | undefined;
  const number = pullRequest?.number ??
    issue?.number ??
    checkRun?.pull_requests?.[0]?.number ??
    checkSuite?.pull_requests?.[0]?.number ??
    workflowRun?.pull_requests?.[0]?.number ??
    null;
  return { repo: repository?.full_name ?? null, number };
}

async function handleHook(
  req: Request,
  refresh: typeof refreshPr,
  refreshAllowed: typeof backgroundPollAllowed,
): Promise<Response> {
  const event = req.headers.get("x-github-event") ?? "";
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { repo, number } = extractHookRepoAndNumber(body);
  if (!repo) return new Response("ignored");
  if (!eligibleWebhookRepos().has(repo)) return new Response("ignored");

  const actions = compactActionsPayload(event, body);
  if (actions) {
    await ingestActionsState(repo, actions);
    return new Response("ok");
  }

  const receivedAt = new Date().toISOString();
  if (event === "push") {
    const ref = typeof body.ref === "string" ? body.ref : "";
    if (!ref.startsWith("refs/heads/")) return new Response("ignored");
    for (const affectedNumber of openPrNumbersForBranch(repo, ref.slice("refs/heads/".length))) {
      recordPrWebhookActivity(repo, affectedNumber, receivedAt);
      touchWebhookRegistrations(repo, affectedNumber, receivedAt);
      void refreshPrFromEvent(repo, affectedNumber, "all", async (targetRepo, targetNumber, scope) => {
        if (await refreshAllowed()) await refresh(targetRepo, targetNumber, "webhook", scope);
      }).catch((e) =>
        console.error(`hook-triggered refresh failed for ${repo}#${affectedNumber}:`, e)
      );
    }
    return new Response("ok");
  }
  if (number === null) return new Response("ignored");

  const action = body.action as string | undefined;
  const pullRequest = body.pull_request as { number?: number } | undefined;
  if (event === "pull_request" && action === "closed" && pullRequest?.number === number) {
    deleteWebhookRegistrationsForPr(repo, number);
  }
  recordPrWebhookActivity(repo, number, receivedAt);
  touchWebhookRegistrations(repo, number, receivedAt);

  void refreshPrFromEvent(repo, number, prDetailScopeForEvent(event), async (targetRepo, targetNumber, scope) => {
    if (await refreshAllowed()) await refresh(targetRepo, targetNumber, "webhook", scope);
  }).catch((e) =>
    console.error(`hook-triggered refresh failed for ${repo}#${number}:`, e)
  );
  return new Response("ok");
}

async function handleRegister(req: Request, refresh: typeof refreshPr): Promise<Response> {
  let body: { repo?: string; number?: number; windowId?: string };
  try {
    body = (await req.json()) as { repo?: string; number?: number; windowId?: string };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const { repo, number, windowId } = body;
  if (
    typeof repo !== "string" ||
    !/^[^/]+\/[^/]+$/.test(repo) ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    (windowId != null && !(typeof windowId === "string" && windowId.startsWith("@")))
  ) {
    return new Response("expected {repo: owner/name, number, windowId?: @N}", { status: 400 });
  }
  const rebound = setWebhookRegistration(repo, number, windowId);
  reconcileForwarders();
  for (const other of rebound) log(`window rebound: ${windowId} ${prKeyOf(other.repo, other.number)} -> ${prKeyOf(repo, number)}`);
  void refresh(repo, number).catch((e) => console.error(`registration refresh failed for ${repo}#${number}:`, e));
  log(`registered: ${repo}#${number}${windowId ? ` on ${windowId}` : " (no window)"}`);
  return new Response("ok");
}

async function handleUnregister(req: Request): Promise<Response> {
  let body: { windowId?: string; repo?: string; number?: number };
  try {
    body = (await req.json()) as { windowId?: string; repo?: string; number?: number };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const had = typeof body.windowId === "string"
    ? deleteWebhookRegistrationsForWindow(body.windowId)
    : typeof body.repo === "string" && typeof body.number === "number" && Number.isInteger(body.number)
      ? deleteWebhookRegistration(body.repo, body.number)
      : null;
  if (had === null) return new Response("expected {windowId} or {repo, number}", { status: 400 });
  reconcileForwarders();
  return new Response(had ? "ok" : "not registered");
}

// mirrors tmux-pr-icon.sh's detect_state formula, sourced from cockpit's own cached PR row instead of a fresh gh call
export function daemonWorktreeState(pr: PrRow | null): string {
  if (!pr) return "local";
  if (pr.state === "MERGED" || pr.state === "CLOSED") return "merged";
  if (pr.is_draft === 1) return "draft";
  const ci = pr.ci_status === "FAILURE" || pr.ci_status === "ERROR" ? "failing" : pr.ci_status === "PENDING" || pr.ci_status === "EXPECTED" ? "running" : "passing";
  const review = pr.unresolved_count > 0 ? "unresolved" : pr.review_decision === "APPROVED" ? "approved" : "none";
  return `open.${ci}.${review}`;
}

export function prUrlAndCiFailingCount(pr: PrRow): { url: string | null; ciFailingCount: number } {
  try {
    const detail = JSON.parse(pr.detail_json) as { url?: string; lastCommit?: { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: PrCheck[] } } } }> } };
    const contexts = detail.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const live = liveCheckNames(contexts);
    const ciFailingCount = contexts
      .filter((check) => checkState(check) === "failed" && !live.has(checkName(check)))
      .length;
    return { url: detail.url ?? null, ciFailingCount };
  } catch {
    return { url: null, ciFailingCount: 0 };
  }
}

function handleStatus(): Response {
  const fwds = forwarderStatuses();
  const registrationRows = listWebhookRegistrations();
  const registrations = Object.fromEntries(registrationRows.map((r) => [
    prKeyOf(r.repo, r.number),
    { repo: r.repo, number: r.number, windowId: r.window_id, lastWebhookAt: r.last_webhook_at ? Date.parse(r.last_webhook_at) : null },
  ]));
  const lastWebhookByPr = new Map(registrationRows.map((r) => [prKeyOf(r.repo, r.number), r.last_webhook_at ? Date.parse(r.last_webhook_at) : null]));

  const worktrees = listWorktrees().map((w) => {
    const pr = getPrByBranch(w.repo, w.branch);
    const extras = pr ? prUrlAndCiFailingCount(pr) : null;
    return {
      path: w.path,
      windowId: w.windowId,
      repo: w.repo,
      branch: w.branch,
      state: daemonWorktreeState(pr),
      prNumber: pr?.number ?? null,
      prUrl: extras?.url ?? null,
      unresolvedComments: pr?.unresolved_count ?? null,
      ciFailingCount: extras?.ciFailingCount ?? null,
      lastWebhookAt: pr ? lastWebhookByPr.get(prKeyOf(w.repo, pr.number)) ?? null : null,
    };
  });

  return Response.json({
    repos: [...wantedRepos()],
    worktrees,
    registrations,
    lastPoll: new Date().toISOString(),
    forwarders: fwds,
  });
}

function handleReviews(): Response {
  const merged = new Map(discoveredReviewItems.map((item) => [`${item.repo}#${item.number}`, item]));
  for (const item of cachedReviewItems()) merged.set(`${item.repo}#${item.number}`, item);
  return Response.json({ items: [...merged.values()] });
}

async function handleQuota(): Promise<Response> {
  try {
    const quota = await fetchGithubQuota();
    return Response.json({
      graphqlRemaining: quota.graphql.remaining,
      graphqlUsedThisHour: quota.graphql.used,
      rendersSinceStart: 0,
      lastSeenAt: new Date().toISOString(),
      source: "cockpit",
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 });
  }
}

export function buildWebhookRoutes(
  refresh: typeof refreshPr = refreshPr,
  refreshAllowed: typeof backgroundPollAllowed = backgroundPollAllowed,
) {
  return async function handleWebhookRoute(req: Request, url: URL): Promise<Response | null> {
    if (req.method === "POST" && url.pathname === "/hook") return handleHook(req, refresh, refreshAllowed);
    if (req.method === "GET" && url.pathname === "/status") return handleStatus();
    if (req.method === "GET" && url.pathname === "/reviews") return handleReviews();
    if (req.method === "GET" && url.pathname === "/quota") return handleQuota();
    if (req.method === "POST" && url.pathname === "/register") return handleRegister(req, refresh);
    if (req.method === "POST" && url.pathname === "/unregister") return handleUnregister(req);
    return null;
  };
}

export function startWebhooks(): void {
  pollReviews();
  setInterval(() => pollReviews(), REVIEW_POLL_INTERVAL_MS);
}
