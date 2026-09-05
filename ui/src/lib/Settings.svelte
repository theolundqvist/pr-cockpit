<script>
  import { fetchRelayCoverage, fetchRelayStatus, fetchSettings, saveSettings } from "./api.js";
  import { setCodeTheme, setFonts, setScales, setTheme } from "./theme.svelte.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { BUILTIN_TEST_PATH } from "./testPath.js";
  import { isTypingTarget } from "./dom.js";
  import { scrollStep, scrollPage, scrollEdge } from "./scroll.js";
  import KeyBar from "./KeyBar.svelte";
  import ShortcutInput from "./ShortcutInput.svelte";
  import Kbd from "./Kbd.svelte";
  import SettingsAnalytics from "./SettingsAnalytics.svelte";
  import { SETTINGS_SECTION_KEY, SETTINGS_SECTIONS, normalizeSettingsSection, settingsSectionHref } from "./settingsSections.js";
  import { desktopShortcutDefaults, shortcutsClash } from "./shortcutPlatform.js";
  import { tailscaleAccess } from "./tailscaleAccess.js";
  let { onRunSetup, section = "general" } = $props();


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
  let relayInfo = $state(null);
  let relayCoverage = $state(null);
  let health = $state(null);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state(null);

  let activeTab = $derived(normalizeSettingsSection(section));
  let activeSection = $derived(SETTINGS_SECTIONS.find((item) => item.id === activeTab));
  let privateAccess = $derived(tailscaleAccess(health));

  $effect(() => localStorage.setItem(SETTINGS_SECTION_KEY, activeTab));

  // UI copy for the built-in agents, keyed by agent id; definitions (enabled, trigger, keybind, prompt) come from the server
  const AGENT_META = {
    fixer: {
      description: "Fixes conflicts, failing checks and bot review threads on an armed PR, then merges it using the base branch’s required method.",
      offHint: "Turning this off prevents new runs. A running fixer finishes its current pass, then exits. Re-arm the PR after re-enabling.",
      promptHint: "Placeholders such as {{PR_NUMBER}} are filled in for each run.",
    },
    autofix: {
      description: "Fixes conflicts, failing checks and review threads, but never merges. You decide when to merge.",
      offHint: "Turning this off prevents new runs. A running auto-fix finishes its current pass, then exits. Re-arm the PR after re-enabling.",
      promptHint: "Placeholders such as {{PR_NUMBER}} are filled in for each run.",
    },
    rescorer: {
      description: "Re-scores Greptile’s review after new commits land on your own PRs. It never posts a comment.",
      offHint: "Turning this off prevents new re-scores.",
      promptHint: "Customize the review persona here. Findings, the diff and the required score format are added automatically; {{REPO}} and {{NUMBER}} are filled in for each run.",
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
      apply(await fetchSettings());
      loaded = true;
    } catch (e) {
      error = String(e);
    }
  }

  $effect(() => {
    loadSettings();
    fetchRelayStatus()
      .then((s) => (relayInfo = s))
      .catch(() => {});
    fetchRelayCoverage()
      .then((c) => (relayCoverage = c))
      .catch(() => {});
  });

  async function save() {
    if (!loaded || saving || keybindClash || agentKeybindIssues.size) return;
    saving = true;
    saved = false;
    error = null;
    try {
      const next = await saveSettings({
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
      });
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
        <span class="ui-eyebrow">Settings</span>
        <h1 class="head-title">{activeSection?.label ?? "Workspace"}</h1>
      </div>
    </header>

    {#if error}
      <div class="error" role="alert">
        <strong>{loaded ? "Settings could not be saved." : "Settings could not be loaded."}</strong>
        <span>{error}</span>
        {#if loaded}
          <span>Your edits are still here. Check the error, then try Save changes again.</span>
        {:else}
          <button class="btn" type="button" onclick={loadSettings}>Try again</button>
        {/if}
      </div>
    {/if}

    {#if loaded}
      <div class="settings-panel" id={`settings-panel-${activeTab}`} aria-label={`${activeSection?.label ?? "Workspace"} settings`}>
      <fieldset class="settings-controls" disabled={saving}>
      <legend class="sr-only">{activeSection?.label ?? "Workspace"} settings</legend>
      {#if activeTab === "general"}
        <div class="settings-intro">
          <p>Choose the repositories you want in your review queue.</p>
        </div>
        <div class="setup-row">
          <span class="hint">Need to reconnect GitHub or revisit your repository selection? Save any edits here first.</span>
          <button class="btn setup-again" type="button" onclick={onRunSetup}>Run setup again</button>
        </div>

        <div class="settings-grid">
          {#if privateAccess}
            <div class="field field-wide private-access" class:private-access-live={privateAccess.state === "live"}>
              <span class="label">Private access</span>
              {#if privateAccess.state === "live"}
                <span class="hint">Live through {privateAccess.kind}. The local server remains private on loopback.</span>
                <a class="private-origin mono" href={privateAccess.origin}>{privateAccess.origin}</a>
              {:else}
                <span class="hint invalid-hint">Tailscale could not publish Cockpit: {privateAccess.error}</span>
              {/if}
            </div>
          {/if}

          <label class="field field-wide">
            <span class="label">Repositories</span>
            <span class="hint">PRs involving you in these repositories. Enter one owner/name per line.</span>
            <textarea class="input mono" rows={Math.max(3, repos.split("\n").length)} bind:value={repos} spellcheck="false"></textarea>
          </label>

          <label class="field">
            <span class="label">Default repository</span>
            <span class="hint">Where to look when you open a PR by number alone, such as #42.</span>
            <input class="input mono" bind:value={defaultRepo} placeholder="owner/name" spellcheck="false" autocomplete="off" />
          </label>

        </div>
        <details class="disclosure">
          <summary>Update frequency &amp; live updates<span class="summary-hint">How this workspace stays up to date</span></summary>
          <div class="settings-grid disclosure-body">
          <label class="field">
            <span class="label">Check GitHub every (seconds)</span>
            <span class="hint">180 is recommended. A shorter interval uses more GitHub quota; the minimum is 60 seconds.</span>
            <input class="input narrow" type="number" min="60" step="10" bind:value={pollInterval} />
          </label>



          <div class="field field-wide">
            <label class="label" for="relay-url">Live update relay</label>
            <span class="hint" id="relay-url-hint">Receive GitHub events between scheduled checks. Leave empty to use scheduled checks only.</span>
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
                      <span class="coverage-polling">coverage unknown — relay didn't answer</span>
                    {/if}
                  </div>
                {/each}
                {#if relayCoverage.appExists && relayCoverage.repos && configuredRepos.some((r) => relayCoverage.repos[r] === false)}
                  <span class="hint">Org admins install; members can request it from an admin via the same page</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
        </details>
      {/if}

      {#if activeTab === "appearance"}
        <div class="settings-intro">
          <p>Make the cockpit comfortable to read. Changes apply only when you save.</p>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span class="label">Theme</span>
            <span class="hint">System follows your device’s light or dark appearance.</span>
            <select class="input narrow" bind:value={themeName}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>


          <label class="field">
            <span class="label">Code colors</span>
            <span class="hint">Catppuccin adds richer TypeScript colors and keeps embedded SQL highlighting</span>
            <select class="input narrow" bind:value={codeTheme}>
              <option value="github">GitHub</option>
              <option value="catppuccin">Catppuccin</option>
            </select>
          </label>

          <label class="field">
            <span class="label">General scale (%)</span>
            <span class="hint">Scales everything except diff text</span>
            <input class="input narrow" type="number" min="50" max="200" step="5" bind:value={generalScale} />
          </label>

          <label class="field">
            <span class="label">Diff scale (%)</span>
            <span class="hint">Scales diff text and line numbers independently</span>
            <input class="input narrow" type="number" min="50" max="200" step="5" bind:value={diffScale} />
          </label>

        </div>
        <details class="disclosure">
          <summary>Fonts<span class="summary-hint">Choose fonts separately for the interface, code and comments</span></summary>
          <div class="settings-grid disclosure-body">
          <label class="field">
            <span class="label">Interface font</span>
            <span class="hint">Titles, labels, buttons and list chrome</span>
            <select class="input narrow" bind:value={fontInterface}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Technical UI font</span>
            <span class="hint">Branches, paths, commit IDs and logs</span>
            <select class="input narrow" bind:value={fontUi}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Code font</span>
            <span class="hint">Diff lines and code blocks</span>
            <select class="input narrow" bind:value={fontCode}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label">Comment font</span>
            <span class="hint">Pull request descriptions, comments and reviews</span>
            <select class="input narrow" bind:value={fontComments}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>
          </div>
        </details>
        <details class="disclosure">
          <summary>Sidebar &amp; desktop window<span class="summary-hint">Visibility, remembered size and position</span></summary>
          <div class="settings-grid disclosure-body">
          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={hideSidebar} />
            <span class="check-text">
              <span class="check-label">Hide sidebar</span>
              <span class="hint">Hides the main app rail — Settings keeps its own section navigation</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowSize} />
            <span class="check-text">
              <span class="check-label">Remember window size per view</span>
              <span class="hint">Restores the size you last used for the list and PR views</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowPosition} />
            <span class="check-text">
              <span class="check-label">Remember window position per view</span>
              <span class="hint">Restores the screen position you last used for the list and PR views</span>
            </span>
          </label>
        </div>
        </details>
      {/if}

      {#if activeTab === "keybinds"}
        <div class="settings-intro">
          <p>Open the desktop app or jump straight to PR search, even while another app has focus.</p>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span class="label">Open PR Cockpit</span>
            <span class="hint">Show the main window from anywhere on your desktop.</span>
            <ShortcutInput value={keybindOpenApp} defaultValue={shortcutDefaults.openApp} platform={desktopPlatform} onChange={(a) => (keybindOpenApp = a)} />
          </label>

          <label class="field">
            <span class="label">Open PR search</span>
            <span class="hint">Show the standalone search palette without opening the main window.</span>
            <ShortcutInput value={keybindOpenPalette} defaultValue={shortcutDefaults.openPalette} platform={desktopPlatform} onChange={(a) => (keybindOpenPalette = a)} />
            {#if keybindClash}
              <span class="hint invalid-hint">Same combo bound twice — pick different shortcuts</span>
            {/if}
          </label>
        </div>
      {/if}

      {#if activeTab === "automerge"}
        <div class="settings-intro">
          <p>Agents can change PR branches. Review each agent’s behavior and trigger before enabling it. Some agents can also merge.</p>
        </div>
        <label class="field">
          <span class="label">Run agents with</span>
          <span class="hint">
            The coding tool used by every agent. It must be installed on the machine running Cockpit.
            {#if !harnessAvailable[agentHarness]}
              — <strong>{agentHarness} is not installed</strong>, agents will fail to start
            {/if}
          </span>
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
                  <span class="hint">Supervised run on a PR — pushes fixes to the PR branch, never merges</span>
                {:else}
                  <span class="hint">{AGENT_META[agent.id]?.description}</span>
                  <span class="hint">{AGENT_META[agent.id]?.offHint}</span>
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
              <span class="hint trigger-hint">{agent.trigger === "keybind" ? "Press its key on a PR or inbox selection" : "Runs automatically when new commits land on your own PRs"}</span>
            </div>
            {#if agentKeybindIssues.has(agent.id)}
              <span class="hint invalid-hint keybind-issue" role="alert">{agentKeybindIssues.get(agent.id)}</span>
            {/if}

            <details class="disclosure agent-disclosure">
              <summary>Instructions &amp; reset<span class="summary-hint">Customize what this agent does</span></summary>
              <div class="disclosure-body">
            <label class="field agent-prompt">
              <span class="label">Prompt</span>
              <span class="hint">{isCustom(agent) ? "The agent's instruction — {{PR_NUMBER}}, {{BASE_REF}} and {{STATUS_FILE}} are filled in per run" : AGENT_META[agent.id]?.promptHint}</span>
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
          <summary>Allow merging without required approval<span class="summary-hint">{forceMergeRepos.filter((repo) => configuredRepos.includes(repo)).length} repositories selected · bypasses an approval requirement</span></summary>
          <div class="disclosure-body">
        <div class="field">
          <span class="label">Repositories allowed to bypass approval</span>
          <span class="hint">On selected repositories, force-merge may bypass required approval. Failing checks, conflicts and open review threads still block it. Leave repositories unselected to keep the approval requirement.</span>
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
            <span class="hint">Add repositories in <a href={settingsSectionHref("general")}>Workspace</a> before changing merge permissions.</span>
          {/if}
        </div>
          </div>
        </details>
      {/if}

      {#if activeTab === "tests"}
        <div class="settings-intro">
          <p>Set how PR changes and conversations open. You can still change the view while reviewing.</p>
        </div>
        <label class="field">
          <span class="label">Diff layout</span>
          <span class="hint">Applies to pull request changes and file history</span>
          <select class="input narrow" bind:value={diffLayout}>
            <option value="split">Side by side</option>
            <option value="unified">Unified</option>
          </select>
        </label>


        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={hideTestsDefault} />
          <span class="check-text">
            <span class="check-label">Hide test files by default</span>
            <span class="hint">Collapses test files when a PR opens — the per-PR toggle still flips them</span>
          </span>
        </label>

        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={newestCommentsFirst} />
          <span class="check-text">
            <span class="check-label">Show newest comments first</span>
            <span class="hint">Keeps the PR description at the top, then shows the composer and newest comments first</span>
          </span>
        </label>
        <details class="disclosure">
          <summary>Which files count as tests?<span class="summary-hint">Customize test-file detection with a regular expression</span></summary>
          <div class="disclosure-body">
        <label class="field">
          <span class="label">Test path pattern</span>
          <span class="hint" id="test-pattern-hint">Files with a matching path count as tests. Leave empty to use the built-in pattern.</span>
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
            <span id="test-pattern-error" class="hint invalid-hint" role="alert">This is not a valid regular expression. Correct it or clear the field to use the built-in pattern; invalid patterns use the built-in pattern.</span>
          {/if}
        </label>
          </div>
        </details>
      {/if}

      {#if activeTab === "advanced"}
        <div class="settings-intro">
          <p>Advanced connection settings. Leave this empty unless another machine already runs the Cockpit you want to use.</p>
        </div>
        <label class="field">
          <span class="label">Use another Cockpit over SSH</span>
          <span class="hint">Enter its SSH host to use that machine’s PR data instead of fetching GitHub independently. The other Cockpit must remain reachable. Leave empty to use this machine’s own connection.</span>
          <input class="input mono" bind:value={replicaSshHost} placeholder="user@host" spellcheck="false" autocomplete="off" />
        </label>
      {/if}

      {#if activeTab === "analytics"}
        <SettingsAnalytics repos={configuredRepos} />
      {/if}
      </fieldset>

      {#if activeTab !== "analytics"}
      <div class="actions" aria-busy={saving}>
        <div class="save-copy" aria-live="polite">
          {#if keybindClash}
            <span class="invalid-hint">Choose different shortcuts in <a href={settingsSectionHref("keybinds")}>Keyboard shortcuts</a> before saving.</span>
          {:else if agentKeybindIssues.size}
            <span class="invalid-hint">Resolve shortcut conflicts in <a href={settingsSectionHref("automerge")}>Agents &amp; merging</a> before saving.</span>
          {:else if error}
            <span class="invalid-hint">Could not save: {error}. Your edits are kept. Resolve the error and try again.</span>
          {:else if saved}
            <span class="saved">Changes saved.</span>
          {:else}
            <span class="hint">Save applies your changes across Settings.</span>
          {/if}
        </div>
        <button class="btn" type="button" disabled={saving || keybindClash || agentKeybindIssues.size > 0} onclick={save}>
          {saving ? "Saving…" : "Save changes"}
          {#if !saving && !keybindClash && agentKeybindIssues.size === 0}<Kbd keys={["cmd", "s"]} />{/if}
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
  .settings-head-copy .ui-eyebrow { font-size: 12px; }
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
  .settings-intro { max-width: 640px; margin-bottom: 18px; }
  .settings-intro p { margin: 0; color: var(--text-dim); font-size: 14px; line-height: 1.5; }
  .setup-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .setup-row .hint { flex: 1 1 280px; margin: 0; }
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
  .hint, .summary-hint { display: block; margin-bottom: 10px; font-family: var(--sans); font-size: 12px; line-height: 1.5; color: var(--text-dim); }
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
  .check-field .hint { margin: 3px 0 0; }
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
  .summary-hint { margin: 4px 0 0 18px; font-weight: 400; }
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
  .save-copy { flex: 1 1 260px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .save-copy .hint { margin: 0; }
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
