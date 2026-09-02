<script module>
  // Survives navigating away and back so the page renders instantly from the last snapshot.
  const snapshotCache = new Map();
</script>

<script>
  import ActionStatusIcon from "./ActionStatusIcon.svelte";
  import MultiSelectDropdown from "./MultiSelectDropdown.svelte";
  import { prefetchRepoRun, rememberActionRun } from "./actionPrefetch.js";
  import { fetchRepoActions, fetchSettings } from "./api.js";
  import { durationText, relativeTime } from "./time.js";
  import { isTypingTarget } from "./dom.js";

  let {
    repos: routeRepos = [],
    workflows: routeWorkflows = [],
    status: routeStatus = "all",
    repoProvided = false,
    workflowProvided = false,
    statusProvided = false,
  } = $props();

  const FILTERS_KEY = "cockpit:actions-filters";
  const statusOptions = [
    { id: "all", label: "All", tone: "neutral" },
    { id: "running", label: "Running", tone: "running" },
    { id: "succeeded", label: "Succeeded", tone: "succeeded" },
    { id: "failed", label: "Failed", tone: "failed" },
    { id: "cancelled", label: "Cancelled", tone: "cancelled" },
  ];
  const validStatuses = new Set(statusOptions.map((option) => option.id));

  let selectedRepos = $state([]);
  let repoPickerOpen = $state(false);
  let selectedWorkflows = $state([]);
  let selectedStatus = $state("all");
  let initialized = $state(false);
  let snapshot = $state(null);
  let loading = $state(true);
  let error = $state("");

  let routeKey = $derived(JSON.stringify({ routeRepos, routeWorkflows, routeStatus, repoProvided, workflowProvided, statusProvided }));
  let workflowOptions = $derived((snapshot?.workflows ?? []).map((workflow) => ({ value: workflow.path, label: workflow.name })));
  let selectedWorkflowName = $derived.by(() => {
    if (selectedWorkflows.length !== 1) return "";
    return snapshot?.workflows?.find((workflow) => workflow.path === selectedWorkflows[0])?.name ?? selectedWorkflows[0];
  });

  function persistedFilters() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
      if (!parsed || !Array.isArray(parsed.repos) || !Array.isArray(parsed.workflows)) return null;
      return {
        repos: parsed.repos.filter((value) => typeof value === "string" && value),
        workflows: parsed.workflows.filter((value) => typeof value === "string" && value),
        status: validStatuses.has(parsed.status) ? parsed.status : "all",
      };
    } catch {
      return null;
    }
  }

  function syncSelection(next) {
    selectedRepos = [...next.repos];
    selectedWorkflows = [...next.workflows];
    selectedStatus = next.status;
    localStorage.setItem(FILTERS_KEY, JSON.stringify(next));

    const params = new URLSearchParams();
    if (next.repos.length === 0) params.append("repo", "");
    else for (const repo of next.repos) params.append("repo", repo);
    if (next.workflows.length === 0) params.append("workflow", "");
    else for (const workflow of next.workflows) params.append("workflow", workflow);
    params.set("status", next.status);
    history.replaceState(null, "", `#/actions?${params}`);
  }

  function updateFilters(next) {
    const selection = {
      repos: next.repos ?? selectedRepos,
      workflows: next.workflows ?? selectedWorkflows,
      status: next.status ?? selectedStatus,
    };
    syncSelection(selection);
    if (next.repos !== undefined) {
      if (selection.repos.length) localStorage.setItem("cockpit:repository-scope", JSON.stringify(selection.repos));
      else localStorage.removeItem("cockpit:repository-scope");
    }
  }

  $effect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || event.key.toLowerCase() !== "r") return;
      repoPickerOpen = !repoPickerOpen;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function runDuration(run) {
    if (run.runStartedAt && run.updatedAt) return durationText(run.runStartedAt, run.updatedAt);
    return null;
  }

  function stateLabel(value) {
    return (value || "queued").replaceAll("_", " ");
  }

  function runHref(run) {
    return `#/actions/run/${run.repo}/${run.id}`;
  }

  function moveStatus(event, index) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? statusOptions.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + statusOptions.length) % statusOptions.length;
    updateFilters({ status: statusOptions[nextIndex].id });
    event.currentTarget.parentElement?.querySelectorAll('[role="radio"]')[nextIndex]?.focus();
    event.preventDefault();
  }

  $effect(() => {
    routeKey;
    let stopped = false;
    void fetchSettings().then((settings) => {
      if (stopped) return;
      const persisted = persistedFilters();
      const defaultRepo = typeof settings.default_repo === "string" ? settings.default_repo : "";
      syncSelection({
        repos: repoProvided ? routeRepos.filter(Boolean) : persisted?.repos ?? (defaultRepo ? [defaultRepo] : []),
        workflows: workflowProvided ? routeWorkflows.filter(Boolean) : persisted?.workflows ?? [],
        status: statusProvided && validStatuses.has(routeStatus) ? routeStatus : persisted?.status ?? "all",
      });
      initialized = true;
    }, (nextError) => {
      if (stopped) return;
      error = nextError instanceof Error ? nextError.message : String(nextError);
      loading = false;
    });
    return () => (stopped = true);
  });


  $effect(() => {
    if (!snapshot || selectedWorkflows.length === 0) return;
    const migrated = selectedWorkflows.map((value) => {
      if (snapshot.workflows.some((workflow) => workflow.path === value)) return value;
      return snapshot.workflows.find((workflow) => workflow.name.toLocaleLowerCase() === value.toLocaleLowerCase())?.path ?? value;
    });
    if (migrated.some((value, index) => value !== selectedWorkflows[index])) updateFilters({ workflows: migrated });
  });
  $effect(() => {
    if (!initialized) return;
    const filters = { repo: selectedRepos, workflow: selectedWorkflows, status: selectedStatus };
    const cacheKey = JSON.stringify(filters);
    const controller = new AbortController();
    let stopped = false;

    async function refresh(initial) {
      if (initial) loading = true;
      try {
        const next = await fetchRepoActions(filters, controller.signal);
        if (stopped) return;
        snapshotCache.set(cacheKey, next);
        snapshot = next;
        error = "";
      } catch (nextError) {
        if (!stopped) error = nextError instanceof Error ? nextError.message : String(nextError);
      } finally {
        if (!stopped) loading = false;
      }
    }

    // Returning to the page or switching filters renders the last snapshot at once and
    // refreshes behind it, instead of blanking to a loading state.
    const cached = snapshotCache.get(cacheKey);
    if (cached) snapshot = cached;
    void refresh(!cached);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, 15_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  });

  $effect(() => {
    if (!snapshot) return;
    let cancel = () => {};
    const start = () => {
      cancel();
      if (document.visibilityState !== "visible") return;
      const hotRun = snapshot.runs.find((run) => run.status === "in_progress" || run.conclusion === "failure");
      if (hotRun) cancel = prefetchRepoRun(hotRun);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", start);
    };
  });
