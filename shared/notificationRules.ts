export const NOTIFICATION_EVENTS = [
  { id: "comment", label: "Comment posted" },
  { id: "review", label: "Review submitted" },
  { id: "review_requested", label: "Review requested from me" },
  { id: "checks_failed", label: "Checks failed" },
  { id: "merged", label: "Pull request merged" },
  { id: "closed", label: "Pull request closed" },
  { id: "reopened", label: "Pull request reopened" },
  { id: "ready_for_review", label: "Ready for review" },
  { id: "deployed", label: "Pull request deployed" },
] as const;

export const NOTIFICATION_FIELDS = {
  actorType: { label: "Author type", operators: ["is", "isNot"], options: ["human", "bot"] },
  actor: { label: "Event author", operators: ["is", "isNot"], options: [] },
  repository: { label: "Repository", operators: ["is", "isNot", "contains", "notContains"], options: [] },
  prAuthor: { label: "PR author", operators: ["is", "isNot"], options: [] },
  title: { label: "PR title", operators: ["is", "isNot", "contains", "notContains"], options: [] },
  body: { label: "Comment or review text", operators: ["is", "isNot", "contains", "notContains"], options: [] },
  participation: { label: "My relationship to the PR", operators: ["is", "isNot"], options: ["author", "assignee", "reviewer"] },
  reviewState: { label: "Review outcome", operators: ["is", "isNot"], options: ["approved", "changes_requested", "commented", "dismissed"] },
  isDraft: { label: "Draft PR", operators: ["is", "isNot"], options: ["true", "false"] },
  workflow: { label: "Deploy workflow", operators: ["is", "isNot", "contains", "notContains"], options: [] },
  branch: { label: "Deployed branch", operators: ["is", "isNot"], options: [] },
} as const;

export type NotificationEventType = typeof NOTIFICATION_EVENTS[number]["id"];
export type NotificationField = keyof typeof NOTIFICATION_FIELDS;
export type NotificationOperator = "is" | "isNot" | "contains" | "notContains";
export interface NotificationCondition {
  field: NotificationField;
  operator: NotificationOperator;
  value: string;
}
export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  events: NotificationEventType[];
  match: "all" | "any";
  conditions: NotificationCondition[];
}
export interface NotificationSettings {
  enabled: boolean;
  rules: NotificationRule[];
}
export interface NotificationEvent {
  id: string;
  type: NotificationEventType;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  actor: { login: string | null; type: "human" | "bot" | "unknown" };
  prAuthor: string | null;
  viewerLogin: string;
  viewerIsAuthor: boolean;
  viewerIsAssignee: boolean;
  viewerReviewRequested: boolean;
  reviewState: string | null;
  isDraft: boolean;
  occurredAt: string;
  // Set only on deployed events: the deploying run's workflow name and branch.
  workflow?: string | null;
  branch?: string | null;
}

