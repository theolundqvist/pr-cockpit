import { getSetting, setSetting } from "./db.ts";
import { detectHarness, normalizeHarness, type Harness } from "./harness.ts";
import desktopShortcuts from "../shared/desktopShortcuts.json";

const POLL_INTERVAL_FLOOR_S = 60;
const DEFAULT_POLL_INTERVAL_S = 180;
const envRepos = Bun.env.COCKPIT_REPOS ?? "";
const envRepoRoots = Bun.env.COCKPIT_REPO_ROOTS ?? "";
const envReviewBots = Bun.env.COCKPIT_REVIEW_BOTS ?? "[]";
const envReplicaSshHost = Bun.env.COCKPIT_REPLICA_SSH_HOST ?? Bun.env.COCKPIT_PROXY ?? "";

export type AgentTrigger = "keybind" | "activity";
export type AgentModel = "opus" | "sonnet";
export type ThemePreference = "system" | "dark" | "light";
export type FontPreference = "default" | "alacritty";
export type CodeTheme = "github" | "catppuccin";
export type DiffLayout = "unified" | "split";

export interface AgentSetting {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AgentTrigger;
  keybind: string | null;
  model: AgentModel;
  prompt_template: string;
}

// model defaults match what each spawn hardcoded before it was configurable
export const AGENT_DEFAULTS: AgentSetting[] = [
  { id: "fixer", name: "Auto-merge fixer", enabled: true, trigger: "keybind", keybind: "a", model: "opus", prompt_template: "" },
  { id: "autofix", name: "Auto-fix", enabled: true, trigger: "keybind", keybind: "f", model: "opus", prompt_template: "" },
  { id: "rescorer", name: "Greptile re-scorer", enabled: true, trigger: "activity", keybind: null, model: "sonnet", prompt_template: "" },
];

export const CUSTOM_AGENT_ID_PREFIX = "custom-";

// a single printable character, matched against KeyboardEvent.key in the UI handlers
function sanitizeKeybind(value: unknown): string | null {
  return typeof value === "string" && value.length === 1 && value.trim().length === 1 ? value : null;
}

function sanitizeTrigger(value: unknown, fallback: AgentTrigger): AgentTrigger {
  return value === "keybind" || value === "activity" ? value : fallback;
}

function sanitizeModel(value: unknown, fallback: AgentModel): AgentModel {
  return value === "opus" || value === "sonnet" ? value : fallback;
}

// every field is user-editable; invalid values fall back per field - to the built-in's default, or to a safe shape for customs
export function mergeAgents(overrides: unknown): AgentSetting[] {
  const list = Array.isArray(overrides) ? (overrides as Array<Record<string, unknown> | null>) : [];
  const sanitize = (o: Record<string, unknown>, def: AgentSetting): AgentSetting => ({
    id: def.id,
    name: typeof o.name === "string" && o.name.trim() ? o.name : def.name,
    enabled: o.enabled !== false,
    trigger: sanitizeTrigger(o.trigger, def.trigger),
    keybind: sanitizeKeybind(o.keybind) ?? def.keybind,
    model: sanitizeModel(o.model, def.model),
    prompt_template: typeof o.prompt_template === "string" ? o.prompt_template : "",
  });
  const builtins = AGENT_DEFAULTS.map((def) => {
    const o = list.find((a) => a?.id === def.id);
    return o ? sanitize(o, def) : def;
  });
  const customs = list.flatMap((o): AgentSetting[] => {
    if (!o || typeof o.id !== "string" || !o.id.startsWith(CUSTOM_AGENT_ID_PREFIX)) return [];
    return [sanitize(o, { id: o.id, name: "", enabled: true, trigger: "keybind", keybind: null, model: "opus", prompt_template: "" })];
  });
  return [...builtins, ...customs];
}

export function agentSettings(): AgentSetting[] {
  const raw = getSetting("agents");
  return raw === null ? AGENT_DEFAULTS : mergeAgents(JSON.parse(raw));
}

export function agentEnabled(id: string): boolean {
  return agentSettings().some((a) => a.id === id && a.enabled);
}

export function agentPromptTemplate(id: string): string {
  return agentSettings().find((a) => a.id === id)?.prompt_template ?? "";
}

export function agentModel(id: string): AgentModel {
  return agentSettings().find((a) => a.id === id)?.model ?? "opus";
}

const parseRepos = (raw: string): string[] => raw.split(",").map((r) => r.trim()).filter(Boolean);

