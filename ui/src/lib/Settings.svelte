<script>
  import { fetchGithubUsage, fetchRelayCoverage, fetchRelayStatus, fetchSettings, saveSettings } from "./api.js";
  import { setCodeTheme, setFonts, setScales, setTheme } from "./theme.svelte.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { BUILTIN_TEST_PATH } from "./testPath.js";
  import { isTypingTarget } from "./dom.js";
  import { scrollStep, scrollPage, scrollEdge } from "./scroll.js";
  import KeyBar from "./KeyBar.svelte";
  import ShortcutInput from "./ShortcutInput.svelte";
  import Kbd from "./Kbd.svelte";
  import { SETTINGS_SECTION_KEY, SETTINGS_SECTIONS, normalizeSettingsSection } from "./settingsSections.js";
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
  let harnessAvailable = $state({ claude: true, omp: true });
  let agents = $state([]);
  let keybindOpenApp = $state("");
  let keybindOpenPalette = $state("");
  let relayUrl = $state("");
  let replicaSshHost = $state("");
  let relayInfo = $state(null);
  let relayCoverage = $state(null);
  let githubUsage = $state(null);
  let githubUsageError = $state(false);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state(null);

  let activeTab = $derived(normalizeSettingsSection(section));
  let activeSection = $derived(SETTINGS_SECTIONS.find((item) => item.id === activeTab));

  $effect(() => localStorage.setItem(SETTINGS_SECTION_KEY, activeTab));

  // UI copy for the built-in agents, keyed by agent id; definitions (enabled, trigger, keybind, prompt) come from the server
  const AGENT_META = {
    fixer: {
      description: "gets an armed PR fully green — conflicts, failing checks, bot threads — then merges it with the base branch's required method",
      offHint: "off = no new arms; a running fixer finishes its current pass then exits — re-arm after re-enabling",
      promptHint: "placeholders like {{PR_NUMBER}} are filled in per run",
    },
    autofix: {
      description: "gets a PR green — conflicts, checks, review threads — but never merges; a human merges",
      offHint: "off = no new arms; a running auto-fix finishes its current pass then exits — re-arm after re-enabling",
      promptHint: "placeholders like {{PR_NUMBER}} are filled in per run",
    },
    rescorer: {
      description: "re-scores Greptile's review after new commits land on your own PRs — never posts a comment",
      offHint: "off = no new re-scores",
      promptHint: "persona only — the findings, diff and JSON score contract are appended server-side ({{REPO}} and {{NUMBER}} filled per run)",
    },
  };

  const toLines = (csv) => csv.split(",").map((r) => r.trim()).filter(Boolean).join("\n");
  const toCsv = (text) => text.split(/[\n,]+/).map((r) => r.trim()).filter(Boolean).join(",");

  let configuredRepos = $derived(toCsv(repos).split(",").filter(Boolean));
  let keybindClash = $derived(!!keybindOpenApp && keybindOpenApp === keybindOpenPalette);

  // single-char keys the PR-detail and inbox handlers already own
  const RESERVED_KEYS = new Set([..."123456789", ..."gGdJKjkxcvremMusqopT", ..."ez", "A", "C", "/"]);
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
    keybindOpenApp = s.keybind_open_app;
    keybindOpenPalette = s.keybind_open_palette;
    relayUrl = s.relay_url;
    testPathRegex = s.test_path_regex || BUILTIN_TEST_PATH.source;
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

  const usageNumber = new Intl.NumberFormat();
  function usagePercent(value, total) {
    return total > 0 ? Math.min(100, (value / total) * 100) : 0;
  }

  function resetTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

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

  $effect(() => {
    fetchSettings()
      .then((s) => {
        apply(s);
        loaded = true;
      })
      .catch((e) => (error = String(e)));
    fetchRelayStatus()
      .then((s) => (relayInfo = s))
      .catch(() => {});
    fetchRelayCoverage()
      .then((c) => (relayCoverage = c))
      .catch(() => {});
    fetchGithubUsage()
      .then((next) => (githubUsage = next))
      .catch(() => (githubUsageError = true));
  });

  async function save() {
    if (keybindClash || agentKeybindIssues.size) return;
    saving = true;
    saved = false;
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
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
  <div class="settings">
    <header class="head">
      <div class="settings-head-copy">
        <span class="ui-eyebrow">Control center</span>
        <span class="head-title">Settings</span>
      </div>
    </header>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    {#if loaded}
      <div class="settings-panel" id={`settings-panel-${activeTab}`} aria-label={`${activeSection?.label ?? "General"} settings`}>
      {#if activeTab === "general"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Workspace</span>
          <p>Configure the repositories and update behavior that shape your review queue.</p>
        </div>
        <button class="btn setup-again" type="button" onclick={onRunSetup}>Run setup again</button>

        <div class="settings-grid">
          <label class="field field-wide">
            <span class="label">Repositories</span>
            <span class="hint">One owner/name per line — watched for PRs involving you</span>
            <textarea class="input mono" rows={Math.max(3, repos.split("\n").length)} bind:value={repos} spellcheck="false"></textarea>
          </label>

          <label class="field">
            <span class="label">Default repository</span>
            <span class="hint">Used to resolve bare-number PR jumps</span>
            <input class="input mono" bind:value={defaultRepo} placeholder="owner/name" spellcheck="false" autocomplete="off" />
          </label>

          <label class="field">
            <span class="label">Poll interval</span>
            <span class="hint">Seconds — minimum 60 (GitHub quota), 180 recommended</span>
            <input class="input narrow" type="number" min="60" step="10" bind:value={pollInterval} />
          </label>


          <section class="field field-wide usage-card" aria-label="GitHub GraphQL usage">
            <div class="usage-head">
              <div>
                <span class="label">GitHub GraphQL usage</span>
                <span class="hint">Current hourly GitHub window on {githubUsage?.usage?.machine ?? "this machine"}</span>
              </div>
              {#if githubUsage?.quota}
                <strong class="usage-total">{usagePercent(githubUsage.quota.used, githubUsage.quota.limit).toFixed(1)}%</strong>
              {/if}
            </div>
            {#if githubUsage?.quota && githubUsage?.usage}
              <div
                class="quota-track"
                role="meter"
                aria-label="GitHub GraphQL quota consumed"
                aria-valuemin="0"
                aria-valuemax={githubUsage.quota.limit}
                aria-valuenow={githubUsage.quota.used}
              >
                <span style={`width: ${usagePercent(githubUsage.quota.used, githubUsage.quota.limit)}%`}></span>
              </div>
              <div class="usage-stats">
                <div>
                  <strong>{usageNumber.format(githubUsage.quota.used)}</strong>
                  <span>of {usageNumber.format(githubUsage.quota.limit)} points consumed</span>
                </div>
                <div>
                  <strong>{usageNumber.format(githubUsage.usage.localPoints)}</strong>
                  <span>points from this cockpit · {usageNumber.format(githubUsage.usage.localRequests)} calls</span>
                </div>
                <div>
                  <strong>{githubUsage.usage.otherPoints === null ? "—" : usageNumber.format(githubUsage.usage.otherPoints)}</strong>
                  <span>{githubUsage.usage.windowComplete ? "points from other clients" : "other clients after one full tracked window"}</span>
                </div>
              </div>
              <div class="usage-columns">
                <div class="usage-breakdown">
                  <span class="usage-subhead">By feature</span>
                  {#each githubUsage.usage.sources as item}
                    <div class="usage-row">
                      <span>{item.source}</span>
                      <span class="usage-row-track"><i style={`width: ${usagePercent(item.points, githubUsage.usage.localPoints)}%`}></i></span>
                      <strong>{usageNumber.format(item.points)}</strong>
                      <small>{usageNumber.format(item.requests)} calls</small>
                    </div>
                  {:else}
                    <span class="usage-empty">No GraphQL calls recorded in this window.</span>
                  {/each}
                </div>
                <div class="usage-breakdown">
                  <span class="usage-subhead">Top operations</span>
                  {#each githubUsage.usage.operations.slice(0, 8) as item}
                    <div class="usage-operation">
                      <span>{item.operation}</span>
                      <strong>{usageNumber.format(item.points)} pts</strong>
                    </div>
                  {:else}
                    <span class="usage-empty">Usage appears here after the next GitHub request.</span>
                  {/each}
                </div>
              </div>
              <span class="hint usage-window">Resets at {resetTime(githubUsage.quota.resetAt)}. {githubUsage.usage.unknownCostRequests ? `${usageNumber.format(githubUsage.usage.unknownCostRequests)} calls have unknown cost.` : "Every recorded call has an exact cost."}</span>
            {:else if githubUsageError}
              <span class="hint usage-empty">GitHub usage is unavailable.</span>
            {:else}
              <span class="hint usage-empty">Loading usage…</span>
            {/if}
          </section>

          <div class="field field-wide">
            <span class="label">Team sync</span>
            <span class="hint">Relay URL — pushes PR webhook events to every teammate's cockpit; empty means off</span>
            <input class="input mono" bind:value={relayUrl} spellcheck="false" autocomplete="off" />
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
      {/if}

      {#if activeTab === "appearance"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Appearance</span>
          <p>Choose the typography, color, scale and window chrome used across the cockpit.</p>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span class="label">Theme</span>
            <span class="hint">System follows this Mac automatically</span>
            <select class="input narrow" bind:value={themeName}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>

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
            <input class="input narrow" type="number" min="75" max="200" step="5" bind:value={generalScale} />
          </label>

          <label class="field">
            <span class="label">Diff scale (%)</span>
            <span class="hint">Scales diff text and line numbers independently</span>
            <input class="input narrow" type="number" min="75" max="200" step="5" bind:value={diffScale} />
          </label>

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
      {/if}

      {#if activeTab === "keybinds"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Keyboard</span>
          <p>Keep common review actions close without taking focus away from the current PR.</p>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span class="label">Open cockpit</span>
            <span class="hint">Global shortcut that shows the main window from anywhere</span>
            <ShortcutInput value={keybindOpenApp} defaultValue="Command+Control+G" onChange={(a) => (keybindOpenApp = a)} />
          </label>

          <label class="field">
            <span class="label">Open palette</span>
            <span class="hint">Global shortcut for the standalone PR-search palette</span>
            <ShortcutInput value={keybindOpenPalette} defaultValue="Command+Option+K" onChange={(a) => (keybindOpenPalette = a)} />
            {#if keybindClash}
              <span class="hint invalid-hint">Same combo bound twice — pick different shortcuts</span>
            {/if}
          </label>
        </div>
      {/if}

      {#if activeTab === "automerge"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Automation</span>
          <p>Choose which review work can run unattended. Merge paths stay explicit so the next irreversible step is always clear.</p>
        </div>
        <label class="field">
          <span class="label">Agent harness</span>
          <span class="hint">
            which headless CLI every agent runs
            {#if !harnessAvailable[agentHarness]}
              — <strong>{agentHarness} is not installed</strong>, agents will fail to start
            {/if}
          </span>
          <select class="input narrow" bind:value={agentHarness}>
            <option value="claude">Claude Code{harnessAvailable.claude ? "" : " (not installed)"}</option>
            <option value="omp">omp{harnessAvailable.omp ? "" : " (not installed)"}</option>
          </select>
        </label>

        <div class="field">
          <span class="label">Force-merge repositories</span>
          <span class="hint">Force-merge past a required-approval rule when everything else is green — never past failing checks, conflicts, or open threads</span>
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
            <span class="hint">Add repositories under General to enable per-repo force-merge</span>
          {/if}
        </div>

        {#each agents as agent (agent.id)}
          <div class="agent-card" class:agent-disabled={!agent.enabled}>
            <div class="agent-card-head">
              <label class="agent-toggle">
                <input class="check" type="checkbox" bind:checked={agent.enabled} aria-label={`Enable ${agent.name || "agent"}`} />
                <span>{agent.enabled ? "On" : "Off"}</span>
              </label>
              <div class="agent-identity">
                <input class="input agent-name" bind:value={agent.name} placeholder="Agent name" spellcheck="false" autocomplete="off" />
                {#if isCustom(agent)}
                  <span class="hint">Supervised run on a PR — pushes fixes to the PR branch, never merges</span>
                {:else}
                  <span class="hint">{AGENT_META[agent.id]?.description}</span>
                  <span class="hint">{AGENT_META[agent.id]?.offHint}</span>
                {/if}
              </div>
            </div>

            <div class="agent-trigger">
              <span class="trigger-kind">trigger</span>
              <select class="input narrow" bind:value={agent.trigger}>
                <option value="keybind">keybind</option>
                <option value="activity">activity</option>
              </select>
              {#if agent.trigger === "keybind"}
                <input class="input mono keybind-input" maxlength="1" bind:value={agent.keybind} spellcheck="false" autocomplete="off" />
              {/if}
              <span class="trigger-kind">model</span>
              <select class="input narrow" bind:value={agent.model}>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
              </select>
              <span class="hint trigger-hint">{agent.trigger === "keybind" ? "Press its key on a PR or inbox selection" : "Runs automatically when new commits land on your own PRs"}</span>
            </div>
            {#if agentKeybindIssues.has(agent.id)}
              <span class="hint invalid-hint keybind-issue">{agentKeybindIssues.get(agent.id)}</span>
            {/if}

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
        {/each}

        <button class="btn" type="button" onclick={addAgent}>+ Add agent</button>
      {/if}

      {#if activeTab === "tests"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Review defaults</span>
          <p>Choose how code changes are laid out, and keep test code one shortcut away when you need it.</p>
        </div>
        <label class="field">
          <span class="label">Diff layout</span>
          <span class="hint">Applies to pull request changes and file history</span>
          <select class="input narrow" bind:value={diffLayout}>
            <option value="split">Side by side</option>
            <option value="unified">Unified</option>
          </select>
        </label>

        <label class="field">
          <span class="label">Test path pattern</span>
          <span class="hint">Regex marking a file as a test — edit to override the built-in pattern shown below</span>
          <input
            class="input mono"
            class:invalid={testRegexInvalid}
            bind:value={testPathRegex}
            spellcheck="false"
            autocomplete="off"
          />
          {#if testRegexInvalid}
            <span class="hint invalid-hint">Invalid regex — falling back to the built-in pattern</span>
          {/if}
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
      {/if}

      {#if activeTab === "advanced"}
        <label class="field">
          <span class="label">Connect to primary Cockpit database over SSH</span>
          <span class="hint">For example, if you have multiple machines and want to save API quota, PR Cockpit can act as a replica of another machine's database.</span>
          <input class="input mono" bind:value={replicaSshHost} placeholder="user@host" spellcheck="false" autocomplete="off" />
        </label>
      {/if}

      <div class="actions">
        <button class="btn" disabled={saving || keybindClash || agentKeybindIssues.size > 0} onclick={save}>
          {saving ? "Saving…" : "Save"}
          {#if !saving && !keybindClash && agentKeybindIssues.size === 0}<Kbd keys={["cmd", "s"]} />{/if}
        </button>
        {#if saved}<span class="saved">Saved</span>{/if}
      </div>
      </div>
    {/if}
  </div>
</div>

<KeyBar keys={[{ key: "⌘s", label: "save" }, { key: "esc", label: "back" }]} />

<style>
  .page {
    height: var(--general-height);
    overflow-y: auto;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 40px 24px 96px;
  }
  .settings {
    width: 100%;
    max-width: var(--app-content-max-width, 1320px);
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 0 2px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  .head-title {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .error {
    color: var(--fail);
    font-size: 12.5px;
    padding: 10px 13px;
    border: 1px solid var(--fail);
    border-radius: 8px;
    background: var(--fail-bg);
    margin-bottom: 22px;
  }
  .reset-link {
    display: block;
    margin-top: 8px;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: 11.5px;
    cursor: pointer;
  }
  .reset-link:hover {
    text-decoration: underline;
  }
  .reset-link:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
    border-radius: 3px;
  }
  .agent-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 16px 4px;
    margin-bottom: 24px;
  }
  .agent-trigger {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 16px;
  }
  .trigger-kind {
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .keybind-input {
    width: 44px;
    text-align: center;
    padding: 3px 6px;
    font-size: 12px;
  }
  .keybind-issue {
    margin-top: -10px;
    margin-bottom: 16px;
  }
  .agent-name {
    width: 260px;
    padding: 5px 9px;
    font-size: 12.5px;
    margin-bottom: 4px;
  }
  .remove-agent {
    margin-bottom: 12px;
  }
  .trigger-hint {
    margin-bottom: 0;
  }
  .relay-status {
    margin-top: 6px;
  }
  .relay-setup {
    margin: 4px 0 8px;
  }
  .coverage-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 2px 0 10px;
  }
  .coverage-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11.5px;
  }
  .coverage-repo {
    color: var(--text-dim);
  }
  .coverage-live {
    color: var(--ready);
  }
  .coverage-polling {
    color: var(--text-faint);
  }
  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: 11.5px;
    cursor: pointer;
  }
  .link-btn:hover {
    text-decoration: underline;
  }
  .link-btn:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
    border-radius: 3px;
  }
  .repo-toggles {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 4px;
  }
  .repo-toggles .check-field {
    align-items: center;
    margin-bottom: 0;
  }
  .field {
    display: block;
    margin-bottom: 24px;
  }
  .label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  .hint {
    display: block;
    font-size: 11.5px;
    color: var(--text-faint);
    margin-bottom: 8px;
  }
  .input {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 13px;
    padding: 9px 11px;
    resize: vertical;
  }
  .input:focus {
    outline: none;
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--link-bg);
  }
  .input:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .input.invalid {
    border-color: var(--fail);
  }
  .input.invalid:focus {
    box-shadow: 0 0 0 3px var(--fail-bg);
  }
  .invalid-hint {
    color: var(--fail);
    margin-top: 6px;
    margin-bottom: 0;
  }
  .input.narrow {
    width: 140px;
  }
  .check-field {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 24px;
    cursor: pointer;
  }
  .check {
    margin-top: 2px;
    accent-color: var(--ready);
    width: 15px;
    height: 15px;
    flex: none;
  }
  .check:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
    border-radius: 3px;
  }
  .check-text {
    display: block;
  }
  .check-label {
    display: block;
    font-size: 13px;
    color: var(--text);
  }
  .check-field .hint {
    margin-bottom: 0;
    margin-top: 3px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .btn {
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    font-size: 12.5px;
    padding: 8px 18px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--text-faint);
  }
  .btn:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
    border-color: var(--text-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .saved {
    color: var(--ready);
    font-size: 12px;
  }

  .page {
    height: 100%;
    padding: 24px 32px 96px;
  }
  .head {
    position: sticky;
    top: 0;
    z-index: 4;
    align-items: center;
    padding: 10px 2px 16px;
    margin: -10px 0 24px;
    background: var(--overlay-bg);
    backdrop-filter: blur(18px) saturate(160%);
  }
  .settings-head-copy {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .settings-head-copy .ui-eyebrow {
    font-size: 10px;
  }
  .head-title {
    font-family: var(--sans);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.025em;
    text-transform: none;
    color: var(--text);
  }
  .settings-intro {
    max-width: 580px;
    margin: 0 0 16px;
  }
  .settings-intro p {
    margin: 5px 0 0;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 12px;
  }
  .settings-grid .field {
    min-height: 100%;
    margin-bottom: 0;
  }
  .settings-grid .field-wide {
    grid-column: 1 / -1;
  }
  .settings-grid .settings-option {
    min-height: 100%;
    margin: 0;
  }
  .field {
    margin-bottom: 12px;
    padding: 16px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-xs);
  }
  .settings-option {
    margin: 12px 0 0;
    padding: 14px 16px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xs);
  }
  .label {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--text);
  }
  .hint {
    line-height: 1.45;
  }
  .input {
    min-height: 32px;
    background: var(--surface);
    border-color: var(--border);
    border-radius: 8px;
  }
  .input:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .agent-card {
    background: var(--panel);
    border-radius: 12px;
    box-shadow: var(--shadow-xs);
  }
  .settings-panel {
    min-width: 0;
  }
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
    box-shadow: none;
    transition: background-color 140ms ease, box-shadow 140ms ease;
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
    transition: width 140ms var(--ease-out), transform 140ms var(--ease-out);
  }
  .check:checked {
    background: var(--link);
  }
  .check:checked::after {
    transform: translateX(15px);
  }
  .check:not(:disabled) {
    cursor: pointer;
  }
  .check:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
  }
  .check:active:not(:disabled) {
    background: var(--switch-unchecked-pressed);
  }
  .check:checked:active:not(:disabled) {
    background: var(--brand-pressed);
  }
  @media (hover: hover) and (pointer: fine) {
    .check:hover:not(:disabled) {
      background: var(--switch-unchecked-hover);
    }
    .check:checked:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    .check:hover:not(:disabled)::after {
      width: 19px;
    }
  }
  .agent-card-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 12px;
    margin-bottom: 16px;
  }
  .agent-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
  }
  .agent-toggle span {
    min-width: 20px;
  }
  .agent-identity {
    min-width: 0;
  }
  .agent-identity .hint:last-child {
    margin-bottom: 0;
  }
  .agent-card.agent-disabled {
    background: color-mix(in srgb, var(--surface) 64%, var(--panel));
  }
  .agent-prompt {
    margin-bottom: 12px;
    padding: 14px;
    background: var(--surface);
    box-shadow: none;
  }
  .agent-trigger {
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
  }
  .agent-trigger .input.narrow {
    width: 132px;
    flex: none;
  }
  .keybind-input {
    width: 44px;
    min-width: 44px;
    flex: none;
  }
  .trigger-hint {
    flex: 1 1 180px;
    min-width: 0;
    margin: 0;
  }
  .actions {
    margin-top: 24px;
    padding-top: 16px;
  }
  .btn {
    min-height: 32px;
    background: var(--panel);
    border-color: var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-xs);
  }
  .actions .btn {
    background: var(--link);
    border-color: var(--link);
    color: var(--on-brand);
    box-shadow: var(--shadow-control-filled);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) {
      background: var(--surface);
      border-color: var(--border-hover);
    }
    .actions .btn:hover:not(:disabled) {
      background: var(--brand-hover);
      border-color: var(--brand-hover);
    }
  }
  .setup-again {
    margin-bottom: 18px;
  }
  @media (max-width: 760px) {
    .page {
      padding: 18px 16px 84px;
    }
    .settings-grid {
      grid-template-columns: 1fr;
    }
    .settings-grid .field-wide {
      grid-column: auto;
    }
    .agent-card-head {
      grid-template-columns: 1fr;
      gap: 8px;
    }
  }

  /* Settings use Scape's semantic type roles and flat grouped rows. */
  .page {
    --settings-page-inset: 18px;
    padding: var(--settings-page-inset) 32px 96px;
  }
  .head {
    top: calc(-1 * var(--settings-page-inset));
    padding: var(--settings-page-inset) 0 14px;
    margin: calc(-1 * var(--settings-page-inset)) 0 20px;
    border-bottom-color: var(--border-soft);
    background: var(--bg);
    backdrop-filter: none;
  }
  .settings-head-copy {
    gap: 0;
  }
  .settings-head-copy .ui-eyebrow {
    font-size: 12px;
  }
  .head-title {
    font-size: 24px;
    font-weight: 500;
    line-height: 30px;
    letter-spacing: -0.025em;
  }
  .settings-intro {
    max-width: 640px;
    margin-bottom: 18px;
  }
  .settings-intro p {
    margin-top: 3px;
    font-size: 14px;
    line-height: 20px;
  }
  .settings-grid {
    column-gap: 32px;
    row-gap: 0;
  }
  .field,
  .settings-option {
    margin: 0;
    padding: 18px 0;
    border: 0;
    border-top: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .label {
    margin-bottom: 2px;
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: 0;
  }
  .hint {
    margin-bottom: 10px;
    font-family: var(--sans);
    font-size: 12px;
    line-height: 16px;
  }
  .input {
    min-height: 32px;
    border-color: transparent;
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
  }
  textarea.input {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 400;
  }
  .agent-card {
    margin-bottom: 0;
    padding: 20px 0;
    border: 0;
    border-top: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .agent-card.agent-disabled {
    background: transparent;
    opacity: 0.72;
  }
  .agent-prompt {
    padding: 14px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 32px;
    padding-inline: 14px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
  }
  .btn:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
    opacity: 1;
  }
  .actions {
    margin-top: 18px;
    border-top-color: var(--border-soft);
  }
  .actions .btn {
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .actions .btn:disabled {
    background: var(--brand-disabled);
    box-shadow: none;
    color: var(--on-brand);
  }
  .usage-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .usage-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .usage-head .hint {
    margin-bottom: 0;
  }
  .usage-total {
    font-family: var(--sans);
    font-size: 24px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--text);
  }
  .quota-track {
    height: 7px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface);
  }
  .quota-track > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--link);
  }
  .usage-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
  .usage-stats > div {
    min-width: 0;
  }
  .usage-stats strong,
  .usage-stats span {
    display: block;
  }
  .usage-stats strong {
    font-family: var(--sans);
    font-size: 17px;
    font-weight: 500;
    color: var(--text);
  }
  .usage-stats span,
  .usage-empty,
  .usage-operation,
  .usage-row {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .usage-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.65fr);
    gap: 24px;
    padding-top: 2px;
  }
  .usage-breakdown {
    min-width: 0;
  }
  .usage-subhead {
    display: block;
    margin-bottom: 8px;
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .usage-row {
    display: grid;
    grid-template-columns: minmax(92px, 0.7fr) minmax(80px, 1fr) 44px 58px;
    align-items: center;
    gap: 8px;
    min-height: 23px;
  }
  .usage-row > span:first-child,
  .usage-operation > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
  .usage-row strong,
  .usage-operation strong {
    font-size: 11.5px;
    font-weight: 500;
    text-align: right;
    color: var(--text);
  }
  .usage-row small {
    text-align: right;
    color: var(--text-faint);
  }
  .usage-row-track {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface);
  }
  .usage-row-track i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--link);
    opacity: 0.72;
  }
  .usage-operation {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-height: 23px;
  }
  .usage-window {
    margin: 0;
    padding-top: 2px;
    border-top: 1px solid var(--border-soft);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) {
      border-color: transparent;
      background: var(--surface-hover);
    }
    .actions .btn:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  .btn:active:not(:disabled) {
    transform: scale(0.99);
  }
  @media (max-width: 760px) {
    .page {
      --settings-page-inset: 14px;
      padding: var(--settings-page-inset) 16px 84px;
    }
    .settings-grid {
      grid-template-columns: 1fr;
    }
    .usage-stats,
    .usage-columns {
      grid-template-columns: 1fr;
    }
  }
</style>
