import { normalizePrGrouping } from "../../../shared/prGrouping.ts";
import { fetchSettings } from "./api.js";

// agents seeded with the built-in keybinds so handlers work before /api/settings resolves
export const prefs = $state({
  loaded: false,
  prGrouping: normalizePrGrouping(null),
  hideSidebar: false,
  hideTestsDefault: false,
  newestCommentsFirst: false,
  testPathRegex: "",
  diffLayout: "split",
  notificationsEnabled: false,
  pendingReviewsEnabled: false,
  agents: [
    { id: "fixer", name: "Auto-merge fixer", enabled: true, trigger: "keybind", keybind: "a", model: "opus", prompt_template: "" },
    { id: "autofix", name: "Auto-fix", enabled: true, trigger: "keybind", keybind: "f", model: "opus", prompt_template: "" },
  ],
});

export function setPrefs(settings) {
  prefs.prGrouping = normalizePrGrouping(settings.pr_grouping);
  prefs.hideSidebar = settings.hide_sidebar === true;
  prefs.hideTestsDefault = settings.hide_tests_default;
  prefs.newestCommentsFirst = settings.newest_comments_first === true;
  prefs.testPathRegex = settings.test_path_regex;
  prefs.diffLayout = settings.diff_layout === "unified" ? "unified" : "split";
  prefs.agents = settings.agents;
  prefs.notificationsEnabled = settings.notifications?.enabled === true;
  prefs.pendingReviewsEnabled = settings.pending_reviews_enabled === true;
  prefs.loaded = true;
}

export function initPrefs() {
  fetchSettings().then(setPrefs).catch(() => {});
}
