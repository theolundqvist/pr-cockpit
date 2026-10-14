import { RESERVED_PR_KEYS } from "./prKeys.js";

// Quick actions are committed to the PR's repository and read at its base commit.
export const QUICK_ACTIONS_PATH = ".github/pr-cockpit.json";

export const QUICK_ACTIONS_EXAMPLE = `{
  "quickActions": [
    { "label": "Preview", "comment": "@preview", "key": "P" },
    { "label": "Order", "addLabel": "order", "key": "O" }
  ]
}`;

export const QUICK_ACTIONS_AGENT_PROMPT = `Add PR Cockpit quick actions to this repository.

Create or update ${QUICK_ACTIONS_PATH} on the default branch (and any other branch PRs merge into). PR Cockpit reads it from a PR's base branch and shows each entry in the PR sidebar and the PR-row Quick actions submenu. Format:

${QUICK_ACTIONS_EXAMPLE}

Rules:
- Each entry has a "label" (button text) and exactly one of "comment" (posted as a PR comment) or "addLabel" (label added to the PR; GitHub creates it if missing).
- "key" is optional: one character. Uppercase is typed with Shift. Keys PR Cockpit already uses are ignored, so prefer uppercase letters other than A, C, G, J, K, M, T.
- Keep the file valid JSON; PR Cockpit shows an error instead of the buttons otherwise.

The quick actions I want: <describe them, e.g. "Preview comments @preview">`;

// Throws on invalid JSON so the sidebar can say the file is broken. Entries need exactly one of
// `comment` or `addLabel`; a key already owned by the app, an agent, or an earlier action is dropped.
export function parseQuickActions(text, takenKeys = new Set()) {
  const config = JSON.parse(text);
  const list = Array.isArray(config?.quickActions) ? config.quickActions : [];
  const used = new Set(takenKeys);
  return list.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
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