const clampInterval = (raw: number): number =>
  Number.isFinite(raw) ? Math.max(POLL_INTERVAL_FLOOR_S, Math.floor(raw)) : DEFAULT_POLL_INTERVAL_S;

export function normalizeScale(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return 100;
  const scale = Number(value);
  return Number.isFinite(scale) ? Math.min(200, Math.max(50, Math.round(scale))) : 100;
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function normalizeFontPreference(value: unknown): FontPreference {
  return value === "alacritty" ? "alacritty" : "default";
}

export function normalizeCodeTheme(value: unknown): CodeTheme {
  return value === "catppuccin" ? "catppuccin" : "github";
}

export function normalizeDiffLayout(value: unknown): DiffLayout {
  return value === "unified" || value === "split" ? value : "split";
}

export function normalizeReplicaSshHost(value: unknown): string {
  if (typeof value !== "string") return "";
  const host = value.trim().replace(/^ssh:\/\//, "").replace(/\/$/, "");
  return /^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/.test(host) ? host : "";
}

export function seedSettings(): void {
  if (getSetting("repos") === null) setSetting("repos", envRepos);
  if (getSetting("poll_interval_s") === null) setSetting("poll_interval_s", String(DEFAULT_POLL_INTERVAL_S));
  if (getSetting("replica_ssh_host") === null) setSetting("replica_ssh_host", normalizeReplicaSshHost(envReplicaSshHost));
  if (getSetting("default_repo") === null) setSetting("default_repo", parseRepos(getSetting("repos") ?? "")[0] ?? "");
  if (getSetting("per_view_window_size") === null) setSetting("per_view_window_size", "false");
  if (getSetting("per_view_window_position") === null) setSetting("per_view_window_position", "false");
  if (getSetting("theme") === null) setSetting("theme", "system");
  if (getSetting("font_interface") === null) setSetting("font_interface", "default");
  // the single "font" preference became one toggle per surface; carry the old choice onto all three
  const legacyFont = normalizeFontPreference(getSetting("font"));
  for (const key of ["font_ui", "font_code", "font_comments"]) {
    if (getSetting(key) === null) setSetting(key, legacyFont);
  }
  if (getSetting("code_theme") === null) setSetting("code_theme", "github");
  if (getSetting("general_scale") === null) setSetting("general_scale", "100");
  if (getSetting("diff_scale") === null) setSetting("diff_scale", "100");
  if (getSetting("hide_sidebar") === null) setSetting("hide_sidebar", "false");
  if (getSetting("hide_tests_default") === null) setSetting("hide_tests_default", "false");
  if (getSetting("newest_comments_first") === null) setSetting("newest_comments_first", "false");
  if (getSetting("test_path_regex") === null) setSetting("test_path_regex", "");
  if (getSetting("diff_layout") === null) setSetting("diff_layout", "split");
  if (getSetting("force_merge_repos") === null) setSetting("force_merge_repos", "");
  if (getSetting("review_bots") === null) setSetting("review_bots", envReviewBots);
  // migrates the pre-list per-agent keys (fixer_enabled, autofix_prompt_template, …) into the agents list
  if (getSetting("agents") === null) {
    const migrated = AGENT_DEFAULTS.map((def) => ({
      ...def,
      enabled: getSetting(`${def.id}_enabled`) !== "false",
      prompt_template: getSetting(`${def.id}_prompt_template`) ?? "",
    }));
    setSetting("agents", JSON.stringify(migrated));
  }
  if (getSetting("keybind_platform_defaults_migrated") !== "true") {
    const openApp = getSetting("keybind_open_app");
    const openPalette = getSetting("keybind_open_palette");
    if (openApp === null || openApp === desktopShortcuts.darwin.openApp) setSetting("keybind_open_app", "");
    if (openPalette === null || openPalette === desktopShortcuts.darwin.openPalette || openPalette === "Option+K") {
      setSetting("keybind_open_palette", "");
    }
    setSetting("keybind_platform_defaults_migrated", "true");
  }
  if (getSetting("saved_views") === null) setSetting("saved_views", "[]");
  if (getSetting("repo_roots") === null) setSetting("repo_roots", envRepoRoots);
  if (getSetting("cockpit_webhooks") === null) setSetting("cockpit_webhooks", "false");
  // first launch prefers omp when it is installed - see harness.ts
  if (getSetting("agent_harness") === null) setSetting("agent_harness", detectHarness());
}

export function cockpitWebhooksEnabled(): boolean {
  return getSetting("cockpit_webhooks") === "true";
}

const DEFAULT_RELAY_URL = "https://relay.prcockpit.com";
const LEGACY_RELAY_URL = "https://pr-cockpit-relay.theodor-lundqvist.workers.dev";
export const RELAY_APP_SLUG = "pr-cockpit-relay";
export const RELAY_APP_INSTALL_URL = `https://github.com/apps/${RELAY_APP_SLUG}/installations/new`;

// explicit empty-string setting means relay off — only null falls through to env/default
export function relayConfig(): { url: string } {
  const url = (getSetting("relay_url") ?? Bun.env.COCKPIT_RELAY_URL ?? DEFAULT_RELAY_URL).replace(/\/+$/, "");
  return { url: url === LEGACY_RELAY_URL ? DEFAULT_RELAY_URL : url };
}

export function forceMergeEnabled(repo: string): boolean {
  return parseRepos(getSetting("force_merge_repos") ?? "").includes(repo);
}

export function settingsRepos(): string[] {
  return parseRepos(getSetting("repos") ?? envRepos);
}

export function settingsRepoRoots(): string[] {
  return parseRepos(getSetting("repo_roots") ?? envRepoRoots);
}

export function pollIntervalMs(): number {
  return clampInterval(Number(getSetting("poll_interval_s"))) * 1000;
}

export interface Settings {
  desktop_platform: string;
  repos: string;
  default_repo: string;
  poll_interval_s: number;
  replica_ssh_host: string;
  per_view_window_size: boolean;
  per_view_window_position: boolean;
  theme: ThemePreference;
  font_interface: FontPreference;
  font_ui: FontPreference;
  font_code: FontPreference;
  font_comments: FontPreference;
  code_theme: CodeTheme;
  general_scale: number;
  diff_scale: number;
  hide_sidebar: boolean;
  hide_tests_default: boolean;
  newest_comments_first: boolean;
  test_path_regex: string;
  diff_layout: DiffLayout;
  force_merge_repos: string;
  agents: AgentSetting[];
  review_bots: string;
  keybind_open_app: string;
  keybind_open_palette: string;
  saved_views: string;
  repo_roots: string;
  cockpit_webhooks: boolean;
  agent_harness: Harness;
  relay_url: string;
}

export function readSettings(): Settings {
  const storedReplicaSshHost = getSetting("replica_ssh_host");
  return {
    desktop_platform: process.platform,
    repos: getSetting("repos") ?? envRepos,
    default_repo: getSetting("default_repo") ?? "",
    poll_interval_s: clampInterval(Number(getSetting("poll_interval_s"))),
    replica_ssh_host: Bun.env.COCKPIT_REPLICA_OVERRIDE === "1"
      ? normalizeReplicaSshHost(envReplicaSshHost)
      : normalizeReplicaSshHost(storedReplicaSshHost === null ? envReplicaSshHost : storedReplicaSshHost),
    per_view_window_size: getSetting("per_view_window_size") === "true",
    per_view_window_position: getSetting("per_view_window_position") === "true",
    theme: normalizeThemePreference(getSetting("theme")),
    font_interface: normalizeFontPreference(getSetting("font_interface")),
    font_ui: normalizeFontPreference(getSetting("font_ui")),
    font_code: normalizeFontPreference(getSetting("font_code")),
    font_comments: normalizeFontPreference(getSetting("font_comments")),
    code_theme: normalizeCodeTheme(getSetting("code_theme")),
    general_scale: normalizeScale(getSetting("general_scale")),
    diff_scale: normalizeScale(getSetting("diff_scale")),
    hide_sidebar: getSetting("hide_sidebar") === "true",
    hide_tests_default: getSetting("hide_tests_default") === "true",
    newest_comments_first: getSetting("newest_comments_first") === "true",
    test_path_regex: getSetting("test_path_regex") ?? "",
    diff_layout: normalizeDiffLayout(getSetting("diff_layout")),
    force_merge_repos: getSetting("force_merge_repos") ?? "",
    review_bots: getSetting("review_bots") ?? envReviewBots,
    agents: agentSettings(),
    keybind_open_app: getSetting("keybind_open_app") ?? "",
    keybind_open_palette: getSetting("keybind_open_palette") ?? "",
    saved_views: getSetting("saved_views") ?? "[]",
    repo_roots: getSetting("repo_roots") ?? envRepoRoots,
    cockpit_webhooks: getSetting("cockpit_webhooks") === "true",
    agent_harness: normalizeHarness(getSetting("agent_harness")),
    relay_url: relayConfig().url,
  };
}

export function writeSettings(
  patch: Partial<{
    repos: string;
    default_repo: string;
    poll_interval_s: number;
    replica_ssh_host: string;
    per_view_window_size: boolean;
    per_view_window_position: boolean;
    theme: string;
    font_interface: string;
    font_ui: string;
    font_code: string;
    font_comments: string;
    code_theme: string;
    general_scale: number;
    diff_scale: number;
    hide_sidebar: boolean;
    hide_tests_default: boolean;
    newest_comments_first: boolean;
    test_path_regex: string;
    diff_layout: string;
    force_merge_repos: string;
    agents: AgentSetting[];
    review_bots: string;
    keybind_open_app: string;
    keybind_open_palette: string;
    saved_views: string;
    repo_roots: string;
    cockpit_webhooks: boolean;
    agent_harness: string;
    relay_url: string;
  }>,
): Settings {
  const replicaSshHost = patch.replica_ssh_host === undefined
    ? undefined
    : normalizeReplicaSshHost(patch.replica_ssh_host);
  if (replicaSshHost === "" && (typeof patch.replica_ssh_host !== "string" || patch.replica_ssh_host.trim() !== "")) {
    throw new Error("invalid replica SSH host");
  }
  if (patch.repos !== undefined) setSetting("repos", patch.repos);
  if (patch.default_repo !== undefined) setSetting("default_repo", patch.default_repo);
  if (patch.poll_interval_s !== undefined) setSetting("poll_interval_s", String(clampInterval(Number(patch.poll_interval_s))));
  if (replicaSshHost !== undefined) setSetting("replica_ssh_host", replicaSshHost);
  if (patch.per_view_window_size !== undefined) setSetting("per_view_window_size", patch.per_view_window_size ? "true" : "false");
  if (patch.per_view_window_position !== undefined) setSetting("per_view_window_position", patch.per_view_window_position ? "true" : "false");
  if (patch.theme !== undefined) setSetting("theme", normalizeThemePreference(patch.theme));
  if (patch.font_interface !== undefined) setSetting("font_interface", normalizeFontPreference(patch.font_interface));
  if (patch.font_ui !== undefined) setSetting("font_ui", normalizeFontPreference(patch.font_ui));
  if (patch.font_code !== undefined) setSetting("font_code", normalizeFontPreference(patch.font_code));
  if (patch.font_comments !== undefined) setSetting("font_comments", normalizeFontPreference(patch.font_comments));
  if (patch.code_theme !== undefined) setSetting("code_theme", normalizeCodeTheme(patch.code_theme));
  if (patch.general_scale !== undefined) setSetting("general_scale", String(normalizeScale(patch.general_scale)));
  if (patch.diff_scale !== undefined) setSetting("diff_scale", String(normalizeScale(patch.diff_scale)));
  if (patch.hide_sidebar !== undefined) setSetting("hide_sidebar", patch.hide_sidebar ? "true" : "false");
  if (patch.hide_tests_default !== undefined) setSetting("hide_tests_default", patch.hide_tests_default ? "true" : "false");
  if (patch.newest_comments_first !== undefined) setSetting("newest_comments_first", patch.newest_comments_first ? "true" : "false");
  if (patch.test_path_regex !== undefined) setSetting("test_path_regex", patch.test_path_regex);
  if (patch.diff_layout !== undefined) setSetting("diff_layout", normalizeDiffLayout(patch.diff_layout));
  if (patch.force_merge_repos !== undefined) setSetting("force_merge_repos", patch.force_merge_repos);
  if (patch.agents !== undefined) setSetting("agents", JSON.stringify(mergeAgents(patch.agents)));
  if (patch.review_bots !== undefined) setSetting("review_bots", patch.review_bots);
  if (patch.keybind_open_app !== undefined) setSetting("keybind_open_app", patch.keybind_open_app);
  if (patch.keybind_open_palette !== undefined) setSetting("keybind_open_palette", patch.keybind_open_palette);
  if (patch.saved_views !== undefined) setSetting("saved_views", patch.saved_views);
  if (patch.repo_roots !== undefined) setSetting("repo_roots", patch.repo_roots);
  if (patch.cockpit_webhooks !== undefined) setSetting("cockpit_webhooks", patch.cockpit_webhooks ? "true" : "false");
  if (patch.agent_harness !== undefined) setSetting("agent_harness", normalizeHarness(patch.agent_harness));
  if (patch.relay_url !== undefined) setSetting("relay_url", patch.relay_url.trim());
  return readSettings();
}
