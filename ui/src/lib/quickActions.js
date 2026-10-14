import { QUICK_ACTIONS_PATH } from "../../../shared/quickActions.js";
import { RESERVED_PR_KEYS } from "./prKeys.js";

export { QUICK_ACTIONS_PATH };

export const QUICK_ACTIONS_EXAMPLE = `{
  "quickActions": [
    { "label": "Preview", "comment": "@preview", "key": "P" },
    { "label": "Order", "addLabel": "order", "key": "O" }
  ]
}`;

export const PERSONAL_QUICK_ACTIONS_EXAMPLE = `{
  "quickActions": [
    { "label": "Preview", "key": "V" },
    { "label": "Order", "hidden": true },
    { "label": "Ship it", "comment": "@ship", "key": "S", "repos": ["owner/repo"] }
  ]
}`;

export const QUICK_ACTIONS_AGENT_PROMPT = `Add PR Cockpit quick actions to this repository.

Create or update ${QUICK_ACTIONS_PATH} on the default branch. PR Cockpit reads it from there and shows each entry in the PR sidebar and the PR-row Quick actions submenu for every open PR in the repository. Format:

${QUICK_ACTIONS_EXAMPLE}

Rules:
- Each entry has a "label" (button text) and exactly one of "comment" (posted as a PR comment) or "addLabel" (label added to the PR; GitHub creates it if missing).
- "key" is optional: one character. Uppercase is typed with Shift. Keys PR Cockpit already uses are ignored, so prefer uppercase letters other than A, C, G, J, K, M, T.
- Keep the file valid JSON; PR Cockpit shows an error instead of the buttons otherwise.

The quick actions I want: <describe them, e.g. "Preview comments @preview">`;

function entries(text) {
  const config = JSON.parse(text);
  return Array.isArray(config?.quickActions) ? config.quickActions.filter((entry) => entry && typeof entry === "object") : [];
}

const nameOf = (entry) => String(entry.label ?? entry.comment ?? entry.addLabel ?? "").trim().toLowerCase();

// Personal entries apply to every repository unless they list `repos`. One whose label matches a committed
// action changes only the fields it sets, or removes it with `"hidden": true`; any other adds a new action.
function mergeQuickActionEntries(committed, personal, repo) {
  const merged = [...committed];
  for (const entry of personal) {
    if (Array.isArray(entry.repos) && !entry.repos.includes(repo)) continue;
    const at = merged.findIndex((existing) => nameOf(existing) === nameOf(entry));
    if (entry.hidden === true) {
      if (at >= 0) merged.splice(at, 1);
      continue;
    }
    if (at < 0) {
      merged.push(entry);
      continue;
    }
    // Setting one kind of action replaces the other, so an override can turn a comment into a label.
    const { comment, addLabel, ...base } = merged[at];
    const kind = "comment" in entry || "addLabel" in entry ? {} : { comment, addLabel };
    merged[at] = { ...base, ...kind, ...entry };
  }
  return merged;
}

// Entries need exactly one of `comment` or `addLabel`; a key already owned by the app, an agent, or an earlier action is dropped.
function toQuickActions(list, takenKeys = new Set()) {
  const used = new Set(takenKeys);
  return list.flatMap((entry, index) => {
    const comment = typeof entry.comment === "string" ? entry.comment.trim() : "";
    const label = typeof entry.addLabel === "string" ? entry.addLabel.trim() : "";
    if (!comment === !label) return [];
    const value = comment || label;
    const key = entry.key;
    const keybind = typeof key === "string" && key.length === 1 && key.trim() && !RESERVED_PR_KEYS.has(key) && !used.has(key) ? key : null;
    if (keybind) used.add(keybind);
    const name = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : value;
    return [{ id: String(index), label: name, kind: label ? "label" : "comment", value, keybind }];
  });
}

export function quickActionMutation(kind, value) {
  return kind === "label" ? { kind: "add-labels", labels: [value] } : { kind: "comment", body: value };
}

// `committed` is the repository file's text (null without one), `personal` the user's setting ("" without one).
// A broken source is reported and skipped, so the other still yields its actions.
export function resolveQuickActions({ committed, personal, repo, takenKeys }) {
  const errors = [];
  const read = (text, source) => {
    if (!text) return [];
    try {
      return entries(text);
    } catch {
      errors.push(source);
      return [];
    }
  };
  const list = mergeQuickActionEntries(read(committed, "committed"), read(personal, "personal"), repo);
  return { actions: toQuickActions(list, takenKeys), errors };
}

// Committed config text per repository, so reopening any PR in it shows its buttons at once.
export const committedQuickActionsCache = new Map();
