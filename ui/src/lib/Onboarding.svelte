<script>
  import { onMount } from "svelte";
  import { fetchAuthStatus, fetchOnboardingRepos, fetchRelayCoverage, fetchSettings, refreshInbox, saveSettings } from "./api.js";
  import { relativeTime } from "./time.js";
  import Kbd from "./Kbd.svelte";
  import GithubSetupModal from "./GithubSetupModal.svelte";
  import { tailscaleAccess } from "./tailscaleAccess.js";

  let { onDone, onCancel = null } = $props();

  const MANUAL_RE = /^[\w.-]+\/[\w.-]+$/;
  const COVERAGE_POLL_MS = 3000;
  const COVERAGE_POLL_LIMIT = 40;

  let step = $state("choose");
  let auth = $state(null);
  let authLoading = $state(true);
  let githubSetup = $state(null);
  let settingsState = $state("loading");
  let settingsError = $state(null);
  let defaultRepo = "";
  let repos = $state([]);
  let reposLoading = $state(false);
  let reposLoaded = $state(false);
  let repoError = $state(null);
  let filter = $state("");
  let chosen = $state([]);
  let manualInput = $state("");
  let manualError = $state(null);
  let coverage = $state(null);
  let coverageState = $state("idle");
  let coverageError = $state(null);
  let coverageTimer = null;
  let coverageRequest = 0;
  let active = true;
  let syncState = $state("idle");
  let syncError = $state(null);
  let settingsSaved = $state(false);
  let health = $state(null);
  let privateAccess = $derived(tailscaleAccess(health));
  let busy = $derived(syncState === "saving" || syncState === "syncing");
  let filteredRepos = $derived(repos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(filter.trim().toLowerCase())));
  let extraRepos = $derived(chosen.filter((name) => !repos.some((repo) => repo.nameWithOwner.toLowerCase() === name.toLowerCase())));
  let coveredCount = $derived(chosen.filter((repo) => coverage?.repos?.[repo] === true).length);
  let coverageConfirmed = $derived(chosen.length > 0 && coveredCount === chosen.length);

  onMount(() => {
    void loadSettings();
    void checkAuth();
    return () => {
      active = false;
      stopCoveragePolling();
    };
  });

  function isChosen(name) {
    return chosen.some((repo) => repo.toLowerCase() === name.toLowerCase());
  }

  async function loadSettings() {
    settingsState = "loading";
    settingsError = null;
    try {
      const settings = await fetchSettings();
      if (!active) return;
      chosen = [...new Set(settings.repos.split(",").map((repo) => repo.trim()).filter(Boolean))];
      defaultRepo = settings.default_repo;
      health = settings.tailscale_serve ? { tailscaleServe: settings.tailscale_serve } : null;
      settingsState = "ready";
    } catch (error) {
      if (!active) return;
      settingsError = error.message;
      settingsState = "failed";
    }
  }

  async function checkAuth() {
    authLoading = true;
    try {
      const result = await fetchAuthStatus();
      if (!active) return;
      auth = result;
      if (auth.ok && !reposLoaded) void loadRepos();
    } catch (error) {
      if (active) auth = { ok: false, state: "error", error: error.message, requiredScopes: ["repo", "workflow"] };
    } finally {
      if (active) authLoading = false;
    }
  }

  function finishGithubSetup(status) {
    if (!active) return;
    auth = status;
    githubSetup = null;
    if (!reposLoaded) void loadRepos();
  }

  async function loadRepos() {
    if (reposLoading) return;
    reposLoading = true;
    repoError = null;
    try {
      const discovered = await fetchOnboardingRepos();
      if (!active) return;
      // Discovery enriches the list; it never owns or resets the user's selection.
      repos = discovered;
      reposLoaded = true;
    } catch (error) {
      if (active) repoError = error.message;
    } finally {
      if (active) reposLoading = false;
    }
  }

  function toggle(name) {
    chosen = isChosen(name) ? chosen.filter((repo) => repo.toLowerCase() !== name.toLowerCase()) : [...chosen, name];
  }

  function addManual() {
    const name = manualInput.trim();
    if (!MANUAL_RE.test(name)) {
      manualError = "Use owner/name, for example octocat/hello-world.";
      return;
    }
    if (!isChosen(name)) chosen = [...chosen, name];
    manualInput = "";
    manualError = null;
  }

  function stopCoveragePolling() {
    coverageRequest += 1;
    clearTimeout(coverageTimer);
    coverageTimer = null;
  }

  async function checkCoverage(watch = false) {
    stopCoveragePolling();
    const request = coverageRequest;
    const selection = [...chosen];
    let attempts = 0;
    coverageState = watch ? "polling" : "checking";
    coverageError = null;
    const current = () => active && step === "review" && request === coverageRequest && syncState === "idle";
    async function check() {
      attempts += 1;
      try {
        const result = await fetchRelayCoverage(selection);
        if (!current()) return;
        coverage = result;
        if (!result.repos) {
          coverageState = "failed";
          coverageError = "Live-update coverage is unavailable. You can still import your inbox.";
        } else if (selection.every((repo) => result.repos[repo] === true)) {
          coverageState = "confirmed";
          coverageError = null;
          return;
        } else {
          coverageState = "ready";
          coverageError = null;
        }
      } catch (error) {
        if (!current()) return;
        coverageState = "failed";
        coverageError = error.message;
      }
      if (!watch) return;
      if (attempts >= COVERAGE_POLL_LIMIT) {
        coverageState = "failed";
        coverageError = "Installation has not been confirmed. Check again, or import now without live updates.";
        return;
      }
      coverageState = "polling";
      coverageTimer = setTimeout(check, COVERAGE_POLL_MS);
    }
    await check();
  }

  function installApp() {
    if (!coverage?.installUrl) return;
    window.open(coverage.installUrl, "_blank", "noopener");
    void checkCoverage(true);
  }

  function review() {
    if (authLoading || !auth?.ok || settingsState !== "ready") return;
    // Do not silently discard a repository typed without pressing Add.
    if (manualInput.trim()) {
      addManual();
      if (manualError) return;
    }
    if (!chosen.length) return;
    step = "review";
    syncState = "idle";
    syncError = null;
    settingsSaved = false;
    coverage = null;
    void checkCoverage();
  }

  function back() {
    if (busy) return;
    stopCoveragePolling();
    step = "choose";
    syncState = "idle";
    syncError = null;
  }

  function cancel() {
    if (busy || !onCancel) return;
    active = false;
    stopCoveragePolling();
    onCancel();
  }

  async function beginSync() {
    if (busy || !chosen.length || !auth?.ok || settingsState !== "ready") return;
    stopCoveragePolling();
    const selection = [...chosen];
    syncError = null;
    syncState = settingsSaved ? "syncing" : "saving";
    try {
      if (!settingsSaved) {
        await saveSettings({ repos: selection.join(","), default_repo: selection.includes(defaultRepo) ? defaultRepo : selection[0] });
        if (!active) return;
        settingsSaved = true;
      }
      syncState = "syncing";
      await refreshInbox();
      if (active) syncState = "complete";
    } catch (error) {
      if (!active) return;
      syncError = error.message;
      syncState = "failed";
    }
  }

  function finish() {
    if (!active || syncState !== "complete") return;
    active = false;
    stopCoveragePolling();
    onDone();
  }

  function onSubmit(event) {
    event.preventDefault();
    if (step === "choose") review();
    else if (syncState === "complete") finish();
    else void beginSync();
  }

  function handleKeydown(event) {
    if (event.key !== "Escape" || githubSetup) return;
    event.preventDefault();
    if (busy) return;
    if (step === "review") back();
    else cancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="onb-page">
  <form class="onb" onsubmit={onSubmit} aria-label="Set up PR Cockpit">
    <header class="onb-header">
      <span class="wordmark">PR Cockpit</span>
      {#if onCancel}<button class="link-button" type="button" disabled={busy} onclick={cancel}>Close setup</button>{/if}
    </header>
    <div class="stepper" aria-label="Setup progress">
      <span class:active={step === "choose"} class:complete={step === "review"} aria-current={step === "choose" ? "step" : undefined}>01 <span>Your repositories</span></span>
      <span class:active={step === "review"} aria-current={step === "review" ? "step" : undefined}>02 <span>Your inbox</span></span>
    </div>

    {#if step === "choose"}
      <h1>{auth?.ok ? "What are you working on?" : "Your PRs. One place."}</h1>
      <div class="account" aria-live="polite">
        {#if authLoading}
          <span class="spinner" aria-hidden="true"></span><span>Checking GitHub connection…</span>
        {:else if auth?.ok}
          <span class="status-dot" aria-hidden="true"></span><span>{auth.login ? `Connected as ${auth.login}` : "Connected to GitHub"}</span>
          <button class="link-button" type="button" onclick={checkAuth}>Check connection</button>
        {:else}
          <div class="connect-copy">
            <strong>Connect your GitHub account</strong>
            <p>Sign in in your browser, then choose which repositories belong in your inbox.</p>
            {#if auth?.state === "error"}<p class="field-error" role="alert">{auth.error}</p>{/if}
          </div>
          <button class="primary" type="button" onclick={() => (githubSetup = auth)}>Connect GitHub</button>
        {/if}
      </div>
      {#if !authLoading && !auth?.ok}
        <details class="permission-details"><summary>What access does Cockpit need?</summary><p>GitHub CLI handles sign-in for the app. GitHub's <code>repo</code> permission lets Cockpit read repositories and carry out your PR actions; <code>workflow</code> supports workflow-file changes. These permissions are broader than your inbox selection. You choose what Cockpit tracks next.</p></details>
      {/if}

      {#if settingsState === "loading"}
        <div class="notice" role="status"><span class="spinner" aria-hidden="true"></span>Loading your saved repository choices…</div>
      {:else if settingsState === "failed"}
        <div class="notice failure-notice" role="alert"><strong>Could not load your settings.</strong><span>{settingsError}</span><span>Retry before choosing repositories, so your saved choices stay intact.</span><button class="link-button" type="button" onclick={loadSettings}>Retry settings</button></div>
      {:else if auth?.ok}
        <div class="section-heading"><h2>Repositories</h2><span aria-live="polite">{chosen.length} selected</span></div>
        {#if repoError}
          <div class="notice failure-notice" role="alert"><strong>Could not discover repositories.</strong><span>{repoError}</span><span>Your choices are intact. Add a repository by name, or retry discovery.</span><button class="link-button" type="button" disabled={reposLoading} onclick={loadRepos}>Retry discovery</button></div>
        {/if}
        {#if reposLoading}<div class="loading-line" role="status"><span class="spinner" aria-hidden="true"></span>Finding your recent repositories… You can add one below.</div>{/if}
        {#if repos.length}
          <label class="filter-field"><span class="sr-only">Filter repositories</span><input class="onb-input" type="search" placeholder="Find a repository…" bind:value={filter} autocomplete="off" /></label>
          <div class="repo-list">
            {#each filteredRepos as repo (repo.nameWithOwner)}
              <label class="repo-row" class:selected={isChosen(repo.nameWithOwner)}>
                <input type="checkbox" checked={isChosen(repo.nameWithOwner)} onchange={() => toggle(repo.nameWithOwner)} />
                <span class="repo-name">{repo.nameWithOwner}{#if repo.isPrivate}<span class="private-label">private</span>{/if}</span>
                <span class="repo-meta">{repo.pushedAt ? relativeTime(repo.pushedAt) : ""}</span>
              </label>
            {:else}<div class="repo-empty">No matches. Add the repository by name below.</div>{/each}
          </div>
        {:else if reposLoaded && !reposLoading && !repoError}
          <div class="notice">No repositories were returned. Add one by name to get started.</div>
        {/if}
        {#each extraRepos as name (name)}
          <div class="manual-repo"><span>{name}</span><button class="link-button" type="button" onclick={() => toggle(name)} aria-label={`Remove ${name}`}>Remove</button></div>
        {/each}
        <label class="manual-label" for="onb-manual-repo">Add by repository name</label>
        <div class="manual-add">
          <input id="onb-manual-repo" class="onb-input" placeholder="owner/repository" bind:value={manualInput} oninput={() => (manualError = null)} onkeydown={(event) => event.key === "Enter" && (event.preventDefault(), addManual())} aria-invalid={!!manualError} aria-describedby={manualError ? "onb-manual-error" : undefined} spellcheck="false" autocomplete="off" />
          <button class="secondary" type="button" onclick={addManual}>Add</button>
        </div>
        {#if manualError}<p id="onb-manual-error" class="field-error" role="alert">{manualError}</p>{/if}
        <div class="actions"><span class="action-note">You can change these in Settings.</span><button class="primary" type="submit" disabled={authLoading || (!chosen.length && !MANUAL_RE.test(manualInput.trim()))}>Continue <span aria-hidden="true">→</span></button></div>
      {/if}
    {:else}
      <h1>{syncState === "complete" ? "You're ready to review." : busy ? "Bringing in your PRs." : "Make room for the work."}</h1>
      <div class="selection-summary"><div class="section-heading"><h2>{chosen.length} {chosen.length === 1 ? "repository" : "repositories"}</h2><button class="link-button" type="button" disabled={busy} onclick={back}>Change</button></div><div class="chosen-repos">{#each chosen as name (name)}<span>{name}</span>{/each}</div></div>

      {#if syncState === "idle"}
        <p class="inbox-copy">Your inbox starts with open PRs involving you in these repositories—not every PR in the organization.</p>
        <section class="live-section" aria-label="Optional live updates">
          <div class="section-heading"><h2>Live updates</h2><span class="optional">Optional</span></div>
          <p>Get GitHub changes through the relay as they happen. Without it, Cockpit checks periodically instead.</p>
          <div class="coverage-status" aria-live="polite">
            {#if coverageConfirmed}<span class="status-dot" aria-hidden="true"></span><span>GitHub App coverage confirmed for your selection.</span>
            {:else if coverageState === "checking"}<span class="spinner" aria-hidden="true"></span><span>Checking GitHub App coverage…</span>
            {:else if coverageState === "polling"}<span class="spinner" aria-hidden="true"></span><span>Waiting for installation. Return here after choosing repositories on GitHub.</span>
            {:else if coverageError}<span>{coverageError}</span>
            {:else}<span>{coveredCount ? `${coveredCount} of ${chosen.length} repositories covered.` : "Not enabled for these repositories yet."}</span>{/if}
          </div>
          {#if !coverageConfirmed}
            <div class="live-actions">
              {#if coverage?.installUrl}<button class="secondary" type="button" onclick={installApp}>Set up on GitHub <span aria-hidden="true">↗</span></button>{/if}
              <button class="link-button" type="button" disabled={coverageState === "checking"} onclick={() => checkCoverage()}>Check again</button>
            </div>
            <p class="small-copy">Install the GitHub App for the repositories you choose. An organization may require an owner's approval. This is separate from signing in.</p>
          {/if}
          <a class="source-link" href="https://github.com/theolundqvist/pr-cockpit/tree/main/relay-server" target="_blank" rel="noreferrer">How the relay works <span aria-hidden="true">↗</span></a>
        </section>
        <div class="actions"><button class="secondary back-button" type="button" onclick={back}>Back <Kbd keys="esc" /></button><button class="primary" type="submit">{coverageConfirmed ? "Build my inbox" : "Import now"} <span aria-hidden="true">→</span></button></div>
        {#if !coverageConfirmed}<p class="footer-note">No need to wait for live updates. You can set them up later in Settings.</p>{/if}
      {:else}
        <div class="sync-list" aria-live="polite" aria-busy={busy}>
          <div class:complete={settingsSaved}><span class:spinner={syncState === "saving"} aria-hidden="true">{syncState === "saving" ? "" : settingsSaved ? "✓" : "·"}</span><span>{settingsSaved ? "Repository choices saved" : syncState === "saving" ? "Saving repository choices…" : "Repository choices not saved"}</span></div>
          <div class:complete={syncState === "complete"}><span class:spinner={syncState === "syncing"} aria-hidden="true">{syncState === "syncing" ? "" : syncState === "complete" ? "✓" : "·"}</span><span>{syncState === "syncing" ? "Syncing your inbox with GitHub…" : syncState === "complete" ? "Inbox refresh finished" : "Inbox refresh"}</span></div>
        </div>
        {#if syncError}
          <div class="notice failure-notice" role="alert"><strong>{settingsSaved ? "Your choices are saved. Sync needs another try." : "Could not save your repository choices."}</strong><span>{syncError}</span><span>Retry, or go back to check your repositories and GitHub connection.</span></div>
          <div class="actions"><button class="secondary" type="button" onclick={back}>Back to repositories</button><button class="primary" type="submit">Try again</button></div>
        {:else if syncState === "complete"}
          <p class="inbox-copy">Start with a PR that needs your attention. If your inbox is empty, there may be no open PRs involving you in these repositories.</p>
          {#if privateAccess?.state === "live"}<div class="notice">Also available on your tailnet at <a href={privateAccess.origin}>{privateAccess.origin}</a></div>{:else if privateAccess?.state === "error"}<div class="notice failure-notice"><strong>Tailscale needs attention.</strong><span>{privateAccess.error}</span></div>{/if}
          <div class="actions"><button class="primary" type="submit">Open my inbox <span aria-hidden="true">→</span></button></div>
        {:else}<p class="footer-note">Keep this setup open while the import finishes. Large repositories can take longer.</p>{/if}
      {/if}
    {/if}
  </form>
  {#if githubSetup}<GithubSetupModal initialStatus={githubSetup} onReady={finishGithubSetup} onClose={() => (githubSetup = null)} />{/if}
</div>

<style>
  .onb-page { height: 100%; overflow-y: auto; display: flex; padding: 40px 24px 64px; }
  .onb { width: 100%; max-width: 640px; margin: auto; padding: 32px; background: var(--panel); border-radius: 16px; box-shadow: var(--shadow-dialog); color: var(--text); }
  .onb-header, .section-heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .onb-header { margin-bottom: 30px; }
  .wordmark { font-size: 13px; font-weight: 650; letter-spacing: -0.02em; }
  .stepper { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 30px; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
  .stepper > span { display: flex; gap: 10px; padding-top: 10px; border-top: 2px solid var(--border); }
  .stepper span span { font-family: var(--sans); }
  .stepper .active { border-color: var(--link); color: var(--text); }
  .stepper .complete { border-color: var(--ready); }
  h1 { margin: 0 0 24px; font-size: clamp(28px, 4vw, 38px); line-height: 1.1; font-weight: 620; letter-spacing: -0.045em; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  p { line-height: 1.55; }
  .account { display: flex; align-items: center; gap: 10px; padding: 14px 0; margin-bottom: 12px; font-size: 12px; color: var(--text-dim); }
  .account .primary { flex: none; }
  .connect-copy { flex: 1; }
  .connect-copy strong { color: var(--text); font-size: 14px; }
  .connect-copy p { margin: 7px 0 0; }
  .permission-details { border-top: 1px solid var(--border); padding-top: 16px; font-size: 12px; color: var(--text-dim); }
  summary { cursor: pointer; }
  .permission-details p { margin-bottom: 0; }
  code { font-family: var(--mono); }
  .status-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ready); }
  .section-heading { margin-bottom: 12px; }
  .section-heading > span { font-size: 11px; color: var(--text-faint); }
  .filter-field { display: block; margin-bottom: 8px; }
  .onb-input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 38px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-family: var(--sans); font-size: 13px; }
  .onb-input:focus { outline: 2px solid var(--focus-ring); border-color: var(--link); }
  .repo-list { max-height: 240px; overflow-y: auto; border-radius: 8px; background: var(--surface); }
  .repo-row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 9px 12px; border-bottom: 1px solid var(--border-soft); cursor: pointer; }
  .repo-row:last-child { border-bottom: 0; }
  .repo-row:hover, .repo-row:focus-within { background: var(--surface-hover); }
  .repo-row.selected { background: color-mix(in srgb, var(--link) 5%, var(--surface)); }
  .repo-row input { width: 15px; height: 15px; flex: none; accent-color: var(--link); }
  .repo-name { min-width: 0; flex: 1; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }
  .private-label { margin-left: 8px; color: var(--text-faint); font-family: var(--sans); font-size: 10px; }
  .repo-meta { flex: none; font-size: 11px; color: var(--text-faint); }
  .repo-empty { padding: 20px; font-size: 12px; color: var(--text-dim); }
  .manual-repo { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; }
  .manual-repo > span { overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; }
  .manual-label { display: block; margin-top: 18px; margin-bottom: 7px; color: var(--text-dim); font-size: 12px; }
  .manual-add { display: flex; gap: 8px; }
  .manual-add .onb-input { font-family: var(--mono); }
  .notice { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin: 16px 0; padding: 14px; background: var(--surface); border-radius: var(--radius-md); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; color: var(--text-dim); }
  .failure-notice { background: var(--fail-bg); }
  .field-error { color: var(--fail); font-size: 12px; margin: 8px 0 0; }
  .loading-line { display: flex; align-items: center; gap: 8px; margin: 12px 0; font-size: 12px; color: var(--text-dim); }
  .actions { margin-top: 24px; }
  .actions > .primary:only-child { margin-left: auto; }
  .action-note { color: var(--text-faint); font-size: 11px; }
  .primary, .secondary { display: inline-flex; align-items: center; justify-content: center; gap: 9px; min-height: 36px; padding: 0 15px; border: 0; border-radius: 999px; font-family: var(--sans); font-size: 13px; font-weight: 500; cursor: pointer; }
  .primary { background: var(--link); color: var(--on-brand); box-shadow: var(--shadow-control-filled); }
  .secondary { background: var(--surface); color: var(--text); box-shadow: var(--shadow-control-outlined); }
  .primary:hover:not(:disabled) { background: var(--brand-hover); }
  .secondary:hover:not(:disabled) { background: var(--surface-hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, a:focus-visible, summary:focus-visible, input[type="checkbox"]:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  .link-button { padding: 0; border: 0; background: none; color: var(--link); font-family: var(--sans); font-size: 12px; cursor: pointer; }
  .selection-summary { padding: 16px; border: 1px solid var(--border); border-radius: 10px; }
  .chosen-repos { display: flex; flex-wrap: wrap; gap: 7px; max-height: 130px; overflow-y: auto; }
  .chosen-repos span { padding: 4px 7px; border-radius: 4px; background: var(--surface); font-family: var(--mono); font-size: 11px; overflow-wrap: anywhere; }
  .inbox-copy { color: var(--text-dim); font-size: 13px; margin: 18px 0; }
  .live-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border); }
  .live-section p { font-size: 12px; color: var(--text-dim); margin: 0 0 14px; }
  .optional { border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; }
  .coverage-status { display: flex; align-items: center; gap: 9px; min-height: 24px; font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .live-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin: 12px 0; }
  .live-section .small-copy { font-size: 11px; color: var(--text-faint); }
  .source-link, .notice a { color: var(--link); font-size: 11px; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer-note { font-size: 11px; color: var(--text-faint); text-align: center; margin: 14px 0 0; }
  .sync-list { display: grid; gap: 16px; margin-top: 24px; padding: 18px 0; }
  .sync-list > div { display: flex; align-items: center; gap: 12px; color: var(--text-dim); font-size: 13px; }
  .sync-list > div > span:first-child { width: 14px; flex: none; text-align: center; }
  .sync-list .complete { color: var(--ready); }
  .spinner { display: inline-block; box-sizing: border-box; width: 14px; height: 14px; flex: none; border: 2px solid var(--border); border-top-color: var(--link); border-radius: 50%; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  @media (max-width: 640px) { .onb-page { padding: 20px 12px 48px; } .onb { padding: 22px; } .account { flex-wrap: wrap; } .connect-copy { flex-basis: 100%; } .repo-meta { display: none; } .actions { flex-wrap: wrap; } .action-note { width: 100%; } }
</style>
