import { normalizePrGrouping } from "../../../shared/prGrouping.ts";
import { fetchSettings } from "./api.js";

// Registered only after the opt-in board module loads; recovery outlives its canvas.
export const whiteboardSession = $state({ current: null });

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
  descriptionUnreadDots: false,
  whiteboardEnabled: false,
  safeMergeApprovalEnabled: false,
  groupDragEnabled: false,
  queueTimeControlsEnabled: false,
  restFallbackEnabled: true,
  quickGenerateEnabled: false,
  agentConversationsEnabled: false,
  quickGenerateEnvFile: "",
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
  prefs.descriptionUnreadDots = settings.description_unread_dots === true;
  prefs.whiteboardEnabled = settings.whiteboard_enabled === true;
  prefs.safeMergeApprovalEnabled = settings.safe_merge_approval_enabled === true;
  prefs.groupDragEnabled = settings.group_drag_enabled === true;
  prefs.queueTimeControlsEnabled = settings.queue_time_controls_enabled === true;
  prefs.restFallbackEnabled = settings.rest_fallback_enabled !== false;
  prefs.quickGenerateEnabled = settings.quick_generate_enabled === true;
  prefs.agentConversationsEnabled = settings.agent_conversations_enabled === true;
  prefs.quickGenerateEnvFile = settings.quick_generate_env_file ?? "";
  whiteboardSession.current?.setEnabled(prefs.whiteboardEnabled);
  prefs.loaded = true;
}

export function initPrefs() {
  fetchSettings().then(setPrefs).catch(() => {});
}
