<script>
  import ActionsGraph from "./ActionsGraph.svelte";
  import { fetchActionGraph, fetchActionLog, fetchActions } from "./api.js";
  import { durationText, relativeTime } from "./time.js";

  let { repo, number, headSha } = $props();

  let snapshot = $state(null);
  let loading = $state(true);
  let loadError = $state("");
  let graphSnapshot = $state(null);
  let graphError = $state("");
  let overviewMode = $state(true);
  let refreshNonce = $state(0);
  let selectedJobId = $state(null);
  let logs = $state({});
  let logErrors = $state({});
  let logLoadingId = $state(null);

  const terminalFailures = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);

  function stateLabel(value) {
    return (value || "queued").replaceAll("_", " ");
  }

  function stateTone(status, conclusion) {
    const value = conclusion ?? status;
    if (value === "success") return "ready";
    if (terminalFailures.has(value)) return "fail";
    if (status === "queued" || status === "waiting" || status === "in_progress") return "wait";
    return "neutral";
  }

  function jobTime(job) {
    if (job.startedAt && job.completedAt) return durationText(job.startedAt, job.completedAt);
    if (job.startedAt) return `started ${relativeTime(job.startedAt)}`;
    return "waiting";
  }

  function runnerLabel(job) {
    if (job.runnerName) return job.runnerGroupName ? `${job.runnerGroupName} / ${job.runnerName}` : job.runnerName;
    return job.labels.join(", ");
  }

  let groups = $derived.by(() => {
    const byRun = new Map();
    for (const run of snapshot?.runs ?? []) {
      byRun.set(`${run.id}:${run.attempt}`, { run, jobs: [] });
    }
    for (const job of snapshot?.jobs ?? []) {
      const key = `${job.runId}:${job.attempt}`;
      const group = byRun.get(key) ?? {
        run: {
          id: job.runId,
          attempt: job.attempt,
          workflowName: job.workflowName,
          status: job.status,
          conclusion: job.conclusion,
          eventAt: job.completedAt ?? job.startedAt,
        },
        jobs: [],
      };
      group.jobs.push(job);
      byRun.set(key, group);
    }
    return [...byRun.values()]
      .map((group) => ({
        ...group,
        jobs: group.jobs.sort((left, right) => {
          const leftAt = left.startedAt ? Date.parse(left.startedAt) : left.id;
          const rightAt = right.startedAt ? Date.parse(right.startedAt) : right.id;
          return leftAt - rightAt;
        }),
      }))
      .sort((left, right) => Date.parse(right.run.eventAt ?? 0) - Date.parse(left.run.eventAt ?? 0));
  });

  let selectedJob = $derived((snapshot?.jobs ?? []).find((job) => job.id === selectedJobId) ?? null);
  let selectedLog = $derived(selectedJobId === null ? null : logs[selectedJobId] ?? null);
  let selectedLogError = $derived(selectedJobId === null ? "" : logErrors[selectedJobId] ?? "");
  let hasActiveJobs = $derived((snapshot?.jobs ?? []).some((job) => job.status !== "completed"));

  function chooseDefaultJob(jobs) {
    return jobs.find((job) => terminalFailures.has(job.conclusion))
      ?? jobs.find((job) => job.status !== "completed")
      ?? jobs[0]
      ?? null;
  }

  $effect(() => {
    const key = `${repo}#${number}:${headSha}:${refreshNonce}`;
    let stopped = false;

    async function refresh(initial) {
      if (initial) loading = true;
      try {
        const next = await fetchActions(repo, number);
        if (stopped || key !== `${repo}#${number}:${headSha}:${refreshNonce}`) return;
        snapshot = next;
        loadError = "";
        if (!next.jobs.some((job) => job.id === selectedJobId)) {
          selectedJobId = chooseDefaultJob(next.jobs)?.id ?? null;
        }
      } catch (error) {
        if (!stopped) loadError = error instanceof Error ? error.message : String(error);
      } finally {
        if (!stopped) loading = false;
      }
    }

    void refresh(true);
    const timer = setInterval(() => {
      if (hasActiveJobs) void refresh(false);
    }, 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
  $effect(() => {
    const key = `${repo}#${number}:${headSha}:${refreshNonce}`;
    let stopped = false;
    fetchActionGraph(repo, number).then(
      (next) => {
        if (stopped || key !== `${repo}#${number}:${headSha}:${refreshNonce}`) return;
        graphSnapshot = next;
        graphError = "";
      },
      (error) => {
        if (!stopped) graphError = error instanceof Error ? error.message : String(error);
      },
    );
    return () => {
      stopped = true;
    };
  });


  async function loadLog(job, full = false) {
    const id = job.id;
    logLoadingId = id;
    try {
      const result = await fetchActionLog(repo, number, id, full);
      if (selectedJobId !== id && !full) return;
      logs = { ...logs, [id]: result };
      const nextErrors = { ...logErrors };
      delete nextErrors[id];
      logErrors = nextErrors;
    } catch (error) {
      logErrors = { ...logErrors, [id]: error instanceof Error ? error.message : String(error) };
    } finally {
      if (logLoadingId === id) logLoadingId = null;
    }
  }

  $effect(() => {
    const job = selectedJob;
    if (!job || job.status !== "completed" || logs[job.id] || logErrors[job.id]) return;
    void loadLog(job);
  });

  function selectJob(job) {
    selectedJobId = job.id;
    overviewMode = false;
  }

  function retryLog() {
    if (!selectedJob) return;
    const nextErrors = { ...logErrors };
    delete nextErrors[selectedJob.id];
    logErrors = nextErrors;
    void loadLog(selectedJob);
  }
</script>

{#snippet statusIcon(status, conclusion)}
  {@const tone = stateTone(status, conclusion)}
  <span class="status-icon {tone}" aria-hidden="true">
    {#if tone === "ready"}
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"></circle><path d="m4.6 8.1 2.2 2.2 4.7-4.8"></path></svg>
    {:else if tone === "fail"}
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"></circle><path d="m5.4 5.4 5.2 5.2m0-5.2-5.2 5.2"></path></svg>
    {:else if tone === "wait"}
      <svg class="status-spinner" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"></circle></svg>
    {:else}
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"></circle><path d="M5.5 8h5"></path></svg>
    {/if}
  </span>
{/snippet}

<div class="actions-viewbar">
  <div class="view-picker" aria-label="Actions view">
    <button class:active={overviewMode} onclick={() => overviewMode = true}>Overview</button>
    <button class:active={!overviewMode} disabled={!selectedJob} onclick={() => overviewMode = false}>Job log</button>
  </div>
  {#if loadError || graphError}
    <button class="link refresh-link" onclick={() => refreshNonce++}>Retry data load</button>
  {/if}
</div>

<div class="overview-panel" class:hidden={!overviewMode}>
  {#if (loading && !snapshot) || (!graphSnapshot && !graphError)}
    <div class="overview-state">Loading workflow overview…</div>
  {:else if graphError && !graphSnapshot}
    <div class="overview-state error">
      <span>Couldn’t load workflow definitions.</span>
      <button class="link" onclick={() => refreshNonce++}>Retry</button>
    </div>
  {:else if (graphSnapshot?.workflows ?? []).length === 0}
    <div class="overview-state">No workflow definitions found for this head.</div>
  {:else}
    <ActionsGraph
      workflows={graphSnapshot.workflows}
      {groups}
      {statusIcon}
      onselect={selectJob}
    />
  {/if}
</div>
{#if !overviewMode}
  <div class="actions-layout">
    <aside class="workflow-list" aria-label="Workflow runs">
      {#if loading && !snapshot}
        <div class="empty">Loading workflow runs…</div>
      {:else if loadError && !snapshot}
        <div class="empty error">
          <span>Couldn’t load workflow runs.</span>
          <button class="link" onclick={() => refreshNonce++}>Retry</button>
        </div>
      {:else if groups.length === 0}
        <div class="empty">No workflow runs for this head</div>
      {:else}
        {#each groups as group (`${group.run.id}:${group.run.attempt}`)}
          <section class="workflow-group">
            <header class="workflow-head">
              {@render statusIcon(group.run.status, group.run.conclusion)}
              <span class="workflow-name">{group.run.workflowName || "Workflow"}</span>
              {#if group.run.attempt > 1}<span class="attempt">attempt {group.run.attempt}</span>{/if}
              {#if group.run.eventAt}<span class="run-time">{relativeTime(group.run.eventAt)}</span>{/if}
            </header>
            <div class="jobs">
              {#each group.jobs as job (job.id)}
                <button class="job-row" class:active={selectedJobId === job.id} onclick={() => selectJob(job)}>
                  {@render statusIcon(job.status, job.conclusion)}
                  <span class="job-copy">
                    <span class="job-name">{job.name}</span>
                    <span class="job-meta">
                      {stateLabel(job.conclusion ?? job.status)} · {jobTime(job)}
                      {#if runnerLabel(job)} · {runnerLabel(job)}{/if}
                    </span>
                    {#if job.failedStep}<span class="failed-step">Failed at {job.failedStep}</span>{/if}
                  </span>
                </button>
              {:else}
                <div class="jobs-empty">Waiting for jobs…</div>
              {/each}
            </div>
          </section>
        {/each}
      {/if}
    </aside>

    <section class="log-pane" aria-live="polite">
      {#if !selectedJob}
        <div class="empty">Select a job</div>
      {:else}
        <header class="log-head">
          <div class="log-title-row">
            {@render statusIcon(selectedJob.status, selectedJob.conclusion)}
            <h2>{selectedJob.name}</h2>
            <span class="status-label {stateTone(selectedJob.status, selectedJob.conclusion)}">{stateLabel(selectedJob.conclusion ?? selectedJob.status)}</span>
          </div>
          <div class="log-meta">
            <span>{selectedJob.workflowName}</span>
            <span>{jobTime(selectedJob)}</span>
            {#if runnerLabel(selectedJob)}<span>{runnerLabel(selectedJob)}</span>{/if}
          </div>
        </header>

        {#if selectedJob.status !== "completed"}
          <div class="empty log-empty">The log will appear when this job completes.</div>
        {:else if logLoadingId === selectedJob.id && !selectedLog}
          <div class="empty log-empty">Loading log…</div>
        {:else if selectedLogError}
          <div class="empty error log-empty">
            <span>Couldn’t load this log.</span>
            <button class="link" onclick={retryLog}>Retry</button>
          </div>
        {:else if selectedLog?.state === "not-produced"}
          <div class="empty log-empty">GitHub skipped this job, so it produced no log.</div>
        {:else if selectedLog}
          <pre class="action-log mono">{selectedLog.body || "This job produced no log output."}</pre>
          {#if selectedLog.truncated}
            <div class="log-footer">
              <span>Showing the last 256 KB</span>
              <button class="link" disabled={logLoadingId === selectedJob.id} onclick={() => loadLog(selectedJob, true)}>
                {logLoadingId === selectedJob.id ? "Loading…" : "Show full log"}
              </button>
            </div>
          {/if}
        {:else}
          <div class="empty log-empty">No log is available for this job.</div>
        {/if}
      {/if}
    </section>
  </div>
{/if}

<style>
  .overview-panel.hidden {
    display: none;
  }
  .actions-viewbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .view-picker {
    display: flex;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--panel);
  }
  .view-picker button {
    padding: 6px 11px;
    border: 0;
    color: var(--text-faint);
    background: transparent;
    font: 500 11px var(--sans);
    cursor: pointer;
  }
  .view-picker button + button {
    border-left: 1px solid var(--border);
  }
  .view-picker button.active {
    color: var(--text);
    background: var(--panel-raised);
  }
  .view-picker button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .refresh-link {
    color: var(--fail);
  }
  .overview-state {
    display: flex;
    min-height: 420px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-faint);
    background: var(--panel);
    font-size: 12px;
  }
  .actions-layout {
    display: grid;
    grid-template-columns: minmax(300px, 34%) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  .workflow-list {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 10px;
  }
  .workflow-group,
  .log-pane {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: var(--shadow-xs);
  }
  .workflow-group {
    overflow: hidden;
  }
  .workflow-head {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 8px;
    padding: 9px 11px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    font-size: 11px;
  }
  .workflow-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attempt,
  .run-time,
  .job-meta,
  .log-meta,
  .log-footer,
  .jobs-empty {
    color: var(--text-faint);
    font-size: 11px;
  }
  .attempt,
  .run-time {
    flex: none;
  }
  .run-time {
    margin-left: auto;
  }
  .jobs {
    padding: 5px;
  }
  .job-row {
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 7px;
    width: 100%;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: 7px;
    color: inherit;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .job-row:hover {
    background: var(--surface-hover);
  }
  .job-row.active {
    border-color: var(--border);
    background: var(--panel-raised);
    box-shadow: var(--shadow-xs);
  }
  .job-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .job-name {
    overflow: hidden;
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-meta,
  .failed-step {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .failed-step {
    color: var(--fail);
    font-size: 11px;
  }
  .status-icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    flex: none;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }
  .workflow-head .status-icon,
  .log-title-row .status-icon {
    margin-top: 0;
  }
  .status-icon.ready {
    color: var(--ready);
  }
  .status-icon.fail {
    color: var(--fail);
  }
  .status-icon.wait {
    color: var(--review);
  }
  .status-icon svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }
  .status-icon.ready circle,
  .status-icon.fail circle {
    fill: currentColor;
    stroke: none;
  }
  .status-icon.ready path,
  .status-icon.fail path {
    stroke: var(--native-on-accent);
    stroke-width: 1.5;
  }
  .status-spinner circle {
    stroke-dasharray: 24 14;
    transform-origin: center;
    animation: status-spin 0.9s linear infinite;
  }
  @keyframes status-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-spinner circle {
      animation: none;
    }
  }
  .log-pane {
    min-width: 0;
    position: sticky;
    top: 10px;
    overflow: hidden;
  }
  .log-head {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .log-title-row {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .log-title-row h2 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-label {
    flex: none;
    margin-left: auto;
    padding: 2px 7px;
    border-radius: 999px;
    color: var(--text-dim);
    background: var(--panel-raised);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-label.ready {
    color: var(--ready);
  }
  .status-label.fail {
    color: var(--fail);
  }
  .status-label.wait {
    color: var(--review);
  }
  .log-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px 12px;
    margin-top: 6px;
  }
  .action-log {
    box-sizing: border-box;
    width: 100%;
    min-height: 380px;
    max-height: calc(100vh - 330px);
    margin: 0;
    padding: 14px 16px;
    overflow: auto;
    border: 0;
    color: var(--text-dim);
    background: var(--panel);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .empty {
    display: flex;
    min-height: 72px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-faint);
    font-size: 12px;
    text-align: center;
  }
  .log-empty {
    min-height: 380px;
  }
  .error {
    color: var(--fail);
  }
  .jobs-empty {
    padding: 8px;
  }
  .link {
    padding: 0;
    border: 0;
    color: var(--text-dim);
    background: none;
    font-family: var(--sans);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover:not(:disabled) {
    color: var(--text);
  }
  .link:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 860px) {
    .actions-layout {
      grid-template-columns: 1fr;
    }
    .log-pane {
      position: static;
    }
    .action-log,
    .log-empty {
      min-height: 300px;
    }
  }
</style>
