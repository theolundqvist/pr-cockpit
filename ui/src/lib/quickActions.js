import { RESERVED_PR_KEYS } from "./prKeys.js";

// Quick actions are committed to the PR's repository and read at its base commit, e.g.
// {"quickActions": [{"label": "Preview", "comment": "@preview", "key": "P"}, {"label": "Order", "addLabel": "order", "key": "O"}]}
export const QUICK_ACTIONS_PATH = ".github/pr-cockpit.json";

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
