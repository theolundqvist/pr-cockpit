import { fuzzyMatch } from "./fuzzy.js";

export const PAGE_NAVIGATION = [
  {
    id: "inbox",
    title: "Go to Inbox",
    href: "#/",
    key: "i",
    keyLabel: "cmd+i",
    keywords: "inbox review queue pull requests",
  },
  {
    id: "actions",
    title: "Go to Actions",
    href: "#/actions",
    key: "e",
    keyLabel: "cmd+e",
    keywords: "actions automation workflows runs jobs",
  },
  {
    id: "settings",
    title: "Go to Settings",
    href: "#/settings",
    key: ",",
    keyLabel: "cmd+,",
    keywords: "settings preferences configuration keybinds",
  },
];

export function navigationForShortcut(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return PAGE_NAVIGATION.find((item) => item.key === key) ?? null;
}

export function pageNavigationResults(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return PAGE_NAVIGATION
    .map((item) => {
      const match = fuzzyMatch(normalized, `${item.id} ${item.title} ${item.keywords}`);
      if (!match) return null;
      const prefixBoost = item.id.startsWith(normalized) ? 1_000 : 0;
      const exactBoost = item.id === normalized ? 1_000 : 0;
      return { ...item, kind: "command", score: match.score + prefixBoost + exactBoost };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}
