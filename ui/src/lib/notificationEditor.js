import { NOTIFICATION_FIELDS } from "../../../shared/notificationRules.ts";

// Draft rules mirror shared NotificationRule but may be incomplete while editing;
// issues block Save, and the server re-validates with parseNotificationSettings.

export function newNotificationCondition(field = "actorType") {
  const definition = NOTIFICATION_FIELDS[field];
  return { field, operator: definition.operators[0], value: definition.options[0] ?? "" };
}

export function retargetNotificationCondition(condition, field) {
  if (condition.field === field) return condition;
  const next = newNotificationCondition(field);
  const definition = NOTIFICATION_FIELDS[field];
  if (definition.operators.includes(condition.operator)) next.operator = condition.operator;
  return next;
}

export function newNotificationRule(overrides = {}) {
  return { id: crypto.randomUUID(), name: "", enabled: true, events: [], match: "all", conditions: [], ...overrides };
}

// Starting points the user edits; adding one never flips the master switch and still needs Save.
export const NOTIFICATION_EXAMPLES = [
  {
    id: "human-comments",
    label: "Human comments mentioning me",
    hint: "Comments by people, not bots, whose text contains your @login.",
    build: (viewerLogin) => newNotificationRule({
      name: "Human comments mentioning me",
      events: ["comment"],
      match: "all",
      conditions: [
        { field: "actorType", operator: "is", value: "human" },
        { field: "body", operator: "contains", value: viewerLogin ? `@${viewerLogin}` : "" },
      ],
    }),
  },
  {
    id: "review-requests",
    label: "Review requests on ready PRs",
    hint: "Someone asked you to review a pull request that is not a draft.",
    build: () => newNotificationRule({
      name: "Review requests on ready PRs",
      events: ["review_requested"],
      match: "all",
      conditions: [{ field: "isDraft", operator: "is", value: "false" }],
    }),
  },
  {
    id: "my-deploys",
    label: "My PRs deployed",
    hint: "Your merged pull requests once a successful run of your deploy workflow ships them. Name the workflow and branch.",
    build: () => newNotificationRule({
      name: "My PRs deployed",
      events: ["deployed"],
      match: "all",
      conditions: [
        { field: "participation", operator: "is", value: "author" },
        { field: "workflow", operator: "is", value: "" },
        { field: "branch", operator: "is", value: "" },
      ],
    }),
  },
];

export function notificationRuleIssues(rules) {
  const issues = new Map();
  for (const rule of rules) {
    if (!rule.name.trim()) issues.set(rule.id, "Give this rule a name.");
    else if (rule.events.length === 0) issues.set(rule.id, "Choose at least one event.");
    else if (rule.conditions.some((condition) => !condition.value.trim())) issues.set(rule.id, "Fill in every condition value, or remove the empty condition.");
  }
  return issues;
}

export function serializeNotificationSettings(settings) {
  return {
    enabled: settings.enabled === true,
    rules: settings.rules.map((rule) => ({
      id: rule.id,
      name: rule.name.trim(),
      enabled: rule.enabled === true,
      events: [...rule.events],
      match: rule.match === "any" ? "any" : "all",
      conditions: rule.conditions.map((condition) => ({ field: condition.field, operator: condition.operator, value: condition.value.trim() })),
    })),
  };
}
