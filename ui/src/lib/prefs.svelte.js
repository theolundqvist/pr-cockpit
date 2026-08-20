import { fetchSettings } from "./api.js";

// agents seeded with the built-in keybinds so handlers work before /api/settings resolves
export const prefs = $state({
  loaded: false,
  hideSidebar: false,
  hideTestsDefault: false,
  newestCommentsFirst: false,
  testPathRegex: "",
  diffLayout: "split",
  agents: [
    { id: "fixer", name: "Auto-merge fixer", enabled: true, trigger: "keybind", keybind: "a", model: "opus", prompt_template: "" },
    { id: "autofix", name: "Auto-fix", enabled: true, trigger: "keybind", keybind: "f", model: "opus", prompt_template: "" },
  ],
});

export function setPrefs(settings) {
  prefs.hideSidebar = settings.hide_sidebar === true;
  prefs.hideTestsDefault = settings.hide_tests_default;
  prefs.newestCommentsFirst = settings.newest_comments_first === true;
  prefs.testPathRegex = settings.test_path_regex;
  prefs.diffLayout = settings.diff_layout === "unified" ? "unified" : "split";
  prefs.agents = settings.agents;
  prefs.loaded = true;
}

export function initPrefs() {
  fetchSettings().then(setPrefs).catch(() => {});
}
