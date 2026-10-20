import { normalizePrGrouping } from "../../../shared/prGrouping.ts";
import { fetchSettings } from "./api.js";

// Registered only after the opt-in board module loads; recovery outlives its canvas.
export const whiteboardSession = $state({ current: null });

// agents seeded with the built-in keybinds so handlers work before /api/settings resolves
export const prefs = $state({
  loaded: false,
  prGrouping: normalizePrGrouping(null),
  hideSidebar: false,
  hideExcludedDefault: true,
  newestCommentsFirst: false,
  testPathRegex: "",
  diffLayout: "split",
  notificationsEnabled: false,
  pendingReviewsEnabled: true,
  descriptionUnreadDots: true,
  inboxLabels: "off",
  whiteboardEnabled: false,
  commentLinksEnabled: false,
  safeMergeApprovalEnabled: false,
  groupDragEnabled: true,
  queueTimeControlsEnabled: true,
  cookingSectionEnabled: false,
  reviewFileMenuEnabled: true,
  hiddenReviewPaths: {},
  restFallbackEnabled: true,
  quickGenerateEnabled: false,
  askViewEnabled: true,
  agentConversationsEnabled: true,
  quickGenerateEnvFile: "",
  personalQuickActions: "",
  agents: [
    { id: "fixer", name: "Auto-merge fixer", enabled: true, trigger: "keybind", keybind: "a", model: "opus", prompt_template: "" },
    { id: "autofix", name: "Auto-fix", enabled: true, trigger: "keybind", keybind: "f", model: "opus", prompt_template: "" },
  ],
});

export function setPrefs(settings) {
  prefs.prGrouping = normalizePrGrouping(settings.pr_grouping);
  prefs.hideSidebar = settings.hide_sidebar === true;
  prefs.hideExcludedDefault = settings.hide_tests_default;
  prefs.newestCommentsFirst = settings.newest_comments_first === true;
  prefs.testPathRegex = settings.test_path_regex;
  prefs.diffLayout = settings.diff_layout === "unified" ? "unified" : "split";
  prefs.agents = settings.agents;
  prefs.notificationsEnabled = settings.notifications?.enabled === true;
  prefs.pendingReviewsEnabled = settings.pending_reviews_enabled === true;
  prefs.descriptionUnreadDots = settings.description_unread_dots === true;
  prefs.inboxLabels = settings.inbox_labels === "dot" || settings.inbox_labels === "name" ? settings.inbox_labels : "off";
  prefs.whiteboardEnabled = settings.whiteboard_enabled === true;
  prefs.commentLinksEnabled = settings.comment_links_enabled === true;
  prefs.safeMergeApprovalEnabled = settings.safe_merge_approval_enabled === true;
  prefs.groupDragEnabled = settings.group_drag_enabled === true;
  prefs.cookingSectionEnabled = settings.cooking_section_enabled === true;
  prefs.queueTimeControlsEnabled = settings.queue_time_controls_enabled === true;
  prefs.reviewFileMenuEnabled = settings.review_file_menu_enabled === true;
  prefs.hiddenReviewPaths = settings.hidden_review_paths ?? {};
  prefs.restFallbackEnabled = settings.rest_fallback_enabled !== false;
  prefs.quickGenerateEnabled = settings.quick_generate_enabled === true;
  prefs.askViewEnabled = settings.ask_view_enabled === true;
  prefs.agentConversationsEnabled = settings.agent_conversations_enabled === true;
  prefs.quickGenerateEnvFile = settings.quick_generate_env_file ?? "";
  prefs.personalQuickActions = settings.personal_quick_actions ?? "";
  whiteboardSession.current?.setEnabled(prefs.whiteboardEnabled);
  prefs.loaded = true;
}

export function initPrefs() {
  fetchSettings().then(setPrefs).catch(() => {});
}
