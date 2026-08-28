<script>
  import ActionLog from "./ActionLog.svelte";
  import ActionStatusIcon from "./ActionStatusIcon.svelte";
  import { fetchRepoActionLog, fetchRepoActions } from "./api.js";
  import { durationText, relativeTime } from "./time.js";

  let { repo = "", workflow = "", status = "all" } = $props();

  let snapshot = $state(null);
  let loading = $state(true);
  let error = $state("");
  let selectedRun = $state(null);
  let jobs = $state([]);
  let jobsLoading = $state(false);
  let jobsError = $state("");
  let selectedJob = $state(null);
  let selectedLog = $state(null);
  let logLoading = $state(false);
  let logError = $state("");

  const statusOptions = [
    ["all", "All statuses"],
    ["running", "Running"],
    ["succeeded", "Succeeded"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ];

  function updateFilters(next) {
    const params = new URLSearchParams();
    const values = { repo, workflow, status, ...next };
    if (values.repo) params.set("repo", values.repo);
    if (values.workflow) params.set("workflow", values.workflow);
    if (values.status && values.status !== "all") params.set("status", values.status);
    const query = params.toString();
    location.hash = `#/actions${query ? `?${query}` : ""}`;
  }

  function runDuration(run) {
    if (run.runStartedAt && run.updatedAt) return durationText(run.runStartedAt, run.updatedAt);
    return null;
  }

  function jobDuration(job) {
    if (job.startedAt && job.completedAt) return durationText(job.startedAt, job.completedAt);
    if (job.startedAt) return `started ${relativeTime(job.startedAt)}`;
    return "waiting";
  }

  function stateLabel(value) {
    return (value || "queued").replaceAll("_", " ");
  }

  async function selectRun(run) {
    if (selectedRun?.repo === run.repo && selectedRun?.id === run.id) {
      selectedRun = null;
      jobs = [];
      selectedJob = null;
      selectedLog = null;
      return;
    }
    selectedRun = run;
    jobs = [];
    selectedJob = null;
    selectedLog = null;
    jobsLoading = true;
    jobsError = "";
    try {
      const detail = await fetchRepoActions({ repo: run.repo, runId: run.id });
      if (selectedRun?.repo !== run.repo || selectedRun?.id !== run.id) return;
      jobs = detail.jobs;
    } catch (nextError) {
      jobsError = nextError instanceof Error ? nextError.message : String(nextError);
    } finally {
      jobsLoading = false;
    }
  }

  async function selectJob(job) {
    selectedJob = job;
    selectedLog = null;
    logLoading = true;
    logError = "";
    try {
      const result = await fetchRepoActionLog(selectedRun.repo, selectedRun.headSha, job.id);
      if (selectedJob?.id !== job.id) return;
      selectedLog = result;
    } catch (nextError) {
      logError = nextError instanceof Error ? nextError.message : String(nextError);
    } finally {
      logLoading = false;
    }
  }

  $effect(() => {
    const filters = { repo, workflow, status };
    const controller = new AbortController();
    let stopped = false;

    async function refresh(initial) {
      if (initial) loading = true;
      try {
        const next = await fetchRepoActions(filters, controller.signal);
        if (stopped) return;
        snapshot = next;
        error = "";
      } catch (nextError) {
        if (!stopped) error = nextError instanceof Error ? nextError.message : String(nextError);
      } finally {
        if (!stopped) loading = false;
      }
    }

    void refresh(true);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, 15_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  });
</script>

{#snippet statusIcon(runStatus, conclusion)}
  <ActionStatusIcon status={runStatus} {conclusion} />
{/snippet}

<div class="page">
  <header class="page-head">
    <div>
      <span class="ui-eyebrow">Automation</span>
      <h1>Actions</h1>
    </div>
    <div class="filters" aria-label="Workflow run filters">
      {#if (snapshot?.repos?.length ?? 0) > 1}
        <label>
          <span>Repository</span>
          <select aria-label="Repository" value={repo} onchange={(event) => updateFilters({ repo: event.currentTarget.value, workflow: "" })}>
            <option value="">All repositories</option>
            {#each snapshot.repos as option}
              <option value={option}>{option}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label>
        <span>Workflow</span>
        <select aria-label="Workflow" value={workflow} onchange={(event) => updateFilters({ workflow: event.currentTarget.value })}>
          <option value="">All workflows</option>
          {#each snapshot?.workflows ?? [] as option}
            <option value={option}>{option}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Status</span>
        <select aria-label="Status" value={status} onchange={(event) => updateFilters({ status: event.currentTarget.value })}>
          {#each statusOptions as option}
            <option value={option[0]}>{option[1]}</option>
          {/each}
        </select>
      </label>
    </div>
  </header>

  {#if workflow && snapshot?.latestSuccessful}
    {@const success = snapshot.latestSuccessful}
    <section class="release-summary" aria-label="Latest successful workflow run">
      <ActionStatusIcon status={success.status} conclusion={success.conclusion} />
      <div class="summary-copy">
        <span class="summary-label">Latest successful {workflow}</span>
        <strong>{success.displayTitle}</strong>
        <span>
          {success.runNumber ? `Run #${success.runNumber}` : "Successful run"}
          · {success.headBranch || success.headSha.slice(0, 7)}
          · {relativeTime(success.eventAt)}
        </span>
      </div>
      {#if success.htmlUrl}<a class="external-link" href={success.htmlUrl}>Open on GitHub</a>{/if}
    </section>
  {:else if workflow && !loading}
    <section class="release-summary empty-summary">No successful {workflow} run is cached in the last 30 days.</section>
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
        <article class="run" class:expanded={selectedRun?.repo === run.repo && selectedRun?.id === run.id}>
          <button class="run-row" onclick={() => selectRun(run)} aria-expanded={selectedRun?.repo === run.repo && selectedRun?.id === run.id}>
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
          </button>

          {#if selectedRun?.repo === run.repo && selectedRun?.id === run.id}
            <div class="run-detail">
              <div class="run-links">
                {#if run.prNumber}<a href={`#/pr/${run.repo}/${run.prNumber}`}>Open PR #{run.prNumber}</a>{/if}
                {#if run.htmlUrl}<a href={run.htmlUrl}>Open run on GitHub</a>{/if}
                <span>{run.headSha.slice(0, 7)}</span>
              </div>
              {#if jobsLoading}
                <div class="jobs-state">Loading jobs…</div>
              {:else if jobsError}
                <div class="jobs-state error">Couldn’t load jobs: {jobsError}</div>
              {:else if jobs.length === 0}
                <div class="jobs-state">No jobs found for this run.</div>
              {:else}
                <div class="jobs-layout">
                  <div class="job-list">
                    {#each jobs as job (job.id)}
                      <button class="job" class:active={selectedJob?.id === job.id} onclick={() => selectJob(job)}>
                        <ActionStatusIcon status={job.status} conclusion={job.conclusion} />
                        <span><strong>{job.name}</strong><small>{stateLabel(job.conclusion ?? job.status)} · {jobDuration(job)}</small></span>
                      </button>
                    {/each}
                  </div>
                  {#if selectedJob}
                    <div class="log-pane">
                      <header><strong>{selectedJob.name}</strong><span>{stateLabel(selectedJob.conclusion ?? selectedJob.status)}</span></header>
                      {#if logLoading}
                        <div class="jobs-state">Loading log…</div>
                      {:else if logError}
                        <div class="jobs-state error">Couldn’t load log: {logError}</div>
                      {:else if selectedLog?.state === "not-produced"}
                        <div class="jobs-state">This job produced no log.</div>
                      {:else if selectedLog?.body}
                        <ActionLog body={selectedLog.body} jobConclusion={selectedJob.conclusion} failedStep={selectedJob.failedStep} {statusIcon} />
                      {:else}
                        <div class="jobs-state">The log is not available yet.</div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    {/if}
  </section>
</div>

<style>
  .page { padding: 18px 32px 96px; min-width: 0; }
  .page-head { display: flex; min-height: 58px; margin-bottom: 20px; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--border); }
  .page-head > div:first-child { display: flex; flex-direction: column; gap: 2px; }
  .ui-eyebrow { color: var(--text-faint); font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
  h1 { margin: 0; color: var(--text); font-size: 18px; font-weight: 650; }
  .filters { display: flex; align-items: center; gap: 8px; }
  .filters label { display: flex; align-items: center; gap: 6px; color: var(--text-faint); font-size: 11px; }
  select { min-width: 132px; height: 30px; padding: 0 28px 0 9px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: 500 12px var(--sans); }
  .release-summary { display: flex; min-height: 72px; margin-bottom: 16px; padding: 14px 16px; align-items: center; gap: 12px; border: 1px solid color-mix(in srgb, var(--ready) 36%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--ready) 7%, var(--panel)); }
  .summary-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
  .summary-copy strong { overflow: hidden; color: var(--text); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .summary-copy span { color: var(--text-faint); font-size: 11px; }
  .summary-label { color: var(--ready) !important; font-weight: 650; text-transform: uppercase; letter-spacing: .03em; }
  .external-link, .run-links a { color: var(--accent); font-size: 12px; text-decoration: none; }
  .empty-summary { color: var(--text-faint); font-size: 12px; }
  .runs-panel { overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
  .state, .jobs-state { padding: 28px; color: var(--text-faint); font-size: 12px; text-align: center; }
  .error { color: var(--fail); }
  .run + .run { border-top: 1px solid var(--border); }
  .run.expanded { background: color-mix(in srgb, var(--panel) 88%, var(--accent)); }
  .run-row { display: grid; width: 100%; min-height: 72px; padding: 13px 16px; grid-template-columns: 18px minmax(260px, 1fr) minmax(130px, auto) 105px; align-items: start; gap: 10px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
  .run-row:hover { background: var(--hover); }
  .run-copy { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
  .run-copy > strong { overflow: hidden; color: var(--text); font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta { overflow: hidden; color: var(--text-faint); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta b { color: var(--text-muted); font-weight: 600; }
  .run-context, .run-time { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; color: var(--text-faint); font-size: 11px; }
  .branch { max-width: 220px; overflow: hidden; padding: 2px 6px; border-radius: 4px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font-family: var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .run-detail { padding: 0 16px 16px 44px; }
  .run-links { display: flex; margin-bottom: 10px; gap: 14px; color: var(--text-faint); font: 11px var(--mono); }
  .jobs-layout { display: grid; min-height: 220px; grid-template-columns: 260px minmax(0, 1fr); border: 1px solid var(--border); border-radius: 7px; background: var(--bg); }
  .job-list { border-right: 1px solid var(--border); }
  .job { display: flex; width: 100%; padding: 10px 12px; align-items: flex-start; gap: 8px; border: 0; border-bottom: 1px solid var(--border); color: inherit; background: transparent; text-align: left; cursor: pointer; }
  .job:hover, .job.active { background: var(--hover); }
  .job > span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  .job strong { overflow: hidden; color: var(--text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .job small { color: var(--text-faint); font-size: 10px; }
  .log-pane { min-width: 0; overflow: hidden; }
  .log-pane > header { display: flex; height: 38px; padding: 0 12px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); color: var(--text); font-size: 11px; }
  .log-pane > header span { color: var(--text-faint); text-transform: capitalize; }
  @media (max-width: 900px) {
    .page-head { align-items: flex-start; flex-direction: column; padding-bottom: 12px; }
    .filters { width: 100%; flex-wrap: wrap; }
    .run-row { grid-template-columns: 18px minmax(0, 1fr) 90px; }
    .run-context { display: none; }
    .jobs-layout { grid-template-columns: 1fr; }
    .job-list { border-right: 0; border-bottom: 1px solid var(--border); }
  }
</style>
