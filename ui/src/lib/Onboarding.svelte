<script>
  import { fetchAuthStatus, fetchOnboardingRepos, fetchRelayCoverage, fetchSettings, refreshInbox, saveSettings } from "./api.js";
  import { relativeTime } from "./time.js";
  import Kbd from "./Kbd.svelte";
  import GithubSetupModal from "./GithubSetupModal.svelte";

  let { onDone, onCancel = null } = $props();

  const MANUAL_RE = /^[\w.-]+\/[\w.-]+$/;
  const COVERAGE_POLL_MS = 3000;
  const COVERAGE_POLL_LIMIT = 40;

  let step = $state(1);
  let auth = $state(null);
  let githubSetup = $state(null);
  let authLoading = $state(true);
  let repos = $state([]);
  let reposLoading = $state(false);
  let reposLoaded = $state(false);
  let repoError = $state(null);
  let filter = $state("");
  let selected = $state(new Set());
  let manual = $state([]);
  let manualInput = $state("");
  let manualError = $state(null);
  let coverage = $state(null);
  let coverageState = $state("idle");
  let coverageError = $state(null);
  let coverageAttempts = $state(0);
  let skippedLive = $state(false);
  let coverageTimer = null;
  let syncState = $state("idle");
  let syncError = $state(null);

  const configuredRepos = fetchSettings()
    .then((settings) => settings.repos.split(",").map((repo) => repo.trim()).filter(Boolean))
    .catch(() => []);

  let chosen = $derived([...new Set([...manual, ...repos.filter((repo) => selected.has(repo.nameWithOwner)).map((repo) => repo.nameWithOwner)])]);
  let filteredRepos = $derived(repos.filter((repo) => repo.nameWithOwner.toLowerCase().includes(filter.trim().toLowerCase())));
  let coverageConfirmed = $derived(
    !!coverage?.repos && chosen.length > 0 && chosen.every((repo) => coverage.repos[repo] === true),
  );

  $effect(() => {
    checkAuth();
  });

  $effect(() => () => clearTimeout(coverageTimer));

  $effect(() => {
    function onKeydown(event) {
      if (event.key !== "Escape") return;
      if (step > 1) {
        if (step === 3) stopCoveragePolling();
        step -= 1;
        event.preventDefault();
      } else if (onCancel) {
        onCancel();
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  async function checkAuth() {
    authLoading = true;
    try {
      auth = await fetchAuthStatus();
    } catch (error) {
      auth = { ok: false, login: null, error: error.message };
    } finally {
      authLoading = false;
    }
  }
  function finishGithubSetup(status) {
    auth = status;
    githubSetup = null;
  }


  async function loadRepos() {
    if (reposLoading) return;
    reposLoading = true;
    repoError = null;
    try {
      const discovered = await fetchOnboardingRepos();
      const existing = await configuredRepos;
      repos = discovered;
      const discoveredNames = new Set(discovered.map((repo) => repo.nameWithOwner));
      selected = new Set(existing.filter((repo) => discoveredNames.has(repo)));
      manual = existing.filter((repo) => !discoveredNames.has(repo));
      reposLoaded = true;
    } catch (error) {
      manual = await configuredRepos;
      repoError = error.message;
      reposLoaded = true;
    } finally {
      reposLoading = false;
    }
  }

  function toggle(name) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selected = next;
  }

  function addManual() {
    const value = manualInput.trim();
    if (!MANUAL_RE.test(value)) {
      manualError = "Use owner/name, for example octocat/hello-world.";
      return;
    }
    manualError = null;
    if (!manual.includes(value) && !repos.some((repo) => repo.nameWithOwner === value)) manual = [...manual, value];
    else if (repos.some((repo) => repo.nameWithOwner === value)) selected = new Set([...selected, value]);
    manualInput = "";
  }

  function removeManual(name) {
    manual = manual.filter((repo) => repo !== name);
  }

  function coverageResult(result) {
    coverage = result;
    if (!result.repos) {
      coverageState = "failed";
      coverageError = "The shared relay could not report coverage. You can retry, or skip live updates and use polling.";
      return false;
    }
    coverageError = null;
    coverageState = chosen.every((repo) => result.repos[repo] === true) ? "confirmed" : "ready";
    return coverageState === "confirmed";
  }

  async function checkCoverage() {
    coverageState = "checking";
    coverageError = null;
    try {
      coverageResult(await fetchRelayCoverage(chosen));
    } catch (error) {
      coverageState = "failed";
      coverageError = `${error.message}. Retry, or skip live updates and use polling.`;
    }
  }

  function stopCoveragePolling() {
    clearTimeout(coverageTimer);
    coverageTimer = null;
  }

  async function pollCoverage() {
    coverageAttempts += 1;
    try {
      if (coverageResult(await fetchRelayCoverage(chosen))) {
        stopCoveragePolling();
        return;
      }
    } catch (error) {
      coverageError = `${error.message}. Retrying…`;
    }
    if (coverageAttempts >= COVERAGE_POLL_LIMIT) {
      coverageState = "failed";
      coverageError = "The GitHub App installation was not detected after two minutes. Retry the check, or skip live updates and use polling.";
      stopCoveragePolling();
      return;
    }
    coverageState = "polling";
    coverageTimer = setTimeout(pollCoverage, COVERAGE_POLL_MS);
  }

  function installApp() {
    if (!coverage?.installUrl) return;
    window.open(coverage.installUrl, "_blank", "noopener");
    skippedLive = false;
    coverageAttempts = 0;
    stopCoveragePolling();
    coverageState = "polling";
    pollCoverage();
  }

  function skipLiveUpdates() {
    stopCoveragePolling();
    skippedLive = true;
    coverageState = "skipped";
  }

  async function beginSync() {
    if (syncState === "saving" || syncState === "syncing") return;
    syncError = null;
    syncState = "saving";
    try {
      await saveSettings({ repos: chosen.join(","), default_repo: chosen[0] });
      syncState = "syncing";
      await refreshInbox();
      syncState = "complete";
    } catch (error) {
      syncError = error.message;
      syncState = "failed";
    }
  }

  function advance() {
    if (step === 1 && auth?.ok) {
      step = 2;
      loadRepos();
    } else if (step === 2 && chosen.length) {
      step = 3;
      skippedLive = false;
      checkCoverage();
    } else if (step === 3 && (coverageConfirmed || skippedLive)) {
      stopCoveragePolling();
      step = 4;
      beginSync();
    } else if (step === 4 && syncState === "complete") {
      onDone();
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    advance();
  }
</script>

<div class="onb-page">
  <form class="onb" onsubmit={onSubmit}>
    <div class="stepper" aria-label="Setup progress">
      {#each ["Connect", "Repos", "Live updates", "Done"] as label, index}
        <span class:active={step === index + 1} class:complete={step > index + 1}>{index + 1}. {label}</span>
      {/each}
    </div>

    {#if step === 1}
      <span class="eyebrow">Step 1 of 4</span>
      <h1 class="onb-title">Connect GitHub.</h1>

      <div class="status-card" aria-live="polite">
        {#if authLoading}
          <span class="spinner" aria-hidden="true"></span>
          <span>Checking GitHub authentication…</span>
        {:else if auth?.ok}
          <span class="status-mark success" aria-hidden="true">✓</span>
          {#if auth.login}<span>Connected as <strong>{auth.login}</strong></span>{:else}<span>Connected to GitHub</span>{/if}
        {:else}
          <span class="status-mark failure" aria-hidden="true">!</span>
          <span>{auth?.error}</span>
        {/if}
      </div>

      <div class="actions">
        {#if !auth?.ok && !authLoading}
          <button class="secondary" type="button" onclick={() => (githubSetup = { requiredScopes: ["repo", "workflow"], state: "error", ...auth })}>Set up GitHub</button>
        {/if}
        <button class="primary" type="submit" disabled={!auth?.ok}>Continue</button>
      </div>
    {:else if step === 2}
      <span class="eyebrow">Step 2 of 4</span>
      <h1 class="onb-title">Choose repositories.</h1>

      {#if repoError}
        <div class="notice failure-notice" role="alert">
          <strong>Repository discovery failed.</strong>
          <span>{repoError}</span>
          <button class="link-button" type="button" onclick={loadRepos}>Try again</button>
          <span>You can also add repositories manually below.</span>
        </div>
      {:else if reposLoading}
        <div class="status-card"><span class="spinner" aria-hidden="true"></span><span>Loading your recent repositories…</span></div>
      {:else if reposLoaded && repos.length === 0}
        <div class="notice">
          <strong>No repositories were returned.</strong>
          <span>Your account may not have repository access yet. Add an owner/name manually to continue.</span>
        </div>
      {/if}

      {#if repos.length}
        <label class="filter-field">
          <span class="sr-only">Filter repositories</span>
          <input class="onb-input" type="search" placeholder="Filter repositories…" bind:value={filter} autocomplete="off" />
        </label>
        <div class="repo-list">
          {#if filteredRepos.length}
            {#each filteredRepos as repo}
              <label class="repo-row">
                <input class="check" type="checkbox" checked={selected.has(repo.nameWithOwner)} onchange={() => toggle(repo.nameWithOwner)} />
                <span class="repo-name mono">{repo.nameWithOwner}{#if repo.isPrivate}<span class="lock">private</span>{/if}</span>
                <span class="repo-meta mono">{repo.pushedAt ? relativeTime(repo.pushedAt) : ""}</span>
              </label>
            {/each}
          {:else}
            <div class="repo-empty">No repositories match “{filter}”. Clear the filter or add one manually.</div>
          {/if}
        </div>
      {/if}

      {#each manual as name}
        <div class="manual-repo">
          <span>{name}</span>
          <button type="button" onclick={() => removeManual(name)} aria-label={`Remove ${name}`}>remove</button>
        </div>
      {/each}

      <div class="manual-add">
        <input
          class="onb-input mono"
          placeholder="owner/name"
          bind:value={manualInput}
          oninput={() => (manualError = null)}
          onkeydown={(event) => event.key === "Enter" && (event.preventDefault(), addManual())}
          spellcheck="false"
          autocomplete="off"
        />
        <button class="secondary shortcut-action" type="button" onclick={addManual}>
          Add <span class="manual-key"><Kbd keys="enter" /></span>
        </button>
      </div>
      {#if manualError}<p class="field-error" role="alert">{manualError}</p>{/if}

      <div class="actions">
        <button class="secondary shortcut-action" type="button" onclick={() => (step = 1)}>Back <Kbd keys="esc" /></button>
        <button class="primary" type="submit" disabled={!chosen.length}>Continue{chosen.length ? ` with ${chosen.length}` : ""}</button>
      </div>
    {:else if step === 3}
      <span class="eyebrow">Step 3 of 4</span>
      <h1 class="onb-title">Always up to date.</h1>

      {#if !coverageConfirmed && !skippedLive}
        <p class="relay-copy">Install the free GitHub App, choose repositories, then return.</p>
      {/if}

      {#if coverageState !== "ready" && coverageState !== "idle"}
        <div class="status-card coverage-card" aria-live="polite">
          {#if coverageState === "checking"}
            <span class="spinner" aria-hidden="true"></span>
            <span>Checking {chosen.length} {chosen.length === 1 ? "repository" : "repositories"}…</span>
          {:else if coverageConfirmed}
            <span class="status-mark success" aria-hidden="true">✓</span>
            <span>Live updates are on.</span>
          {:else if coverageState === "polling"}
            <span class="spinner" aria-hidden="true"></span>
            <span>Waiting for GitHub…</span>
          {:else if skippedLive}
            <span class="status-mark" aria-hidden="true">→</span>
            <span>Polling every few minutes.</span>
          {:else if coverageError}
            <span class="status-mark failure" aria-hidden="true">!</span>
            <span>{coverageError}</span>
          {/if}
        </div>
      {/if}

      {#if !coverageConfirmed && !skippedLive}
        <div class="live-actions">
          {#if coverage?.installUrl}
            <button class="primary" type="button" onclick={installApp}>Install on GitHub</button>
          {/if}
          {#if coverageState === "failed"}
            <button class="secondary" type="button" onclick={checkCoverage}>Retry check</button>
          {/if}
        </div>
      {/if}

      <p class="relay-meta">
        Open-source Cloudflare relay. Stores event markers only—no PR data or logs.
        <a href="https://github.com/theolundqvist/pr-cockpit/tree/main/relay" target="_blank" rel="noreferrer">Source</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/theolundqvist/pr-cockpit/blob/main/docs/self-host-relay.md" target="_blank" rel="noreferrer">Self-host</a>
      </p>

      <div class="polling-option">
        <span>No relay: polling may be stale.</span>
        {#if !coverageConfirmed && !skippedLive}
          <button class="link-button" type="button" onclick={skipLiveUpdates}>Use polling</button>
        {/if}
      </div>

      <div class="actions">
        <button class="secondary shortcut-action" type="button" onclick={() => (stopCoveragePolling(), step = 2)}>Back <Kbd keys="esc" /></button>
        <button class="primary" type="submit" disabled={!coverageConfirmed && !skippedLive}>Continue</button>
      </div>
    {:else}
      <span class="eyebrow">Step 4 of 4</span>
      <h1 class="onb-title">Build your inbox.</h1>

      <div class="sync-list" aria-live="polite">
        <div class:complete={syncState !== "saving" && syncState !== "idle"}>
          <span>{syncState === "saving" ? "…" : "✓"}</span>
          <span>Save {chosen.length} {chosen.length === 1 ? "repository" : "repositories"}</span>
        </div>
        <div class:active={syncState === "syncing"} class:complete={syncState === "complete"}>
          <span>{syncState === "syncing" ? "…" : syncState === "complete" ? "✓" : "·"}</span>
          <span>{syncState === "syncing" ? "Fetching pull requests from GitHub…" : "First inbox sync"}</span>
        </div>
      </div>

      {#if syncError}
        <div class="notice failure-notice" role="alert">
          <strong>First sync failed.</strong>
          <span>{syncError}</span>
          <button class="link-button" type="button" onclick={beginSync}>Try again</button>
        </div>
      {:else if syncState === "complete"}
        <p class="ready-copy">Your inbox is ready.</p>
      {/if}

      <div class="actions">
        <button class="primary" type="submit" disabled={syncState !== "complete"}>Open inbox</button>
      </div>
    {/if}
  </form>

{#if githubSetup}
  <GithubSetupModal initialStatus={githubSetup} onReady={finishGithubSetup} onClose={() => (githubSetup = null)} />
{/if}
</div>

<style>
  .onb-page {
    height: 100%;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 48px 24px 80px;
  }
  .onb {
    width: 100%;
    max-width: 580px;
    padding: 28px;
    background: var(--panel);
    border: 0;
    border-radius: 16px;
    box-shadow: var(--shadow-dialog);
  }
  .stepper {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin-bottom: 28px;
    color: var(--text-faint);
    font-size: 10px;
  }
  .stepper span {
    padding-top: 7px;
    border-top: 2px solid var(--border);
  }
  .stepper .active {
    color: var(--text);
    border-color: var(--link);
  }
  .stepper .complete {
    color: var(--ready);
    border-color: var(--ready);
  }
  .eyebrow {
    display: block;
    margin-bottom: 7px;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 16px;
    letter-spacing: 0;
    text-transform: none;
  }
  .onb-title {
    margin: 0 0 28px;
    color: var(--text);
    font-size: 32px;
    font-weight: 620;
    line-height: 34px;
    letter-spacing: -0.048em;
  }
  .status-card,
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 13px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .notice {
    flex-direction: column;
    margin-bottom: 14px;
  }
  .failure-notice {
    border-color: color-mix(in srgb, var(--fail) 45%, var(--border));
    background: var(--fail-bg);
  }
  .status-mark {
    display: grid;
    width: 18px;
    height: 18px;
    flex: none;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
  }
  .status-mark.success {
    color: var(--ready);
    border-color: var(--ready);
  }
  .status-mark.failure {
    color: var(--fail);
    border-color: var(--fail);
  }
  .spinner {
    width: 14px;
    height: 14px;
    flex: none;
    border: 2px solid var(--border);
    border-top-color: var(--link);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .filter-field {
    display: block;
    margin-bottom: 10px;
  }
  .repo-list {
    max-height: 280px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--surface);
  }
  .repo-row {
    display: flex;
    min-height: 42px;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--border-soft);
  }
  .repo-row:last-child {
    border-bottom: none;
  }
  .repo-row:hover,
  .repo-row:focus-within {
    background: var(--panel);
  }
  .check {
    width: 15px;
    height: 15px;
    flex: none;
    accent-color: var(--ready);
  }
  .check:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .repo-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--text);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lock {
    margin-left: 8px;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-faint);
    font-size: 10px;
    text-transform: uppercase;
  }
  .repo-meta {
    color: var(--text-faint);
    font-size: 11px;
  }
  .repo-empty {
    padding: 18px;
    color: var(--text-faint);
    font-size: 12px;
    text-align: center;
  }
  .manual-repo {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
    padding: 8px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .manual-repo button {
    border: 0;
    background: none;
    color: var(--text-faint);
    cursor: pointer;
  }
  .manual-add {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .onb-input {
    min-height: 36px;
    box-sizing: border-box;
    width: 100%;
    flex: 1;
    padding: 9px 11px;
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
  }
  .onb-input:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .field-error {
    margin: 7px 0 0;
    color: var(--fail);
    font-size: 11.5px;
  }
  .relay-copy {
    margin: 0;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.45;
  }
  .coverage-card {
    min-height: 44px;
    margin-top: 16px;
    padding: 0;
    background: transparent;
  }
  .live-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .relay-meta {
    margin-top: 22px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font-size: 11px;
    line-height: 1.5;
  }
  .relay-meta a {
    color: var(--link);
    text-decoration: none;
  }
  .relay-meta a:hover {
    text-decoration: underline;
  }
  .polling-option {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-top: 16px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.45;
  }
  .polling-option .link-button {
    flex: none;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 24px;
  }
  .shortcut-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .manual-key {
    display: none;
  }
  .manual-add:focus-within .manual-key {
    display: inline-flex;
  }
  .primary,
  .secondary {
    min-height: 32px;
    padding: 0 14px;
    border: 0;
    border-radius: 999px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .primary {
    background: var(--link);
    color: var(--on-brand);
    box-shadow: var(--shadow-control-filled);
  }
  .secondary {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-control-outlined);
  }
  .primary:hover:not(:disabled) {
    background: var(--brand-hover);
  }
  .secondary:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .primary:focus-visible,
  .secondary:focus-visible,
  .link-button:focus-visible,
  .manual-repo button:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .primary:disabled {
    background: var(--brand-disabled);
    box-shadow: none;
    color: var(--on-brand);
    cursor: default;
  }
  .primary:active:not(:disabled),
  .secondary:active:not(:disabled) {
    transform: scale(0.99);
  }
  .link-button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font-size: 12px;
    cursor: pointer;
  }
  .sync-list {
    display: grid;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }
  .sync-list div {
    display: flex;
    gap: 10px;
    color: var(--text-faint);
    font-size: 12px;
  }
  .sync-list .active {
    color: var(--text);
  }
  .sync-list .complete {
    color: var(--ready);
  }
  .ready-copy {
    margin: 14px 0 0;
    color: var(--ready);
    font-size: 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .onb-page {
      align-items: flex-start;
      padding: 20px 14px 64px;
    }
    .onb {
      padding: 20px;
    }
    .stepper {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
