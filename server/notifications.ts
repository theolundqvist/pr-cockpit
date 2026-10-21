import { db, getSetting, type PrRow, type WorkflowRunRow } from "./db.ts";
import { invalidateNotifications, invalidateNotificationSettings } from "./rendererInvalidation.ts";
import { reviewBots } from "./reviewScore.ts";
import {
  defaultNotificationSettings,
  matchingNotificationRules,
  parseNotificationSettings,
  type NotificationEvent,
  type NotificationEventType,
  type NotificationSettings,
} from "../shared/notificationRules.ts";

export interface DesktopNotification {
  id: string;
  title: string;
  body: string;
  repo: string;
  number: number;
}

type DetailRow = Pick<PrRow, "detail_json" | "fetched_at">;
type NextDetailRow = Pick<PrRow, "repo" | "number" | "detail_json" | "fetched_at">;
type JsonRecord = Record<string, unknown>;

let cachedSettingsRaw: string | null | undefined;
let cachedSettings = defaultNotificationSettings();
let cachedReviewBotsRaw: string | null | undefined;
let cachedBotLogins = new Set<string>();

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function nodes(value: unknown): JsonRecord[] {
  const connection = record(value);
  return Array.isArray(connection?.nodes) ? connection.nodes.flatMap((node) => record(node) ?? []) : [];
}

export function storedNotificationSettings(): NotificationSettings {
  const raw = getSetting("notifications");
  if (raw === cachedSettingsRaw) return cachedSettings;
  cachedSettings = raw === null ? defaultNotificationSettings() : parseNotificationSettings(JSON.parse(raw));
  cachedSettingsRaw = raw;
  return cachedSettings;
}