export function defaultNotificationSettings(): NotificationSettings {
  return { enabled: false, rules: [] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseNotificationSettings(value: unknown): NotificationSettings {
  if (!record(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.rules)) {
    throw new TypeError("Notifications must have an enabled setting and a list of rules");
  }
  const ids = new Set<string>();
  const events = new Set<string>(NOTIFICATION_EVENTS.map((event) => event.id));
  const rules = value.rules.map((rule): NotificationRule => {
    if (!record(rule) || typeof rule.id !== "string" || !rule.id.trim() || ids.has(rule.id)
      || typeof rule.name !== "string" || !rule.name.trim() || typeof rule.enabled !== "boolean"
      || (rule.match !== "all" && rule.match !== "any") || !Array.isArray(rule.events)
      || rule.events.length === 0 || rule.events.some((event) => typeof event !== "string" || !events.has(event))
      || !Array.isArray(rule.conditions)) {
      throw new TypeError("Each notification rule needs a unique ID, name, event types, and valid conditions");
    }
    ids.add(rule.id);
    const conditions = rule.conditions.map((condition): NotificationCondition => {
      if (!record(condition) || typeof condition.field !== "string"
        || !Object.hasOwn(NOTIFICATION_FIELDS, condition.field)
        || typeof condition.operator !== "string" || typeof condition.value !== "string" || !condition.value.trim()) {
        throw new TypeError(`Invalid condition in notification rule “${rule.name}”`);
      }
      const field = condition.field as NotificationField;
      const definition = NOTIFICATION_FIELDS[field];
      if (!(definition.operators as readonly string[]).includes(condition.operator)
        || (definition.options.length > 0 && !(definition.options as readonly string[]).includes(condition.value))) {
        throw new TypeError(`Invalid ${definition.label.toLowerCase()} condition in notification rule “${rule.name}”`);
      }
      return { field, operator: condition.operator as NotificationOperator, value: condition.value };
    });
    return {
      id: rule.id, name: rule.name.trim(), enabled: rule.enabled,
      events: [...new Set(rule.events)] as NotificationEventType[], match: rule.match, conditions,
    };
  });
  return { enabled: value.enabled, rules };
}

function conditionMatches(condition: NotificationCondition, event: NotificationEvent): boolean {
  let actual: string | null;
  let expected = condition.value;
  switch (condition.field) {
    case "actorType": actual = event.actor.type === "unknown" ? null : event.actor.type; break;
    case "actor": actual = event.actor.login; break;
    case "repository": actual = event.repo; break;
    case "prAuthor": actual = event.prAuthor; break;
    case "title": actual = event.title; break;
    case "body": actual = event.body; break;
    case "reviewState": actual = event.reviewState; break;
    case "isDraft": actual = String(event.isDraft); break;
    case "workflow": actual = event.workflow ?? null; break;
    case "branch": actual = event.branch ?? null; break;
    case "participation": {
      const related = condition.value === "author" ? event.viewerIsAuthor
        : condition.value === "assignee" ? event.viewerIsAssignee : event.viewerReviewRequested;
      return condition.operator === "is" ? related : !related;
    }
  }
  if (actual === null) return false;
  if ((condition.field === "actor" || condition.field === "prAuthor") && expected === "$me") {
    expected = event.viewerLogin;
    if (!expected) return false;
  }
  actual = actual.toLowerCase();
  expected = expected.toLowerCase();
  switch (condition.operator) {
    case "is": return actual === expected;
    case "isNot": return actual !== expected;
    case "contains": return actual.includes(expected);
    case "notContains": return !actual.includes(expected);
  }
}

export function notificationRuleMatches(rule: NotificationRule, event: NotificationEvent): boolean {
  if (!rule.enabled || !rule.events.includes(event.type)) return false;
  if (rule.conditions.length === 0) return true;
  return rule.match === "all"
    ? rule.conditions.every((condition) => conditionMatches(condition, event))
    : rule.conditions.some((condition) => conditionMatches(condition, event));
}

export function matchingNotificationRules(settings: NotificationSettings, event: NotificationEvent): NotificationRule[] {
  return settings.enabled ? settings.rules.filter((rule) => notificationRuleMatches(rule, event)) : [];
}

// Deploy detection walks git history, so a run no enabled `deployed` rule can match by its
// workflow and branch alone is dismissed before any pull request is considered.
export function deployRunMayMatch(settings: NotificationSettings, workflow: string, branch: string): boolean {
  if (!settings.enabled) return false;
  const probe = { workflow, branch } as NotificationEvent;
  const holds = (condition: NotificationCondition) =>
    (condition.field !== "workflow" && condition.field !== "branch") || conditionMatches(condition, probe);
  return settings.rules.some((rule) => {
    if (!rule.enabled || !rule.events.includes("deployed")) return false;
    if (rule.conditions.length === 0) return true;
    return rule.match === "all" ? rule.conditions.every(holds) : rule.conditions.some(holds);
  });
}
