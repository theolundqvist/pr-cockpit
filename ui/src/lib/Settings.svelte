<script>
  import { fetchRelayCoverage, fetchRelayStatus, fetchSettings, saveSettings } from "./api.js";
  import { setCodeTheme, setFonts, setScales, setTheme } from "./theme.svelte.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { BUILTIN_TEST_PATH } from "./testPath.js";
  import { isTypingTarget } from "./dom.js";
  import { scrollStep, scrollPage, scrollEdge } from "./scroll.js";
  import KeyBar from "./KeyBar.svelte";
  import ShortcutInput from "./ShortcutInput.svelte";
  let { onRunSetup } = $props();


  let repos = $state("");
  let defaultRepo = $state("");
  let pollInterval = $state(180);
  let perViewWindowSize = $state(false);
  let perViewWindowPosition = $state(false);
  let themeName = $state("system");
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
  let relayInfo = $state(null);
  let relayCoverage = $state(null);
  let loaded = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state(null);

  const TABS = [
    { id: "general", label: "General" },
    { id: "keybinds", label: "Keybinds" },
    { id: "automerge", label: "Agents" },
    { id: "tests", label: "Diff / Tests" },
  ];
  const TAB_KEY = "cockpit:settings-tab";
  const storedTab = localStorage.getItem(TAB_KEY);
  let activeTab = $state(TABS.some((t) => t.id === storedTab) ? storedTab : "general");
  let tabBar = $state(null);

  $effect(() => localStorage.setItem(TAB_KEY, activeTab));

  function onTabKey(e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const idx = TABS.findIndex((t) => t.id === activeTab);
    const next = (idx + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    activeTab = TABS[next].id;
    tabBar?.querySelectorAll(".tab")[next]?.focus();
    e.preventDefault();
  }

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
    perViewWindowSize = s.per_view_window_size;
    perViewWindowPosition = s.per_view_window_position;
    themeName = s.theme;
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
        per_view_window_size: perViewWindowSize,
        per_view_window_position: perViewWindowPosition,
        theme: themeName,
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
      setFonts(fontUi, fontCode, fontComments);
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
      <a class="back" href="#/">← inbox</a>
      <div class="settings-head-copy">
        <span class="ui-eyebrow">Control center</span>
        <span class="head-title">Settings</span>
      </div>
    </header>

    {#if error}
      <div class="error mono">{error}</div>
    {/if}

    {#if loaded}
      <div class="tabs mono" bind:this={tabBar} onkeydown={onTabKey} role="tablist" aria-label="Settings sections" tabindex="-1">
        {#each TABS as t}
          <button
            class="tab"
            class:active={activeTab === t.id}
            id={`settings-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            aria-controls={`settings-panel-${t.id}`}
            tabindex={activeTab === t.id ? 0 : -1}
            onclick={() => (activeTab = t.id)}
          >{t.label}</button>
        {/each}
      </div>

      <div class="settings-panel" id={`settings-panel-${activeTab}`} role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
      {#if activeTab === "general"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Workspace</span>
          <p>Configure the repositories and update behavior that shape your review queue.</p>
        </div>
        <button class="btn mono setup-again" type="button" onclick={onRunSetup}>Run setup again</button>

        <div class="settings-grid">
          <label class="field field-wide">
            <span class="label mono">Repositories</span>
            <span class="hint mono">one owner/name per line — watched for PRs involving you</span>
            <textarea class="input mono" rows={Math.max(3, repos.split("\n").length)} bind:value={repos} spellcheck="false"></textarea>
          </label>

          <label class="field">
            <span class="label mono">Default repository</span>
            <span class="hint mono">used to resolve bare-number PR jumps</span>
            <input class="input mono" bind:value={defaultRepo} placeholder="owner/name" spellcheck="false" autocomplete="off" />
          </label>

          <label class="field">
            <span class="label mono">Poll interval</span>
            <span class="hint mono">seconds — minimum 60 (GitHub quota), 180 recommended</span>
            <input class="input mono narrow" type="number" min="60" step="10" bind:value={pollInterval} />
          </label>

          <label class="field">
            <span class="label mono">Appearance</span>
            <span class="hint mono">System follows this Mac automatically</span>
            <select class="input narrow" bind:value={themeName}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>

          <label class="field">
            <span class="label mono">Interface font</span>
            <span class="hint mono">opt in to Alacritty's 0xProto Nerd Font Mono for buttons, lists and labels</span>
            <select class="input narrow" bind:value={fontUi}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label mono">Code font</span>
            <span class="hint mono">diff lines and code blocks</span>
            <select class="input narrow" bind:value={fontCode}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label mono">Comment font</span>
            <span class="hint mono">pull request descriptions, comments and reviews</span>
            <select class="input narrow" bind:value={fontComments}>
              <option value="default">Default</option>
              <option value="alacritty">Alacritty — 0xProto</option>
            </select>
          </label>

          <label class="field">
            <span class="label mono">Code colors</span>
            <span class="hint mono">Catppuccin adds richer TypeScript colors and keeps embedded SQL highlighting</span>
            <select class="input narrow" bind:value={codeTheme}>
              <option value="github">GitHub</option>
              <option value="catppuccin">Catppuccin</option>
            </select>
          </label>

          <label class="field">
            <span class="label mono">General scale (%)</span>
            <span class="hint mono">scales everything except diff text</span>
            <input class="input mono narrow" type="number" min="75" max="200" step="5" bind:value={generalScale} />
          </label>

          <label class="field">
            <span class="label mono">Diff scale (%)</span>
            <span class="hint mono">scales diff text and line numbers independently</span>
            <input class="input mono narrow" type="number" min="75" max="200" step="5" bind:value={diffScale} />
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={hideSidebar} />
            <span class="check-text">
              <span class="check-label mono">Hide sidebar</span>
              <span class="hint mono">removes the navigation rail entirely — use ⌘, to return here</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowSize} />
            <span class="check-text">
              <span class="check-label mono">Remember window size per view</span>
              <span class="hint mono">restores the size you last used for the list and PR views</span>
            </span>
          </label>

          <label class="check-field settings-option grid-option">
            <input class="check" type="checkbox" bind:checked={perViewWindowPosition} />
            <span class="check-text">
              <span class="check-label mono">Remember window position per view</span>
              <span class="hint mono">restores the screen position you last used for the list and PR views</span>
            </span>
          </label>

          <div class="field field-wide">
            <span class="label mono">Team sync</span>
            <span class="hint mono">relay URL — pushes PR webhook events to every teammate's cockpit; empty = off</span>
            <input class="input mono" bind:value={relayUrl} spellcheck="false" autocomplete="off" />
            {#if relayStatusText}
              <span class="hint mono relay-status">{relayStatusText}</span>
            {/if}
            {#if relayCoverage?.appExists === false}
              <button class="btn mono relay-setup" type="button" disabled={!relayOrg} onclick={openGithubAppSetup}>Set up GitHub App…</button>
            {/if}
            {#if relayInfo?.url && relayCoverage}
              <div class="coverage-list">
                {#each configuredRepos as repo}
                  <div class="coverage-row mono">
                    <span class="coverage-repo">{repo}</span>
                    {#if relayCoverage.repos?.[repo] === true}
                      <span class="coverage-live">live push ✓</span>
                    {:else if relayCoverage.repos?.[repo] === false}
                      <span class="coverage-polling">polling only</span>
                      {#if relayCoverage.appExists}
                        <button class="link-btn mono" type="button" onclick={() => window.open(relayCoverage.installUrl, "_blank", "noopener")}>Install app</button>
                      {/if}
                    {:else}
                      <span class="coverage-polling">coverage unknown — relay didn't answer</span>
                    {/if}
                  </div>
                {/each}
                {#if relayCoverage.appExists && relayCoverage.repos && configuredRepos.some((r) => relayCoverage.repos[r] === false)}
                  <span class="hint mono">org admins install; members can request it from an admin via the same page</span>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if activeTab === "keybinds"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Keyboard</span>
          <p>Keep common review actions close without taking focus away from the current PR.</p>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span class="label mono">Open cockpit</span>
            <span class="hint mono">global shortcut that shows the main window from anywhere</span>
            <ShortcutInput value={keybindOpenApp} defaultValue="Command+Control+G" onChange={(a) => (keybindOpenApp = a)} />
          </label>

          <label class="field">
            <span class="label mono">Open palette</span>
            <span class="hint mono">global shortcut for the standalone PR-search palette</span>
            <ShortcutInput value={keybindOpenPalette} defaultValue="Command+Option+K" onChange={(a) => (keybindOpenPalette = a)} />
            {#if keybindClash}
              <span class="hint mono invalid-hint">same combo bound twice — pick different shortcuts</span>
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
          <span class="label mono">Agent harness</span>
          <span class="hint mono">
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
          <span class="label mono">Force-merge repositories</span>
          <span class="hint mono">force-merge past a required-approval rule when everything else is green — never past failing checks, conflicts, or open threads</span>
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
            <span class="hint mono">add repositories under General to enable per-repo force-merge</span>
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
                <input class="input mono agent-name" bind:value={agent.name} placeholder="agent name" spellcheck="false" autocomplete="off" />
                {#if isCustom(agent)}
                  <span class="hint mono">supervised run on a PR — pushes fixes to the PR branch, never merges</span>
                {:else}
                  <span class="hint mono">{AGENT_META[agent.id]?.description}</span>
                  <span class="hint mono">{AGENT_META[agent.id]?.offHint}</span>
                {/if}
              </div>
            </div>

            <div class="agent-trigger mono">
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
              <span class="hint mono trigger-hint">{agent.trigger === "keybind" ? "press its key on a PR or inbox selection" : "runs automatically when new commits land on your own PRs"}</span>
            </div>
            {#if agentKeybindIssues.has(agent.id)}
              <span class="hint mono invalid-hint keybind-issue">{agentKeybindIssues.get(agent.id)}</span>
            {/if}

            <label class="field agent-prompt">
              <span class="label mono">Prompt</span>
              <span class="hint mono">{isCustom(agent) ? "the agent's instruction — {{PR_NUMBER}}, {{BASE_REF}} and {{STATUS_FILE}} are filled in per run" : AGENT_META[agent.id]?.promptHint}</span>
              <textarea class="input mono" rows={isCustom(agent) ? 6 : 10} bind:value={agent.promptText} disabled={!agent.enabled} spellcheck="false"></textarea>
              {#if agent.prompt_default && agent.promptText.trim() !== agent.prompt_default.trim()}
                <button class="reset-link mono" type="button" onclick={() => (agent.promptText = agent.prompt_default)}>reset prompt to default</button>
              {/if}
            </label>

            {#if isCustom(agent)}
              <button class="reset-link mono remove-agent" type="button" onclick={() => removeAgent(agent.id)}>remove agent</button>
            {:else}
              <button class="reset-link mono remove-agent" type="button" onclick={() => resetAgent(agent)}>reset agent to defaults</button>
            {/if}
          </div>
        {/each}

        <button class="btn mono" type="button" onclick={addAgent}>+ Add agent</button>
      {/if}

      {#if activeTab === "tests"}
        <div class="settings-intro">
          <span class="ui-eyebrow">Review defaults</span>
          <p>Choose how code changes are laid out, and keep test code one shortcut away when you need it.</p>
        </div>
        <label class="field">
          <span class="label mono">Diff layout</span>
          <span class="hint mono">applies to pull request changes and file history</span>
          <select class="input narrow" bind:value={diffLayout}>
            <option value="split">Side by side</option>
            <option value="unified">Unified</option>
          </select>
        </label>

        <label class="field">
          <span class="label mono">Test path pattern</span>
          <span class="hint mono">regex marking a file as a test — edit to override the built-in pattern shown below</span>
          <input
            class="input mono"
            class:invalid={testRegexInvalid}
            bind:value={testPathRegex}
            spellcheck="false"
            autocomplete="off"
          />
          {#if testRegexInvalid}
            <span class="hint mono invalid-hint">invalid regex — falling back to the built-in pattern</span>
          {/if}
        </label>

        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={hideTestsDefault} />
          <span class="check-text">
            <span class="check-label mono">Hide test files by default</span>
            <span class="hint mono">collapses test files when a PR opens — the per-PR toggle still flips them</span>
          </span>
        </label>

        <label class="check-field settings-option">
          <input class="check" type="checkbox" bind:checked={newestCommentsFirst} />
          <span class="check-text">
            <span class="check-label mono">Show newest comments first</span>
            <span class="hint mono">keeps the PR description at the top, then shows the composer and newest comments first</span>
          </span>
        </label>
      {/if}

      <div class="actions">
        <button class="btn mono" disabled={saving || keybindClash || agentKeybindIssues.size > 0} onclick={save}>{saving ? "Saving…" : "Save"}</button>
        {#if saved}<span class="saved mono">saved</span>{/if}
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
    max-width: 640px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 0 2px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  .back {
    color: var(--text-faint);
    text-decoration: none;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .back:hover {
    color: var(--text-dim);
  }
  .back:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
    border-radius: 3px;
    color: var(--text-dim);
  }
  .head-title {
    font-family: var(--mono);
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
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    font-size: 12.5px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 8px 14px;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text-dim);
  }
  .tab:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: -4px;
    border-radius: 5px;
    color: var(--text-dim);
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--review);
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
  .settings {
    max-width: 920px;
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
  .back {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 8px;
    margin-left: -8px;
    border-radius: 7px;
    font-family: var(--sans);
  }
  @media (hover: hover) and (pointer: fine) {
    .back:hover {
      color: var(--text);
      background: var(--surface);
    }
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
  .tabs {
    display: inline-flex;
    width: fit-content;
    gap: 2px;
    padding: 3px;
    margin-bottom: 22px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .tab {
    min-height: 28px;
    margin: 0;
    padding: 0 11px;
    border: 1px solid transparent;
    border-radius: 7px;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: -0.005em;
    text-transform: none;
  }
  @media (hover: hover) and (pointer: fine) {
    .tab:hover {
      color: var(--text);
      background: var(--panel);
    }
  }
  .tab.active {
    color: var(--text);
    background: var(--panel);
    border-color: var(--border);
    border-bottom-color: var(--border);
    box-shadow: var(--shadow-xs);
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
    width: 34px;
    height: 20px;
    margin: 0;
    flex: none;
    border: 1px solid var(--border-hover);
    border-radius: 999px;
    background: var(--surface);
    box-shadow: inset 0 1px 1px rgb(0 0 0 / 0.05);
    transition: background-color 160ms var(--ease-out), border-color 160ms var(--ease-out), box-shadow 160ms var(--ease-out);
  }
  .check::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--panel);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
    transition: transform 160ms var(--ease-out);
  }
  .check:checked {
    border-color: var(--ready);
    background: var(--ready);
  }
  .check:checked::after {
    transform: translateX(14px);
  }
  .check:not(:disabled) {
    cursor: pointer;
  }
  .check:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
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
    color: #fff;
    box-shadow: 0 1px 1px rgb(1 122 255 / 0.24);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) {
      background: var(--surface);
      border-color: var(--border-hover);
    }
    .actions .btn:hover:not(:disabled) {
      background: #006fe8;
      border-color: #006fe8;
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
</style>
