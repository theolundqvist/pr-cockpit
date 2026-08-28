<script>
  import ActionsGraph from "./ActionsGraph.svelte";
  import ActionLog from "./ActionLog.svelte";
  import ActionStatusIcon from "./ActionStatusIcon.svelte";
  import {
    actionLogKey,
    cachedActionLog,
    chooseDefaultActionJob,
    loadActionLog,
    loadRepoRunSnapshot,
    prefetchActionLogs,
  } from "./actionPrefetch.js";
  import { fetchActionCommits, fetchActionGraph, fetchActionLog, fetchActions, fetchRepoActionGraph, fetchRepoActionLog } from "./api.js";
  import { durationText, relativeTime } from "./time.js";

  let {
    repo,
    number = null,
    headSha,
    selectedSha = null,
    requestedJobId = null,
    preferredRunId = null,
    active = false,
    startInOverview = true,
    fullHeight = false,
    onSelectRun = null,
    runUrl = $bindable(null),
  } = $props();

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
  let commits = $state([]);
  let commitError = $state("");
  let commitLoading = $state(true);
  let commitNonce = $state(0);

  let activeSha = $derived(selectedSha ?? headSha);
  let commitOptions = $derived.by(() => {
    const options = [...commits].reverse();
    if (!options.some((commit) => commit.sha === activeSha)) {
      options.unshift({ sha: activeSha, headline: activeSha === headSha ? "Current head" : "Selected commit" });
    }
    return options;
  });

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
  let selectedRunUrl = $derived.by(() => {
    if (!selectedJob) return null;
    const run = (snapshot?.runs ?? []).find((candidate) =>
      candidate.id === selectedJob.runId && candidate.attempt === selectedJob.attempt
    );
    return run?.htmlUrl ?? selectedJob.htmlUrl?.replace(/\/job\/\d+\/?$/, "") ?? null;
  });
  $effect(() => {
    runUrl = selectedRunUrl;
  });
  let selectedLogError = $derived(selectedJobId === null ? "" : logErrors[selectedJobId] ?? "");
  let hasActiveJobs = $derived((snapshot?.jobs ?? []).some((job) => job.status !== "completed"));

  function chooseDefaultJob(jobs) {
    return chooseDefaultActionJob(jobs);
  }

  $effect(() => {
    if (!active || number === null) {
      commitLoading = false;
      return;
    }
    const key = `${repo}#${number}:${headSha}:${commitNonce}`;
    let stopped = false;
    const controller = new AbortController();
    commitLoading = true;
    fetchActionCommits(repo, number, controller.signal).then(
      (next) => {
        if (stopped || key !== `${repo}#${number}:${headSha}:${commitNonce}`) return;
        commits = next.commits;
        commitError = "";
      },
      (error) => {
        if (!stopped) commitError = error instanceof Error ? error.message : String(error);
      },
    ).finally(() => {
      if (!stopped) commitLoading = false;
    });
    return () => {
      stopped = true;
      controller.abort();
    };
  });

  $effect(() => {
    activeSha;
    requestedJobId;
    preferredRunId;
    snapshot = null;
    graphSnapshot = null;
    selectedJobId = requestedJobId;
    overviewMode = requestedJobId === null && startInOverview;
    logs = {};
    logErrors = {};
    loading = true;
  });

  $effect(() => {
    if (!active) return;
    const key = `${repo}#${number}:${activeSha}:${refreshNonce}`;
    let stopped = false;
    const controller = new AbortController();

    async function refresh(initial) {
      if (initial) loading = true;
      try {
        const next = number === null
          ? await loadRepoRunSnapshot({ repo, headSha: activeSha, id: preferredRunId }, false)
          : await fetchActions(repo, number, activeSha, controller.signal);
        if (stopped || key !== `${repo}#${number}:${activeSha}:${refreshNonce}`) return;
        snapshot = next;
        loadError = "";
        const preferredJobs = preferredRunId === null
          ? next.jobs
          : next.jobs.filter((job) => job.runId === preferredRunId);
        const defaultJob = chooseDefaultJob(preferredJobs) ?? chooseDefaultJob(next.jobs);
        if (!next.jobs.some((job) => job.id === selectedJobId)) selectedJobId = defaultJob?.id ?? null;
        const targetJob = next.jobs.find((job) => job.id === selectedJobId) ?? defaultJob;
        const targetJobs = targetJob ? next.jobs.filter((job) => job.runId === targetJob.runId) : [];
        const cached = {};
        for (const job of targetJobs) {
          const result = cachedActionLog(actionLogKey(repo, activeSha, job.id));
          if (result) cached[job.id] = result;
        }
        if (Object.keys(cached).length > 0) logs = { ...logs, ...cached };
        void prefetchActionLogs(
          targetJobs,
          (job) => actionLogKey(repo, activeSha, job.id),
          (job) => number === null
            ? fetchRepoActionLog(repo, activeSha, job.id, null, true)
            : fetchActionLog(repo, number, job.id, activeSha, null, true),
          () => !stopped,
        ).then(() => {
          if (stopped) return;
          const prefetched = {};
          for (const job of targetJobs) {
            const result = cachedActionLog(actionLogKey(repo, activeSha, job.id));
            if (result) prefetched[job.id] = result;
          }
          if (Object.keys(prefetched).length > 0) logs = { ...logs, ...prefetched };
        });
      } catch (error) {
        if (!stopped) loadError = error instanceof Error ? error.message : String(error);
      } finally {
        if (!stopped) loading = false;
      }
    }

    void refresh(true);
    const activeTimer = setInterval(() => {
      if (hasActiveJobs) void refresh(false);
    }, 5_000);
    const leaseTimer = setInterval(() => {
      if (!hasActiveJobs) void refresh(false);
    }, 60_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(activeTimer);
      clearInterval(leaseTimer);
    };
  });
  $effect(() => {
    if (!active) return;
    const key = `${repo}#${number}:${activeSha}:${refreshNonce}`;
    let stopped = false;
    const controller = new AbortController();
    const request = number === null
      ? fetchRepoActionGraph(repo, activeSha, controller.signal)
      : fetchActionGraph(repo, number, activeSha, controller.signal);
    request.then(
      (next) => {
        if (stopped || key !== `${repo}#${number}:${activeSha}:${refreshNonce}`) return;
        graphSnapshot = next;
        graphError = "";
      },
      (error) => {
        if (!stopped) graphError = error instanceof Error ? error.message : String(error);
      },
    );
    return () => {
      stopped = true;
      controller.abort();
    };
  });


  async function loadLogId(id, background = false) {
    const capturedRepo = repo;
    const capturedSha = activeSha;
    if (!background) logLoadingId = id;
    try {
      let result = await loadActionLog(
        actionLogKey(capturedRepo, capturedSha, id),
        () => number === null
          ? fetchRepoActionLog(capturedRepo, capturedSha, id, null, background)
          : fetchActionLog(capturedRepo, number, id, capturedSha, null, background),
      );
      if (!background && result?.state === "deferred") {
        result = await loadActionLog(
          actionLogKey(capturedRepo, capturedSha, id),
          () => number === null
            ? fetchRepoActionLog(capturedRepo, capturedSha, id)
            : fetchActionLog(capturedRepo, number, id, capturedSha),
        );
      }
      if (`${capturedRepo}:${capturedSha}` !== `${repo}:${activeSha}`) return;
      if (result?.state === "ready" || result?.state === "not-produced") {
        logs = { ...logs, [id]: result };
      }
      const nextErrors = { ...logErrors };
      delete nextErrors[id];
      logErrors = nextErrors;
    } catch (error) {
      if (!background) logErrors = { ...logErrors, [id]: error instanceof Error ? error.message : String(error) };
    } finally {
      if (!background && logLoadingId === id) logLoadingId = null;
    }
  }

  $effect(() => {
    if (!active || requestedJobId === null) return;
    activeSha;
    void loadLogId(requestedJobId, true);
  });

  $effect(() => {
    if (!active) return;
    const job = selectedJob;
    if (!job || job.status !== "completed" || logs[job.id] || logErrors[job.id]) return;
    void loadLogId(job.id);
  });

  function selectJob(job) {
    selectedJobId = job.id;
    overviewMode = false;
  }
  function selectCommit(event) {
    if (number === null) return;
    const sha = event.currentTarget.value;
    location.hash = `#/pr/${repo}/${number}/actions?sha=${sha}`;
  }


  function retryLog() {
    if (!selectedJob) return;
    const nextErrors = { ...logErrors };
    delete nextErrors[selectedJob.id];
    logErrors = nextErrors;
    void loadLogId(selectedJob.id);
  }