function actor(value: unknown): NotificationEvent["actor"] {
  const author = record(value);
  const login = string(author?.login);
  const declaredType = string(author?.__typename) ?? string(author?.type);
  if (declaredType?.toLowerCase() === "bot") return { login, type: "bot" };
  const reviewBotsRaw = getSetting("review_bots");
  if (reviewBotsRaw !== cachedReviewBotsRaw) {
    cachedBotLogins = new Set(reviewBots().map((bot) => bot.login.toLowerCase()));
    cachedReviewBotsRaw = reviewBotsRaw;
  }
  if (login && (login.toLowerCase().endsWith("[bot]") || cachedBotLogins.has(login.toLowerCase()))) {
    return { login, type: "bot" };
  }
  if (declaredType?.toLowerCase() === "user") return { login, type: "human" };
  return { login, type: "unknown" };
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function afterActivation(occurredAt: string | null, enabledAtMs: number): occurredAt is string {
  const occurredAtMs = parseTime(occurredAt);
  return occurredAtMs !== null && occurredAtMs >= enabledAtMs;
}

function viewerRequested(detail: JsonRecord): boolean {
  return boolean(detail.viewerReviewRequested);
}

// Something consumes merge attribution: the in-app "Merged by me" filter or an enabled
// "I merged it" rule. Otherwise bot merges never pay for reading who ordered them.
export function mergeAttributionWanted(): boolean {
  if (getSetting("merged_by_me_notifications_enabled") === "true") return true;
  const settings = storedNotificationSettings();
  return settings.enabled && settings.rules.some((rule) => rule.enabled
    && rule.conditions.some((condition) => condition.field === "participation" && condition.value === "merger"));
}

// The viewer merged the PR, or a merge-queue bot merged it after the viewer last ordered it.
export function viewerMergedPr(detail: JsonRecord): boolean {
  const viewer = string(detail.viewerLogin)?.toLowerCase();
  const mergedBy = record(detail.mergedBy);
  const merger = string(mergedBy?.login)?.toLowerCase();
  if (!viewer || !merger) return false;
  if (merger === viewer) return true;
  return string(mergedBy?.__typename) === "Bot" && string(record(detail.orderedBy)?.login)?.toLowerCase() === viewer;
}

function eventBase(
  id: string,
  type: NotificationEventType,
  repo: string,
  number: number,
  detail: JsonRecord,
  eventActor: NotificationEvent["actor"],
  body: string | null,
  occurredAt: string,
  reviewState: string | null = null,
): NotificationEvent {
  const viewerLogin = string(detail.viewerLogin) ?? "";
  const authorLogin = string(record(detail.author)?.login);
  return {
    id,
    type,
    repo,
    number,
    title: string(detail.title) ?? `Pull request #${number}`,
    body,
    actor: eventActor,
    prAuthor: authorLogin,
    viewerIsAssignee: viewerLogin.length > 0 && nodes(detail.assignees).some((assignee) => string(assignee.login)?.toLowerCase() === viewerLogin.toLowerCase()),
    viewerIsAuthor: boolean(detail.viewerIsAuthor),
    viewerReviewRequested: viewerRequested(detail),
    viewerMerged: viewerMergedPr(detail),
    reviewState,
    isDraft: boolean(detail.isDraft),
    occurredAt,
  };
}

function commentEvents(
  previous: JsonRecord,
  next: JsonRecord,
  repo: string,
  number: number,
  enabledAtMs: number,
): NotificationEvent[] {
  const previousCommentIds = new Set(nodes(previous.comments).map((comment) => string(comment.id)).filter((id): id is string => id !== null));
  const events: NotificationEvent[] = [];
  for (const comment of nodes(next.comments)) {
    const id = string(comment.id);
    const createdAt = string(comment.createdAt);
    if (!id || previousCommentIds.has(id) || !afterActivation(createdAt, enabledAtMs)) continue;
    events.push(eventBase(`comment:${repo}#${number}:${id}`, "comment", repo, number, next, actor(comment.author), string(comment.body), createdAt));
  }

  const previousThreadCommentIds = new Set<string>();
  for (const thread of nodes(previous.reviewThreads)) {
    for (const comment of nodes(thread.comments)) {
      const id = threadCommentId(comment);
      if (id) previousThreadCommentIds.add(id);
    }
  }
  for (const thread of nodes(next.reviewThreads)) {
    for (const comment of nodes(thread.comments)) {
      const id = threadCommentId(comment);
      const createdAt = string(comment.createdAt);
      if (!id || previousThreadCommentIds.has(id) || !afterActivation(createdAt, enabledAtMs)) continue;
      events.push(eventBase(`thread-comment:${repo}#${number}:${id}`, "comment", repo, number, next, actor(comment.author), string(comment.body), createdAt));
    }
  }
  return events;
}

function threadCommentId(comment: JsonRecord): string | null {
  return string(comment.id) ?? (typeof comment.databaseId === "number" ? String(comment.databaseId) : null);
}

function reviewEvents(
  previous: JsonRecord,
  next: JsonRecord,
  repo: string,
  number: number,
  enabledAtMs: number,
): NotificationEvent[] {
  const previousIds = new Set(nodes(previous.reviews).map((review) => string(review.id)).filter((id): id is string => id !== null));
  const events: NotificationEvent[] = [];
  for (const review of nodes(next.reviews)) {
    const id = string(review.id);
    const submittedAt = string(review.submittedAt);
    if (!id || previousIds.has(id) || !afterActivation(submittedAt, enabledAtMs)) continue;
    const state = string(review.state)?.toLowerCase() ?? null;
    events.push(eventBase(`review:${repo}#${number}:${id}`, "review", repo, number, next, actor(review.author), string(review.body), submittedAt, state));
  }
  return events;
}

function checkState(detail: JsonRecord): string | null {
  const commit = nodes(detail.lastCommit)[0];
  const rollup = record(record(commit?.commit)?.statusCheckRollup);
  return string(rollup?.state);
}

function transitionEvents(
  previous: JsonRecord,
  next: JsonRecord,
  repo: string,
  number: number,
  identityAt: string,
  occurredAt: string,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  const unknownActor: NotificationEvent["actor"] = { login: null, type: "unknown" };
  const add = (type: NotificationEventType) => {
    events.push(eventBase(`${type}:${repo}#${number}:${identityAt}`, type, repo, number, next, unknownActor, null, occurredAt));
  };
  const previousState = string(previous.state);
  const nextState = string(next.state);
  if (previousState !== "MERGED" && nextState === "MERGED") add("merged");
  else if (previousState === "OPEN" && nextState === "CLOSED") add("closed");
  else if (previousState === "CLOSED" && nextState === "OPEN") add("reopened");
  if (boolean(previous.isDraft) && !boolean(next.isDraft)) add("ready_for_review");
  if (!viewerRequested(previous) && viewerRequested(next)) add("review_requested");
  const previousChecks = checkState(previous);
  const nextChecks = checkState(next);
  if (previousChecks !== "FAILURE" && previousChecks !== "ERROR" && (nextChecks === "FAILURE" || nextChecks === "ERROR")) {
    add("checks_failed");
  }
  return events;
}

function bounded(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function desktopNotification(event: NotificationEvent): DesktopNotification {
  if (event.type === "deployed") {
    const body = event.workflow ? `#${event.number} ${event.title} · ${event.workflow}` : `#${event.number} ${event.title}`;
    return { id: event.id, title: bounded(`Deployed to ${event.branch ?? "branch"}`, 120), body: bounded(body, 240), repo: event.repo, number: event.number };
  }
  const labels: Record<Exclude<NotificationEventType, "deployed">, string> = {
    comment: "New comment",
    review: "New review",
    review_requested: "Review requested",
    checks_failed: "Checks failed",
    merged: "Pull request merged",
    closed: "Pull request closed",
    reopened: "Pull request reopened",
    ready_for_review: "Ready for review",
  };
  const title = bounded(`${labels[event.type]}: ${event.title}`, 120);
  const location = `${event.repo}#${event.number}`;
  const authored = event.actor.login ? `${event.actor.login} · ${location}` : location;
  const body = event.body ? `${authored} · ${event.body}` : authored;
  return { id: event.id, title, body: bounded(body, 240), repo: event.repo, number: event.number };
}

const insertNotificationStmt = db.prepare(`
  INSERT OR IGNORE INTO desktop_notifications (id, event_json, title, body, repo, number, created_at, claimed_at)
  VALUES ($id, $event_json, $title, $body, $repo, $number, $created_at, NULL)
`);

function insertMatchingNotifications(settings: NotificationSettings, events: NotificationEvent[]): void {
  let inserted = false;
  for (const event of events) {
    if (matchingNotificationRules(settings, event).length === 0) continue;
    const notification = desktopNotification(event);
    const result = insertNotificationStmt.run({
      $id: notification.id,
      $event_json: JSON.stringify(event),
      $title: notification.title,
      $body: notification.body,
      $repo: notification.repo,
      $number: notification.number,
      $created_at: event.occurredAt,
    });
    inserted ||= result.changes > 0;
  }
  if (inserted) invalidateNotifications();
}

export interface DeployedPr {
  number: number;
  // PR detail as cached, or the fields Cockpit's PR index knows when no detail was fetched.
  detail: JsonRecord;
}

// One identity per PR, workflow, and branch: a re-run or later deploy of the same PR reuses it,
// so INSERT OR IGNORE keeps the first notification even if detection runs again.
export function notifyDeployedPrs(
  run: Pick<WorkflowRunRow, "repo" | "workflow_name" | "head_branch" | "actor_login">,
  occurredAt: string,
  prs: DeployedPr[],
): void {
  const settings = storedNotificationSettings();
  if (!settings.enabled) return;
  const runActor = actor({ login: run.actor_login });
  insertMatchingNotifications(settings, prs.map((pr) => ({
    ...eventBase(
      `deployed:${run.repo}#${pr.number}:${run.workflow_name}:${run.head_branch}`,
      "deployed", run.repo, pr.number, pr.detail, runActor, null, occurredAt,
    ),
    workflow: run.workflow_name,
    branch: run.head_branch,
  })));
}

export function observePrNotifications(previous: DetailRow | null, next: NextDetailRow): void {
  const settings = storedNotificationSettings();
  if (!settings.enabled || !settings.rules.some((rule) => rule.enabled)) return;
  const enabledAt = getSetting("notifications_enabled_at");
  const enabledAtMs = parseTime(enabledAt);
  if (enabledAtMs === null || previous === null) return;
  const previousFetchedAt = parseTime(previous.fetched_at);
  const nextFetchedAt = parseTime(next.fetched_at);
  if (previousFetchedAt !== null && nextFetchedAt !== null && nextFetchedAt < previousFetchedAt) return;

  let previousDetail: JsonRecord | null;
  let nextDetail: JsonRecord | null;
  try {
    previousDetail = record(JSON.parse(previous.detail_json));
    nextDetail = record(JSON.parse(next.detail_json));
  } catch {
    return;
  }
  if (!previousDetail || !nextDetail) return;

  const events = [
    ...commentEvents(previousDetail, nextDetail, next.repo, next.number, enabledAtMs),
    ...reviewEvents(previousDetail, nextDetail, next.repo, next.number, enabledAtMs),
  ];
  if (previousFetchedAt !== null && previousFetchedAt >= enabledAtMs) {
    events.push(...transitionEvents(previousDetail, nextDetail, next.repo, next.number, previous.fetched_at, next.fetched_at));
  }
  insertMatchingNotifications(settings, events);
}

type PendingNotificationRow = DesktopNotification & { event_json: string };

const claimNotificationsTxn = db.transaction((settings: NotificationSettings): DesktopNotification[] => {
  const selectPending = db.query<PendingNotificationRow, []>(`
    SELECT id, event_json, title, body, repo, number
    FROM desktop_notifications
    WHERE claimed_at IS NULL
    ORDER BY created_at, id
    LIMIT 100
  `);
  const claimed: DesktopNotification[] = [];
  const markHandled = db.prepare("UPDATE desktop_notifications SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL");
  const claimedAt = new Date().toISOString();
  while (claimed.length < 20) {
    const pending = selectPending.all();
    if (pending.length === 0) break;
    for (const row of pending) {
      let eligible = false;
      try {
        const event = JSON.parse(row.event_json) as NotificationEvent;
        eligible = matchingNotificationRules(settings, event).length > 0;
      } catch {}
      if (markHandled.run(claimedAt, row.id).changes === 0) continue;
      if (eligible) claimed.push({ id: row.id, title: row.title, body: row.body, repo: row.repo, number: row.number });
      if (claimed.length === 20) break;
    }
  }
  return claimed;
});

export function claimNotifications(): DesktopNotification[] {
  const settings = storedNotificationSettings();
  if (!settings.enabled) return [];
  return claimNotificationsTxn(settings);
}

export function notificationSettingsChanged(): void {
  db.query("UPDATE desktop_notifications SET claimed_at = ? WHERE claimed_at IS NULL").run(new Date().toISOString());
  invalidateNotificationSettings();
}