</script>

<div class="page">
  <header class="page-head">
    <div>
      <span class="ui-eyebrow">Automation</span>
      <h1>Actions</h1>
    </div>
  </header>

  <section class="filters" aria-label="Workflow run filters">
    <div class="status-tabs" role="radiogroup" aria-label="Status">
      {#each statusOptions as option, index (option.id)}
        <button
          type="button"
          class:active={selectedStatus === option.id}
          class={option.tone}
          role="radio"
          aria-checked={selectedStatus === option.id}
          tabindex={selectedStatus === option.id ? 0 : -1}
          onclick={() => updateFilters({ status: option.id })}
          onkeydown={(event) => moveStatus(event, index)}
        >{option.label}</button>
      {/each}
    </div>
    <div class="filter-pickers">
      <MultiSelectDropdown label="Repository" options={snapshot?.repos ?? []} selected={selectedRepos} plural="repositories" keybind="r" bind:open={repoPickerOpen} onchange={(repos) => updateFilters({ repos })} />
      <MultiSelectDropdown label="Workflow" options={workflowOptions} selected={selectedWorkflows} plural="workflows" onchange={(workflows) => updateFilters({ workflows })} />
    </div>
  </section>

  {#if selectedWorkflowName && snapshot?.latestSuccessful}
    {@const success = snapshot.latestSuccessful}
    <section class="release-summary" aria-label="Latest successful workflow run">
      <ActionStatusIcon status={success.status} conclusion={success.conclusion} />
      <div class="summary-copy">
        <span class="summary-label">Latest successful {selectedWorkflowName}</span>
        <strong>{success.displayTitle}</strong>
        <span>
          {success.runNumber ? `Run #${success.runNumber}` : "Successful run"}
          · {success.headBranch || success.headSha.slice(0, 7)}
          · {relativeTime(success.eventAt)}
        </span>
      </div>
      <a class="summary-link" href={runHref(success)}>Open</a>
    </section>
  {:else if selectedWorkflowName && !loading}
    <section class="release-summary empty-summary">No successful {selectedWorkflowName} run is cached in the last 30 days.</section>
  {/if}

  <section class="runs-panel" aria-label="Workflow runs">
    {#if loading && !snapshot}
      <div class="state">Loading workflow runs…</div>
    {:else if error && !snapshot}
      <div class="state error">Couldn’t load workflow runs: {error}</div>
    {:else if (snapshot?.runs?.length ?? 0) === 0}
      <div class="state">No workflow runs match these filters.</div>
    {:else}
      {#each snapshot.runs as run (`${run.repo}:${run.id}:${run.attempt}`)}
        <a class="run-row" href={runHref(run)} onclick={() => {
          rememberActionRun(run);
          prefetchRepoRun(run);
        }}>
          <ActionStatusIcon status={run.status} conclusion={run.conclusion} />
          <span class="run-copy">
            <strong>{run.displayTitle}</strong>
            <span class="run-meta">
              <b>{run.workflowName}</b>{run.runNumber ? ` #${run.runNumber}` : ""}
              {#if run.event} · {run.event.replaceAll("_", " ")}{/if}
              {#if run.actorLogin} · {run.actorLogin}{/if}
            </span>
          </span>
          <span class="run-context">
            {#if run.headBranch}<span class="branch">{run.headBranch}</span>{/if}
            {#if (snapshot.repos?.length ?? 0) > 1}<span>{run.repo}</span>{/if}
          </span>
          <span class="run-time">
            <span>{relativeTime(run.eventAt)}</span>
            <span>{runDuration(run) ?? stateLabel(run.conclusion ?? run.status)}</span>
          </span>
        </a>
      {/each}
    {/if}
  </section>
</div>

<style>
  .page { height: 100%; min-width: 0; overflow-y: auto; padding: 18px 32px 96px; }
  .page-head { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--border); }
  .page-head > div:first-child { display: flex; flex-direction: column; gap: 2px; }
  .ui-eyebrow { color: var(--text-faint); font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
  h1 { margin: 0; color: var(--text); font-size: 18px; font-weight: 650; }
  .filters { display: flex; min-height: 58px; margin-bottom: 20px; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--border); }
  .filter-pickers { display: flex; align-items: center; gap: 10px; }
  .status-tabs { display: inline-flex; width: fit-content; padding: 3px; gap: 2px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  .status-tabs button { display: inline-flex; min-height: 28px; padding: 0 10px; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 7px; color: var(--text-dim); background: transparent; font: 500 12px var(--sans); letter-spacing: -0.005em; cursor: pointer; }
  .status-tabs button::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tab-tone, var(--text-faint)); opacity: .55; }
  .status-tabs button.neutral::before { display: none; }
  @media (hover: hover) and (pointer: fine) {
    .status-tabs button:hover { color: var(--text); background: var(--panel); }
  }
  .status-tabs button.active { color: var(--text); background: var(--panel); border-color: var(--border); box-shadow: var(--shadow-xs); }
  .status-tabs button.active::before { opacity: 1; }
  .status-tabs button.running { --tab-tone: var(--review); }
  .status-tabs button.succeeded { --tab-tone: var(--ready); }
  .status-tabs button.failed { --tab-tone: var(--fail); }
  .status-tabs button.cancelled { --tab-tone: var(--text-faint); }
  .release-summary { display: flex; min-height: 72px; margin-bottom: 16px; padding: 14px 16px; align-items: center; gap: 12px; border: 1px solid color-mix(in srgb, var(--ready) 36%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--ready) 7%, var(--panel)); }
  .summary-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .summary-copy strong { overflow: hidden; color: var(--text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .summary-copy span { color: var(--text-faint); font-size: 11px; }
  .summary-label { color: var(--ready) !important; font-weight: 650; text-transform: uppercase; letter-spacing: .03em; }
  .summary-link { color: var(--accent); font-size: 12px; text-decoration: none; }
  .empty-summary { color: var(--text-faint); font-size: 12px; }
  .runs-panel { overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .state { padding: 28px; color: var(--text-faint); font-size: 12px; text-align: center; }
  .error { color: var(--fail); }
  .run-row { display: grid; width: 100%; min-height: 72px; padding: 13px 16px; grid-template-columns: 18px minmax(260px, 1fr) minmax(130px, auto) 105px; align-items: start; gap: 10px; border-bottom: 1px solid var(--border); color: inherit; background: transparent; text-align: left; text-decoration: none; cursor: pointer; }
  .run-row:last-child { border-bottom: 0; }
  .run-row:hover { background: var(--hover); }
  .run-copy { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
  .run-copy > strong { overflow: hidden; color: var(--text); font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta { overflow: hidden; color: var(--text-faint); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta b { color: var(--text-muted); font-weight: 600; }
  .run-context, .run-time { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; color: var(--text-faint); font-size: 11px; }
  .branch { max-width: 220px; overflow: hidden; padding: 2px 6px; border-radius: 4px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font-family: var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 1100px) {
    .filters { align-items: flex-start; flex-direction: column; padding: 12px 0; }
    .filter-pickers { width: 100%; }
  }
  @media (max-width: 900px) {
    .filter-pickers, .status-tabs { width: 100%; }
    .status-tabs button { flex: 1; padding: 0 5px; }
    .run-row { grid-template-columns: 18px minmax(0, 1fr) 90px; }
    .run-context { display: none; }
  }
</style>
