<script>
  import { normalizePrGrouping } from "../../../shared/prGrouping.ts";
  import { fetchRelayCoverage, fetchRelayStatus, fetchSettings, saveSettings } from "./api.js";
  import { cachedView, cacheView } from "./detailCache.js";
  import { setCodeTheme, setFonts, setScales, setTheme } from "./theme.svelte.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { BUILTIN_TEST_PATH } from "./testPath.js";
  import { isTypingTarget } from "./dom.js";
  import { scrollStep, scrollPage, scrollEdge } from "./scroll.js";
  import KeyBar from "./KeyBar.svelte";
  import ShortcutInput from "./ShortcutInput.svelte";
  import Kbd from "./Kbd.svelte";
  import SettingsAnalytics from "./SettingsAnalytics.svelte";
  import SettingsNotifications from "./SettingsNotifications.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import { notificationRuleIssues, serializeNotificationSettings } from "./notificationEditor.js";
  import { defaultNotificationSettings } from "../../../shared/notificationRules.ts";
  import { SETTINGS_SECTION_KEY, SETTINGS_SECTIONS, normalizeSettingsSection, settingsSectionHref } from "./settingsSections.js";
  import { desktopShortcutDefaults, shortcutsClash } from "./shortcutPlatform.js";
  import { tailscaleAccess } from "./tailscaleAccess.js";
  let { onRunSetup, section = "general" } = $props();


  let grouping = $state(normalizePrGrouping(null));
  let repos = $state("");
  let defaultRepo = $state("");
  let pollInterval = $state(180);
  let perViewWindowSize = $state(false);
  let perViewWindowPosition = $state(false);
  let themeName = $state("system");
  let fontInterface = $state("default");
  let fontUi = $state("default");
  let fontCode = $state("default");
  let fontComments = $state("default");
  let codeTheme = $state("github");
  let generalScale = $state(100);
  let diffScale = $state(100);
  let hideSidebar = $state(false);
  let hideTestsDefault = $state(false);
  let newestCommentsFirst = $state(false);
  let pendingReviewsEnabled = $state(false);
  let testPathRegex = $state("");
  let diffLayout = $state("split");
  let forceMergeRepos = $state([]);
  let agentHarness = $state("claude");
  let harnessAvailable = $state({ claude: true, omp: true, codex: true });
  let agents = $state([]);
  let keybindOpenApp = $state("");
  let keybindOpenPalette = $state("");
  let relayUrl = $state("");
  let desktopPlatform = $state("darwin");
  let replicaSshHost = $state("");
  let notifications = $state(defaultNotificationSettings());
  let relayInfo = $state(cachedView("relayStatus"));
  let relayCoverage = $state(cachedView("relayCoverage"));
  let health = $state(null);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state(null);

  let activeTab = $derived(normalizeSettingsSection(section));
  let activeSection = $derived(SETTINGS_SECTIONS.find((item) => item.id === activeTab));
  let privateAccess = $derived(tailscaleAccess(health));
  let notificationIssues = $derived(notificationRuleIssues(notifications.rules));

  $effect(() => localStorage.setItem(SETTINGS_SECTION_KEY, activeTab));

  // UI copy for the built-in agents, keyed by agent id; definitions (enabled, trigger, keybind, prompt) come from the server
  const AGENT_META = {
    fixer: {
      description: "Fixes conflicts, checks and review threads, then merges.",
    },
    autofix: {
      description: "Fixes conflicts, checks and review threads. Never merges.",
    },
  };

  const toLines = (csv) => csv.split(",").map((r) => r.trim()).filter(Boolean).join("\n");
  const toCsv = (text) => text.split(/[\n,]+/).map((r) => r.trim()).filter(Boolean).join(",");

  let configuredRepos = $derived(toCsv(repos).split(",").filter(Boolean));
  let shortcutDefaults = $derived(desktopShortcutDefaults(desktopPlatform));
  let keybindClash = $derived(shortcutsClash(keybindOpenApp, keybindOpenPalette, shortcutDefaults));

  // single-char keys the PR-detail and inbox handlers already own
  const RESERVED_KEYS = new Set([..."123456789", ..."gGdJKjkxcvremMusqopT", ..."esz", "A", "C", "/"]);
  const isCustom = (a) => a.id.startsWith("custom-");

  let agentKeybindIssues = $derived.by(() => {
    const issues = new Map();
    const bound = new Map();
    for (const a of agents) {
      if (a.trigger !== "keybind") continue;
      const k = a.keybind ?? "";
      if (!k) continue;
      if (RESERVED_KEYS.has(k)) issues.set(a.id, `"${k}" is a built-in app key — pick another`);
      else if (bound.has(k)) issues.set(a.id, `"${k}" is already bound to ${bound.get(k)}`);
      else bound.set(k, a.name || a.id);
    }
    return issues;
  });
  let groupIssues = $derived((grouping.mode === "manual" || grouping.mode === "feature") && grouping.groups.some((group, index) => !group.name.trim() || grouping.groups.some((other, otherIndex) => otherIndex < index && other.name.trim().toLowerCase() === group.name.trim().toLowerCase())));
  let saveBlocked = $derived(keybindClash || agentKeybindIssues.size > 0 || notificationIssues.size > 0 || groupIssues);

  function addAgent() {
    agents = [...agents, { id: `custom-${crypto.randomUUID().slice(0, 8)}`, name: "", enabled: true, trigger: "keybind", keybind: "", model: "opus", prompt_template: "", prompt_default: "", promptText: "" }];
  }

  function removeAgent(id) {
    agents = agents.filter((a) => a.id !== id);
  }

  let agentDefaults = $state([]);

  function resetAgent(agent) {
    const def = agentDefaults.find((d) => d.id === agent.id);
    if (!def) return;
    Object.assign(agent, { name: def.name, trigger: def.trigger, keybind: def.keybind, model: def.model, promptText: agent.prompt_default });
  }

  function apply(s) {
    grouping = normalizePrGrouping(s.pr_grouping);
    repos = toLines(s.repos);
    defaultRepo = s.default_repo;
    pollInterval = s.poll_interval_s;
    replicaSshHost = s.replica_ssh_host;
    perViewWindowSize = s.per_view_window_size;
    perViewWindowPosition = s.per_view_window_position;
    themeName = s.theme;
    fontInterface = s.font_interface;
    fontUi = s.font_ui;
    fontCode = s.font_code;
    fontComments = s.font_comments;
    codeTheme = s.code_theme;
    generalScale = s.general_scale;
    diffScale = s.diff_scale;
    hideSidebar = s.hide_sidebar;
    hideTestsDefault = s.hide_tests_default;
    newestCommentsFirst = s.newest_comments_first;
    pendingReviewsEnabled = s.pending_reviews_enabled === true;
    diffLayout = s.diff_layout;
    forceMergeRepos = s.force_merge_repos.split(",").map((r) => r.trim()).filter(Boolean);
    agents = s.agents.map((a) => ({ ...a, promptText: a.prompt_template || a.prompt_default }));
    agentDefaults = s.agent_defaults;
    agentHarness = s.agent_harness;
    harnessAvailable = s.harness_available;
    desktopPlatform = s.desktop_platform ?? "darwin";
    keybindOpenApp = s.keybind_open_app;
    keybindOpenPalette = s.keybind_open_palette;
    relayUrl = s.relay_url;
    testPathRegex = s.test_path_regex || BUILTIN_TEST_PATH.source;
    health = s.tailscale_serve ? { tailscaleServe: s.tailscale_serve } : null;
    notifications = s.notifications ?? defaultNotificationSettings();
  }

  let relayOrg = $derived(configuredRepos[0]?.split("/")[0] ?? "");

  function relTime(ts) {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    return `${Math.floor(secs / 3600)}h`;
  }

  let relayStatusText = $derived.by(() => {
    if (!relayInfo) return "";
    if (!relayInfo.url) return `Off — PRs refresh by polling every ${pollInterval}s. Enter a relay URL to enable live updates.`;
    if (relayInfo.lastError) return `Can't reach relay (${relayInfo.lastError}) — falling back to polling. Check the URL.`;
    if (relayCoverage?.appExists === false) return "Connected — GitHub App not created yet. One-time setup by an org admin:";
    if (relayInfo.lastEventAt) return `Live — last event ${relTime(relayInfo.lastEventAt)} ago.`;
    return "Live — waiting for the first PR event.";
  });

  function openGithubAppSetup() {
    window.open(`${location.origin}/api/github-app/start?org=${encodeURIComponent(relayOrg)}`, "_blank", "noopener");
  }

  function toggleForceMerge(repo) {
    forceMergeRepos = forceMergeRepos.includes(repo) ? forceMergeRepos.filter((r) => r !== repo) : [...forceMergeRepos, repo];
  }

  let testRegexInvalid = $derived.by(() => {
    if (!testPathRegex.trim()) return false;
    try {
      new RegExp(testPathRegex);
      return false;
    } catch {
      return true;
    }
  });

  async function loadSettings() {
    error = null;
    try {
      const settings = await fetchSettings();
      cacheView("settings", settings);
      apply(settings);
      loaded = true;
    } catch (e) {
      error = String(e);
    }
  }

  const settingsSnapshot = cachedView("settings");
  if (settingsSnapshot) {
    apply(settingsSnapshot);
    loaded = true;
  }

  $effect(() => {
    loadSettings();
    fetchRelayStatus()
      .then((s) => {
        cacheView("relayStatus", s);
        relayInfo = s;
      })
      .catch(() => {});
    fetchRelayCoverage()
      .then((c) => {
        cacheView("relayCoverage", c);
        relayCoverage = c;
      })
      .catch(() => {});
  });

  async function save() {
    if (!loaded || saving || saveBlocked) return;
    saving = true;
    saved = false;
    error = null;
    try {
      const next = await saveSettings({
        pr_grouping: grouping,
        repos: toCsv(repos),
        default_repo: defaultRepo.trim(),
        poll_interval_s: Number(pollInterval),
        replica_ssh_host: replicaSshHost.trim(),
        per_view_window_size: perViewWindowSize,
        per_view_window_position: perViewWindowPosition,
        theme: themeName,
        font_interface: fontInterface,
        font_ui: fontUi,
        font_code: fontCode,
        font_comments: fontComments,
        code_theme: codeTheme,
        general_scale: generalScale,
        diff_scale: diffScale,
        hide_sidebar: hideSidebar,
        hide_tests_default: hideTestsDefault,
        newest_comments_first: newestCommentsFirst,
        pending_reviews_enabled: pendingReviewsEnabled,
        test_path_regex: testPathRegex.trim() === BUILTIN_TEST_PATH.source.trim() ? "" : testPathRegex.trim(),
        diff_layout: diffLayout,
        force_merge_repos: forceMergeRepos.filter((repo) => configuredRepos.includes(repo)).join(","),
        agent_harness: agentHarness,
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          enabled: agent.enabled,
          trigger: agent.trigger,
          keybind: agent.keybind || null,
          model: agent.model,
          prompt_template: agent.promptText.trim() === agent.prompt_default.trim() ? "" : agent.promptText.trim(),
        })),
        keybind_open_app: keybindOpenApp,
        keybind_open_palette: keybindOpenPalette,
        relay_url: relayUrl.trim(),
        notifications: serializeNotificationSettings(notifications),
      });
      cacheView("settings", next);
      apply(next);
      setTheme(themeName);
      setFonts(fontInterface, fontUi, fontCode, fontComments);
      setCodeTheme(codeTheme);
      setScales(generalScale, diffScale);
      setPrefs(next);
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  let lastG = 0;

  $effect(() => {
    function onKey(e) {
      if (activeTab !== "analytics" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        location.hash = "#/";
        return;
      }
      if (isTypingTarget(e.target)) return;
      const page = document.querySelector(".page");
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        scrollPage(page, e.key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g" && !e.shiftKey) {
        const now = Date.now();
        if (now - lastG < 400) {
          scrollEdge(page, "top");
          lastG = 0;
        } else lastG = now;
        return;
      }
      if (e.key === "G") {
        scrollEdge(page, "bottom");
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        scrollStep(page, 1);
        e.preventDefault();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        scrollStep(page, -1);
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="page">
  <div class="settings" class:settings-analytics={activeTab === "analytics"}>
    <header class="head">
      <div class="settings-head-copy">
        <h1 class="head-title">{activeSection?.label ?? "Workspace"}</h1>
      </div>
    </header>

    {#if error}
      <div class="error" role="alert">
        <strong>{loaded ? "Settings could not be saved." : "Settings could not be loaded."}</strong>
        <span>{error}</span>
        {#if loaded}
          <span>Edits kept. Try saving again.</span>
        {:else}
          <button class="btn" type="button" onclick={loadSettings}>Try again</button>
        {/if}
      </div>
    {/if}

    {#if loaded}
      <div class="settings-panel" class:grouping-settings={activeTab === "general" && (grouping.mode === "manual" || grouping.mode === "feature")} id={`settings-panel-${activeTab}`} aria-label={`${activeSection?.label ?? "Workspace"} settings`}>
      <fieldset class="settings-controls" disabled={saving}>
      <legend class="sr-only">{activeSection?.label ?? "Workspace"} settings</legend>
      {#if activeTab === "general"}
        <div class="setup-row">
          <button class="btn setup-again" type="button" onclick={onRunSetup}>Run setup again</button>
        </div>

        <div class="settings-grid">
          {#if privateAccess}
            <div class="field field-wide private-access" class:private-access-live={privateAccess.state === "live"}>
              <span class="label">Private access</span>
              {#if privateAccess.state === "live"}
                <span class="hint">{privateAccess.kind}</span>
                <a class="private-origin mono" href={privateAccess.origin}>{privateAccess.origin}</a>
              {:else}
                <span class="hint invalid-hint">Tailscale could not publish Cockpit: {privateAccess.error}</span>
              {/if}
            </div>
          {/if}

          <label class="field field-wide">
            <span class="label">Repositories</span>
            <span class="hint">One owner/name per line.</span>
            <textarea class="input mono" rows={Math.max(3, repos.split("\n").length)} bind:value={repos} spellcheck="false"></textarea>
          </label>

          <label class="field">
            <span class="label">Default repository</span>
            <span class="hint">For PR numbers without a repository.</span>
            <input class="input mono" bind:value={defaultRepo} placeholder="owner/name" spellcheck="false" autocomplete="off" />
          </label>


          <label class="field field-wide">
            <span class="label">Group review queue by</span>
            <select class="input" bind:value={grouping.mode}>
              <option value="status">Review status (default)</option>
              <option value="manual">Manual groups</option>
              <option value="feature">Feature area</option>
              <option value="type">PR type (feat, fix, etc.)</option>
            </select>
            <span class="hint">Pinned PRs stay at the top.</span>
          </label>
          {#if grouping.mode === "manual" || grouping.mode === "feature"}
            <div class="field field-wide group-editor">
              <span class="label">Groups</span>
              <span class="hint">{grouping.mode === "manual" ? "Select a PR in your queue, then choose its group. Assignments stay on this device. Stacked PRs follow their parent." : "Match titles and scopes like feat(settings). Comma-separated keywords; the first matching group wins. Stacked PRs follow their parent."}</span>
              {#each grouping.groups as group, index (group.id)}
                <div class="group-editor-row">
                  <input class="input" aria-label={`Group ${index + 1} name`} maxlength="80" placeholder="Group name" bind:value={group.name} />
                  {#if grouping.mode === "feature"}<input class="input" aria-label={`Group ${index + 1} keywords`} maxlength="1000" placeholder="Keywords, separated by commas" bind:value={group.keywords} />{/if}
                  <button class="btn" type="button" aria-label={`Remove group ${group.name || index + 1}`} onclick={() => grouping.groups = grouping.groups.filter((item) => item.id !== group.id)}>Remove</button>
                </div>
              {/each}
              {#if groupIssues}<span class="hint invalid-hint">Give each group a unique, nonempty name.</span>{/if}
              <span class="hint">Unmatched PRs appear in {grouping.mode === "manual" ? "Ungrouped" : "Other"}. Removing a group keeps its PRs.</span>
              <button class="btn" type="button" disabled={grouping.groups.length >= 50} onclick={() => grouping.groups = [...grouping.groups, { id: crypto.randomUUID(), name: "", keywords: "" }]}>Add group</button>
            </div>
          {:else if grouping.mode === "type"}
            <span class="hint field-wide">Uses title prefixes such as feat:, fix:, and refactor:. Titles without a recognized prefix appear in Other.</span>
          {/if}

          <label class="check-field settings-option field-wide">
            <input class="check" type="checkbox" bind:checked={pendingReviewsEnabled} />
            <span class="check-text">
              <span class="check-label">Stage comments as pending reviews</span>
            </span>
          </label>
        </div>
        <details class="disclosure">
          <summary>Live updates</summary>
          <div class="settings-grid disclosure-body">
          <label class="field">
            <span class="label">Check GitHub every (seconds)</span>
            <span class="hint">Minimum 60 seconds.</span>
            <input class="input narrow" type="number" min="60" step="10" bind:value={pollInterval} />
          </label>



          <div class="field field-wide">
            <label class="label" for="relay-url">Live update relay</label>
            <span class="hint" id="relay-url-hint">Empty: scheduled checks only.</span>
            <input id="relay-url" aria-describedby="relay-url-hint" class="input mono" bind:value={relayUrl} spellcheck="false" autocomplete="off" />
            {#if relayStatusText}
              <span class="hint relay-status">{relayStatusText}</span>
            {/if}
            {#if relayCoverage?.appExists === false}
              <button class="btn relay-setup" type="button" disabled={!relayOrg} onclick={openGithubAppSetup}>Set up GitHub App…</button>
            {/if}
            {#if relayInfo?.url && relayCoverage}
              <div class="coverage-list">
                {#each configuredRepos as repo}
                  <div class="coverage-row">
                    <span class="coverage-repo">{repo}</span>
                    {#if relayCoverage.repos?.[repo] === true}
                      <span class="coverage-live">live push ✓</span>
                    {:else if relayCoverage.repos?.[repo] === false}
                      <span class="coverage-polling">polling only</span>
                      {#if relayCoverage.appExists}
                        <button class="link-btn" type="button" onclick={() => window.open(relayCoverage.installUrl, "_blank", "noopener")}>Install app</button>
                      {/if}
                    {:else}
                      <span class="coverage-polling">coverage unknown</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
        </details>
        <details class="disclosure">
          <summary>Developer</summary>
          <div class="disclosure-body">
            <UpdateButton manual />
          </div>
        </details>
      {/if}

      {#if activeTab === "appearance"}
        <div class="settings-grid">
          <label class="field">
            <span class="label">Theme</span>
            <select class="input narrow" bind:value={themeName}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>


          <label class="field">
            <span class="label">Code colors</span>
            <select class="input narrow" bind:value={codeTheme}>
              <option value="github">GitHub</option>
              <option value="catppuccin">Catppuccin</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Interface scale (%)</span>
            <input class="input narrow" type="number" min="50" max="200" step="5" bind:value={generalScale} />
          </label>

          <label class="field">
            <span class="label">Diff scale (%)</span>
            <input class="input narrow" type="number" min="50" max="200" step="5" bind:value={diffScale} />
          </label>

        </div>
        <details class="disclosure">
          <summary>Fonts</summary>
          <div class="settings-grid disclosure-body">
          <label class="field">
            <span class="label">Interface font</span>
            <select class="input narrow" bind:value={fontInterface}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Paths &amp; logs font</span>
            <select class="input narrow" bind:value={fontUi}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Code font</span>
            <select class="input narrow" bind:value={fontCode}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Comment font</span>
            <select class="input narrow" bind:value={fontComments}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>
          </div>
        </details>
        <details class="disclosure">
          <summary>Sidebar &amp; window</summary>
          <div class="settings-grid disclosure-body">
          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={hideSidebar} />
            <span class="check-text">
              <span class="check-label">Hide sidebar</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowSize} />
            <span class="check-text">
              <span class="check-label">Remember window size per view</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowPosition} />
            <span class="check-text">
              <span class="check-label">Remember window position per view</span>
            </span>
          </label>
        </div>
        </details>
      {/if}

      {#if activeTab === "keybinds"}
        <div class="settings-grid">
          <label class="field">
            <span class="label">Open PR Cockpit</span>
            <ShortcutInput value={keybindOpenApp} defaultValue={shortcutDefaults.openApp} platform={desktopPlatform} onChange={(a) => (keybindOpenApp = a)} />
          </label>

          <label class="field">
            <span class="label">Open PR search</span>
            <ShortcutInput value={keybindOpenPalette} defaultValue={shortcutDefaults.openPalette} platform={desktopPlatform} onChange={(a) => (keybindOpenPalette = a)} />
            {#if keybindClash}
              <span class="hint invalid-hint">Choose different shortcuts.</span>
            {/if}
          </label>
        </div>
      {/if}

      {#if activeTab === "automerge"}
        <p class="hint">Agents can push changes and merge PRs.</p>
        <label class="field">
          <span class="label">Run agents with</span>
          {#if !harnessAvailable[agentHarness]}
            <span class="hint invalid-hint">Install {agentHarness} on the Cockpit host.</span>
          {/if}
          <select class="input narrow" bind:value={agentHarness}>
            <option value="claude">Claude Code{harnessAvailable.claude ? "" : " (not installed)"}</option>
            <option value="omp">omp{harnessAvailable.omp ? "" : " (not installed)"}</option>
            <option value="codex">Codex{harnessAvailable.codex ? "" : " (not installed)"}</option>
          </select>
        </label>


        {#each agents as agent (agent.id)}
          <div class="agent-card" class:agent-disabled={!agent.enabled}>
            <div class="agent-card-head">
              <label class="agent-toggle">
                <input class="check" type="checkbox" bind:checked={agent.enabled} aria-label={`Enable ${agent.name || "agent"}`} />
                <span>{agent.enabled ? "On" : "Off"}</span>
              </label>
              <div class="agent-identity">
                <input class="input agent-name" bind:value={agent.name} aria-label="Agent name" placeholder="Agent name" spellcheck="false" autocomplete="off" />
                {#if isCustom(agent)}
                  <span class="hint">Pushes fixes; never merges.</span>
                {:else}
                  <span class="hint">{AGENT_META[agent.id]?.description}</span>
                {/if}
              </div>
            </div>

            <div class="agent-trigger">
              <label class="trigger-kind" for={`trigger-${agent.id}`}>Start</label>
              <select id={`trigger-${agent.id}`} class="input narrow" bind:value={agent.trigger}>
                <option value="keybind">Keyboard shortcut</option>
                <option value="activity">Automatically</option>
              </select>
              {#if agent.trigger === "keybind"}
                <input class="input mono keybind-input" maxlength="1" bind:value={agent.keybind} aria-label={`Shortcut for ${agent.name || "agent"}`} aria-invalid={agentKeybindIssues.has(agent.id)} spellcheck="false" autocomplete="off" />
              {/if}
              <label class="trigger-kind" for={`model-${agent.id}`}>{agentHarness === "codex" ? "Effort" : "Model"}</label>
              <select id={`model-${agent.id}`} class="input narrow" bind:value={agent.model}>
                <option value="opus">{agentHarness === "codex" ? "high" : "opus"}</option>
                <option value="sonnet">{agentHarness === "codex" ? "medium" : "sonnet"}</option>
              </select>
              {#if agent.trigger === "activity"}
                <span class="hint trigger-hint">On new commits to your PRs.</span>
              {/if}
            </div>
            {#if agentKeybindIssues.has(agent.id)}
              <span class="hint invalid-hint keybind-issue" role="alert">{agentKeybindIssues.get(agent.id)}</span>
            {/if}

            <details class="disclosure agent-disclosure">
              <summary>Instructions</summary>
              <div class="disclosure-body">
            <label class="field agent-prompt">
              <span class="label">Prompt</span>
              <span class="hint">Variables: <code>{"{{PR_NUMBER}}, {{BASE_REF}}, {{STATUS_FILE}}"}</code></span>
              <textarea class="input mono" rows={isCustom(agent) ? 6 : 10} bind:value={agent.promptText} disabled={!agent.enabled} spellcheck="false"></textarea>
              {#if agent.prompt_default && agent.promptText.trim() !== agent.prompt_default.trim()}
                <button class="reset-link" type="button" onclick={() => (agent.promptText = agent.prompt_default)}>Reset prompt to default</button>
              {/if}
            </label>

            {#if isCustom(agent)}
              <button class="reset-link remove-agent" type="button" onclick={() => removeAgent(agent.id)}>Remove agent</button>
            {:else}
              <button class="reset-link remove-agent" type="button" onclick={() => resetAgent(agent)}>Reset agent to defaults</button>
            {/if}
              </div>
            </details>
          </div>
        {/each}

        <button class="btn" type="button" onclick={addAgent}>Add custom agent</button>
        <details class="disclosure merge-disclosure">
          <summary>Bypass required approval</summary>
          <div class="disclosure-body">
        <div class="field">
          <span class="hint">Failing checks, conflicts and open threads still block merging.</span>
          {#if configuredRepos.length}
            <div class="repo-toggles">
              {#each configuredRepos as repo}
                <label class="check-field">
                  <input class="check" type="checkbox" checked={forceMergeRepos.includes(repo)} onchange={() => toggleForceMerge(repo)} />
                  <span class="check-label mono">{repo}</span>
                </label>
              {/each}
            </div>
          {:else}
            <span class="hint">Add repositories in <a href={settingsSectionHref("general")}>Workspace</a>.</span>
          {/if}
        </div>
          </div>
        </details>
      {/if}

      {#if activeTab === "tests"}
        <label class="field">
          <span class="label">Diff layout</span>
          <select class="input narrow" bind:value={diffLayout}>
            <option value="split">Side by side</option>
            <option value="unified">Unified</option>
          </select>
        </label>


        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={hideTestsDefault} />
          <span class="check-text">
            <span class="check-label">Hide test files by default</span>
          </span>
        </label>

        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={newestCommentsFirst} />
          <span class="check-text">
            <span class="check-label">Show newest comments first</span>
          </span>
        </label>
        <details class="disclosure">
          <summary>Test file detection</summary>
          <div class="disclosure-body">
        <label class="field">
          <span class="label">Test path regex</span>
          <span class="hint" id="test-pattern-hint">Empty: built-in pattern.</span>
          <input
            class="input mono"
            class:invalid={testRegexInvalid}
            aria-invalid={testRegexInvalid}
            aria-describedby={testRegexInvalid ? "test-pattern-hint test-pattern-error" : "test-pattern-hint"}
            bind:value={testPathRegex}
            spellcheck="false"
            autocomplete="off"
          />
          {#if testRegexInvalid}
            <span id="test-pattern-error" class="hint invalid-hint" role="alert">Invalid regex. Using built-in pattern.</span>
          {/if}
        </label>
          </div>
        </details>
      {/if}

      {#if activeTab === "advanced"}
        <label class="field">
          <span class="label">Use another Cockpit over SSH</span>
          <span class="hint">Empty: local connection.</span>
          <input class="input mono" bind:value={replicaSshHost} placeholder="user@host" spellcheck="false" autocomplete="off" />
        </label>
      {/if}

      {#if activeTab === "notifications"}
        <SettingsNotifications bind:settings={notifications} issues={notificationIssues} />
      {/if}

      {#if activeTab === "analytics"}
        <SettingsAnalytics repos={configuredRepos} />
      {/if}
      </fieldset>

      {#if activeTab !== "analytics"}
      <div class="actions" aria-busy={saving}>
        <div class="save-copy" aria-live="polite">
          {#if keybindClash}
            <span class="invalid-hint">Fix conflicts in <a href={settingsSectionHref("keybinds")}>Keyboard shortcuts</a>.</span>
          {:else if agentKeybindIssues.size}
            <span class="invalid-hint">Fix shortcuts in <a href={settingsSectionHref("automerge")}>Agents &amp; merging</a>.</span>
          {:else if notificationIssues.size}
            <span class="invalid-hint">Fix rules in <a href={settingsSectionHref("notifications")}>Notifications</a>.</span>
          {:else if error}
            <span class="invalid-hint">Could not save: {error}</span>
          {:else if saved}
            <span class="saved">Changes saved.</span>
          {/if}
        </div>
        <button class="btn" type="button" disabled={saving || saveBlocked} onclick={save}>
          {saving ? "Saving…" : "Save changes"}
          {#if !saving && !saveBlocked}<Kbd keys={["cmd", "s"]} />{/if}
        </button>
      </div>
      {/if}
      </div>
    {:else if !error}
      <p class="hint" role="status">Loading your settings…</p>
    {/if}
  </div>
</div>

{#if activeTab !== "analytics"}
  <KeyBar keys={[{ key: "⌘s", label: "save" }, { key: "esc", label: "back" }]} />
{/if}

<style>
  .group-editor-row { display: flex; gap: 8px; align-items: center; margin-block: 8px; }
  .group-editor-row .input { min-width: 0; flex: 1; }
  .group-editor > .btn { align-self: flex-start; }
  @media (max-width: 700px) { .group-editor-row { flex-wrap: wrap; } .group-editor-row .input { flex-basis: 100%; } }
  .page {
    --settings-page-inset: 18px;
    height: 100%;
    overflow-y: auto;
    scroll-padding-block: 90px 100px;
    padding: var(--settings-page-inset) 32px 96px;
  }
  .settings {
    width: 100%;
    max-width: 880px;
    margin-inline: auto;
  }
  .settings-analytics { max-width: var(--app-content-max-width, 1320px); }
  .head {
    position: sticky;
    top: calc(-1 * var(--settings-page-inset));
    z-index: 4;
    padding: var(--settings-page-inset) 0 14px;
    margin: calc(-1 * var(--settings-page-inset)) 0 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .settings-head-copy { display: flex; flex-direction: column; }
  .head-title {
    margin: 0;
    font-family: var(--sans);
    font-size: 24px;
    font-weight: 500;
    line-height: 30px;
    letter-spacing: -0.025em;
    color: var(--text);
  }
  .settings-panel, .settings-controls { min-width: 0; }
  .settings-controls { margin: 0; padding: 0; border: 0; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .setup-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 32px; align-items: start; }
  .field-wide { grid-column: 1 / -1; }
  .field, .settings-option {
    display: block;
    min-width: 0;
    margin: 0;
    padding: 18px 0;
    border-top: 1px solid var(--border-soft);
  }
  .label { display: block; margin-bottom: 2px; color: var(--text); font-size: 14px; font-weight: 500; line-height: 20px; }
  .hint { display: block; margin-bottom: 10px; font-family: var(--sans); font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .input {
    width: 100%;
    max-width: 100%;
    min-height: 36px;
    box-sizing: border-box;
    padding: 8px 11px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 20px;
    resize: vertical;
  }
  .input.mono { font-family: var(--mono); font-size: 12px; font-weight: 400; }
  .input.narrow { width: 200px; }
  .input:focus { outline: 2px solid var(--link); outline-offset: 2px; }
  .input:disabled { opacity: 0.6; cursor: default; }
  .input.invalid { border-color: var(--fail); }
  .invalid-hint { color: var(--fail); }
  .check-field { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .check-label { display: block; color: var(--text); font-size: 14px; line-height: 21px; }
  .check-text { min-width: 0; }
  .check {
    appearance: none;
    position: relative;
    width: 36px;
    height: 21px;
    margin: 0;
    flex: none;
    border: 0;
    border-radius: 999px;
    background: var(--switch-unchecked);
    cursor: pointer;
  }
  .check::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--switch-thumb);
    box-shadow: var(--shadow-control-hairline);
  }
  .check:checked { background: var(--link); }
  .check:checked::after { transform: translateX(15px); }
  .check:disabled { opacity: 0.6; cursor: default; }
  .check:focus-visible, summary:focus-visible, .btn:focus-visible, .reset-link:focus-visible, .link-btn:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
  }
  .disclosure { border-top: 1px solid var(--border-soft); margin-top: 12px; }
  summary { padding: 18px 0; color: var(--text); font-size: 14px; font-weight: 500; cursor: pointer; }
  .disclosure-body { padding-bottom: 12px; }
  .disclosure-body > .field:first-child { border-top: 0; padding-top: 0; }
  .merge-disclosure { margin-top: 24px; border-top-color: var(--fail); }
  .merge-disclosure > summary { color: var(--fail); }
  .agent-card { border-top: 1px solid var(--border-soft); padding: 20px 0; }
  .agent-card-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; margin-bottom: 16px; }
  .agent-toggle { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; font-size: 12px; color: var(--text-dim); }
  .agent-toggle span { min-width: 20px; }
  .agent-identity { min-width: 0; }
  .agent-name { width: 300px; margin-bottom: 6px; }
  .agent-identity .hint:last-child { margin-bottom: 0; }
  .agent-trigger { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 12px; }
  .trigger-kind { color: var(--text-dim); font-size: 12px; }
  .agent-trigger .input.narrow { width: 180px; }
  .agent-trigger .keybind-input { width: 44px; text-align: center; }
  .trigger-hint { flex: 1 1 100%; margin-bottom: 0; }
  .keybind-issue { margin-bottom: 12px; }
  .agent-disclosure { margin-top: 0; }
  .agent-disclosure summary { padding-block: 12px; }
  .agent-prompt { margin-bottom: 12px; }
  .reset-link, .link-btn { padding: 0; background: none; border: 0; color: var(--link); font-size: 12px; line-height: 1.5; cursor: pointer; }
  .reset-link { display: block; margin-top: 8px; }
  .reset-link:hover, .link-btn:hover { text-decoration: underline; }
  .remove-agent { margin-bottom: 12px; }
  .repo-toggles { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .repo-toggles .check-label { overflow-wrap: anywhere; }
  .private-access { padding-inline: 14px; background: var(--surface); border-radius: var(--radius-md); }
  .private-access-live { box-shadow: inset 3px 0 0 var(--ready); }
  .private-origin { display: block; overflow-wrap: anywhere; color: var(--link); font-size: 12px; }
  .relay-status { margin-top: 6px; }
  .relay-setup { margin: 4px 0 8px; }
  .coverage-list { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
  .coverage-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12px; }
  .coverage-repo { overflow-wrap: anywhere; color: var(--text-dim); }
  .coverage-live { color: var(--ready); }
  .coverage-polling { color: var(--text-dim); }
  .actions {
    position: sticky;
    bottom: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 24px;
    padding: 16px 0;
    border-top: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .grouping-settings .actions { position: static; }
  .save-copy { flex: 1 1 260px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .saved { color: var(--ready); }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 36px;
    padding: 8px 14px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .btn:disabled { background: var(--disabled-bg); box-shadow: none; color: var(--disabled-fg); cursor: default; }
  .actions .btn { background: var(--link); box-shadow: var(--shadow-control-filled); color: var(--on-brand); }
  .actions .btn:disabled { background: var(--brand-disabled); color: var(--on-brand); box-shadow: none; }
  .error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-bottom: 22px; padding: 14px; border: 1px solid var(--fail); border-radius: var(--radius-md); background: var(--fail-bg); color: var(--fail); font-size: 13px; overflow-wrap: anywhere; }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) { background: var(--surface-hover); }
    .actions .btn:hover:not(:disabled) { background: var(--brand-hover); }
    .check:hover:not(:disabled) { background: var(--switch-unchecked-hover); }
    .check:checked:hover:not(:disabled) { background: var(--brand-hover); }
    summary:hover { color: var(--link); }
  }
  @media (max-width: 760px) {
    .page { --settings-page-inset: 14px; padding: var(--settings-page-inset) 16px 84px; }
    .settings-grid { grid-template-columns: 1fr; }
    .field-wide { grid-column: auto; }
    .agent-card-head { grid-template-columns: 1fr; gap: 8px; }
  }
</style>