</script>

{#snippet statusIcon(status, conclusion)}
  <ActionStatusIcon {status} {conclusion} />
{/snippet}

{#snippet workflowHeading(group)}
  {@render statusIcon(group.run.status, group.run.conclusion)}
  <span class="workflow-name">{group.run.workflowName || "Workflow"}</span>
  {#if group.run.attempt > 1}<span class="attempt">attempt {group.run.attempt}</span>{/if}
  {#if group.run.eventAt}<span class="run-time">{relativeTime(group.run.eventAt)}</span>{/if}
{/snippet}

<div class="actions-viewbar">
  <div class="view-picker" aria-label="Actions view">
    <button class:active={overviewMode} onclick={() => overviewMode = true}>Overview</button>
    <button class:active={!overviewMode} disabled={!selectedJob} onclick={() => overviewMode = false}>Job log</button>
  </div>
  <div class="actions-view-controls">
    {#if number !== null}
      <label class="commit-picker">
        <span>Commit</span>
        <select
          aria-label="Workflow commit"
          value={activeSha}
          disabled={commitLoading && commits.length === 0}
          onchange={selectCommit}
        >
          {#each commitOptions as commit (commit.sha)}
            <option value={commit.sha}>{commit.sha.slice(0, 7)} · {commit.headline}</option>
          {/each}
        </select>
      </label>
      {#if commitError}
        <button class="link refresh-link" onclick={() => commitNonce++}>Retry commits</button>
      {/if}
    {/if}
    {#if loadError || graphError}
      <button class="link refresh-link" onclick={() => refreshNonce++}>Retry data load</button>
    {/if}
  </div>
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
  <div class="actions-layout" class:full-height={fullHeight}>
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
            {#if onSelectRun}
              <button class="workflow-head run-switch" type="button" class:current={group.run.id === preferredRunId} onclick={() => onSelectRun(group.run)}>
                {@render workflowHeading(group)}
              </button>
            {:else}
              <header class="workflow-head">
                {@render workflowHeading(group)}
              </header>
            {/if}
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
        {:else if selectedLog?.body}
          <ActionLog body={selectedLog.body} jobConclusion={selectedJob.conclusion} failedStep={selectedJob.failedStep} {statusIcon} />
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
  .actions-view-controls,
  .commit-picker {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .actions-view-controls {
    min-width: 0;
    justify-content: flex-end;
  }
  .commit-picker {
    min-width: 0;
    color: var(--text-faint);
    font-size: 11px;
  }
  .commit-picker select {
    width: min(420px, 42vw);
    height: 29px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    background: var(--panel);
    font: 11px var(--mono);
  }
  .commit-picker select:disabled {
    color: var(--text-faint);
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
  .actions-layout.full-height {
    min-height: calc(100vh - 245px);
    align-items: stretch;
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
  .run-switch {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .run-switch:hover {
    background: var(--surface-hover);
  }
  .run-switch.current {
    box-shadow: inset 3px 0 var(--accent);
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
  .workflow-head :global(.status-icon),
  .log-title-row :global(.status-icon) {
    margin-top: 0;
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
