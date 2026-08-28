<script>
  import ActionStatusIcon from "./ActionStatusIcon.svelte";
  import ActionsView from "./ActionsView.svelte";
  import { prefetchRepoRun, rememberedActionRun, rememberActionRun } from "./actionPrefetch.js";
  import { fetchRepoActions } from "./api.js";

  let { repo, runId } = $props();

  let run = $state(null);
  let loading = $state(true);
  let error = $state("");

  function runHref(nextRun) {
    return `#/actions/run/${nextRun.repo}/${nextRun.id}`;
  }

  $effect(() => {
    const key = `${repo}:${runId}`;
    const controller = new AbortController();
    const remembered = rememberedActionRun(repo, runId);
    loading = !remembered;
    run = remembered;
    if (remembered) prefetchRepoRun(remembered);
    void fetchRepoActions({ repo: [repo], runId }, controller.signal).then(
      (snapshot) => {
        if (key !== `${repo}:${runId}`) return;
        run = snapshot.selectedRun;
        if (run) {
          rememberActionRun(run);
          prefetchRepoRun(run);
        }
        error = run ? "" : "Workflow run not found";
      },
      (nextError) => {
        if (!controller.signal.aborted) error = nextError instanceof Error ? nextError.message : String(nextError);
      },
    ).finally(() => {
      if (!controller.signal.aborted) loading = false;
    });
    return () => controller.abort();
  });
</script>

<div class="page">
  <a class="back-link" href="#/actions">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5"></path></svg>
    Back to Actions
  </a>

  {#if loading}
    <div class="state">Loading workflow run…</div>
  {:else if error || !run}
    <div class="state error">Couldn’t load workflow run: {error}</div>
  {:else}
    <header class="run-header">
      <ActionStatusIcon status={run.status} conclusion={run.conclusion} />
      <div class="run-heading">
        <span class="ui-eyebrow">{run.workflowName}{run.runNumber ? ` · #${run.runNumber}` : ""}</span>
        <h1>{run.displayTitle}</h1>
        <div class="run-meta">
          {#if run.event}<span>{run.event.replaceAll("_", " ")}</span>{/if}
          {#if run.actorLogin}<span>{run.actorLogin}</span>{/if}
          {#if run.headBranch}<span class="branch">{run.headBranch}</span>{/if}
          <span class="sha">{run.headSha.slice(0, 7)}</span>
        </div>
      </div>
      <div class="run-links">
        {#if run.prNumber}<a href={`#/pr/${run.repo}/${run.prNumber}`}>Open PR #{run.prNumber}</a>{/if}
        {#if run.htmlUrl}<a href={run.htmlUrl}>Open run on GitHub</a>{/if}
      </div>
    </header>

    <ActionsView
      repo={run.repo}
      headSha={run.headSha}
      preferredRunId={run.id}
      active={true}
      startInOverview={false}
      fullHeight={true}
      onSelectRun={(nextRun) => {
        if (nextRun.id !== run.id) location.hash = runHref(nextRun);
      }}
    />
  {/if}
</div>

<style>
  .page { min-width: 0; height: 100%; overflow-y: auto; padding: 18px 32px 44px; }
  .back-link { display: inline-flex; height: 32px; align-items: center; gap: 5px; color: var(--text-faint); font-size: 11px; text-decoration: none; }
  .back-link:hover { color: var(--text); }
  .back-link svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
  .run-header { display: grid; min-height: 94px; margin-bottom: 18px; padding: 16px 0; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: start; gap: 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .run-heading { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
  .ui-eyebrow { color: var(--text-faint); font-size: 11px; font-weight: 600; letter-spacing: .02em; }
  h1 { margin: 0; overflow: hidden; color: var(--text); font-size: 19px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta, .run-links { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; color: var(--text-faint); font-size: 11px; }
  .run-meta span + span::before { margin-right: 12px; color: var(--border-strong); content: "·"; }
  .branch, .sha { font-family: var(--mono); }
  .branch { color: var(--accent); }
  .run-links { justify-content: flex-end; }
  .run-links a { color: var(--accent); font-size: 12px; text-decoration: none; }
  .state { display: grid; min-height: 320px; place-items: center; color: var(--text-faint); font-size: 12px; }
  .state.error { color: var(--fail); }
  @media (max-width: 800px) {
    .run-header { grid-template-columns: 18px minmax(0, 1fr); }
    .run-links { grid-column: 2; justify-content: flex-start; }
  }
</style>
