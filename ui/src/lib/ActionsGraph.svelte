<script>
  import { durationText } from "./time.js";

  let { workflows, groups, statusIcon, onselect } = $props();
  let selectedPath = $state("");
  let mode = $state("workflow");
  $effect(() => {
    if (workflows.some((workflow) => workflow.path === selectedPath)) return;
    selectedPath = workflows.find((workflow) => !workflow.error)?.path ?? workflows[0]?.path ?? "";
  });


  let selectedWorkflow = $derived(
    workflows.find((workflow) => workflow.path === selectedPath)
      ?? workflows.find((workflow) => !workflow.error)
      ?? workflows[0]
      ?? null,
  );

  let runGroup = $derived.by(() => {
    if (!selectedWorkflow) return null;
    return groups.find((group) => group.run.workflowPath === selectedWorkflow.path)
      ?? groups.find((group) => group.run.workflowName === selectedWorkflow.name)
      ?? null;
  });

  function normalizedName(value) {
    return value.toLowerCase().replaceAll("-", " ").replaceAll("_", " ").replace(/\s+/g, " ").trim();
  }

  function matchingJobs(definition) {
    const names = [definition.name, definition.id].map(normalizedName);
    return (runGroup?.jobs ?? []).filter((job) => {
      const actual = normalizedName(job.name);
      return names.some((name) => actual === name || actual.startsWith(`${name} (`) || actual.startsWith(`${name} /`));
    });
  }

  function stateFor(definition) {
    const jobs = matchingJobs(definition);
    if (jobs.some((job) => ["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(job.conclusion))) {
      return { status: "completed", conclusion: "failure", jobs };
    }
    if (jobs.some((job) => job.status === "in_progress")) return { status: "in_progress", conclusion: null, jobs };
    if (jobs.some((job) => job.status !== "completed")) return { status: "queued", conclusion: null, jobs };
    if (jobs.length > 0 && jobs.every((job) => job.conclusion === "success")) {
      return { status: "completed", conclusion: "success", jobs };
    }
    if (jobs.length > 0) return { status: "completed", conclusion: jobs[0].conclusion, jobs };
    return { status: "queued", conclusion: null, jobs };
  }
  function nodeMeta(definition, state) {
    if (state.jobs.length > 1) return `${state.jobs.length} matrix jobs`;
    const job = state.jobs[0];
    if (job?.runnerName) return job.runnerName;
    if (job?.conclusion) return job.conclusion.replaceAll("_", " ");
    if (job?.status === "in_progress") return "Running";
    if (job) return "Waiting";
    return definition.uses ? "Reusable workflow" : "Not started";
  }


  function selectDefinition(definition) {
    const state = stateFor(definition);
    const job = state.jobs.find((item) => item.conclusion === "failure")
      ?? state.jobs.find((item) => item.status !== "completed")
      ?? state.jobs[0];
    if (job) onselect(job);
  }

  function jobStage(job, byId, visiting = new Set()) {
    if (visiting.has(job.id)) return 0;
    const next = new Set(visiting).add(job.id);
    const parents = job.needs.map((id) => byId.get(id)).filter(Boolean);
    return parents.length === 0 ? 0 : Math.max(...parents.map((parent) => jobStage(parent, byId, next))) + 1;
  }

  let graph = $derived.by(() => {
    const jobs = selectedWorkflow?.jobs ?? [];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const stageCounts = new Map();
    const nodes = jobs.map((job) => {
      const stage = jobStage(job, byId);
      const row = stageCounts.get(stage) ?? 0;
      stageCounts.set(stage, row + 1);
      return { job, stage, x: 24 + stage * 292, y: 58 + row * 98 };
    });
    const positions = new Map(nodes.map((node) => [node.job.id, node]));
    const edges = nodes.flatMap((node) => node.job.needs.map((id) => ({ from: positions.get(id), to: node })).filter((edge) => edge.from));
    return {
      nodes,
      edges,
      width: Math.max(720, (Math.max(0, ...nodes.map((node) => node.stage)) + 1) * 292 + 24),
      height: Math.max(300, Math.max(0, ...nodes.map((node) => node.y)) + 110),
    };
  });

  let timeline = $derived.by(() => {
    const jobs = (runGroup?.jobs ?? []).filter((job) => job.startedAt);
    const starts = jobs.map((job) => Date.parse(job.startedAt));
    const ends = jobs.map((job) => Date.parse(job.completedAt ?? new Date().toISOString()));
    const start = Math.min(...starts);
    const end = Math.max(...ends, start + 1);
    return jobs
      .map((job) => ({
        job,
        left: ((Date.parse(job.startedAt) - start) / (end - start)) * 100,
        width: Math.max(1.5, ((Date.parse(job.completedAt ?? new Date().toISOString()) - Date.parse(job.startedAt)) / (end - start)) * 100),
      }))
      .sort((left, right) => Date.parse(left.job.startedAt) - Date.parse(right.job.startedAt));
  });
</script>

<div class="graph-shell">
  <header class="graph-toolbar">
    <div class="workflow-picker">
      <label for="workflow-graph">Workflow</label>
      <select id="workflow-graph" bind:value={selectedPath}>
        {#each workflows as workflow}
          <option value={workflow.path}>{workflow.name || workflow.path}</option>
        {/each}
      </select>
    </div>
    <div class="mode-picker" aria-label="Overview layout">
      <button class:active={mode === "workflow"} onclick={() => mode = "workflow"}>Workflow</button>
      <button class:active={mode === "timeline"} onclick={() => mode = "timeline"}>Timeline</button>
    </div>
    {#if runGroup}
      <span class="run-summary">
        {runGroup.jobs.filter((job) => job.conclusion === "success").length} passed
        · {runGroup.jobs.filter((job) => job.conclusion === "failure").length} failed
        · {runGroup.jobs.filter((job) => job.status !== "completed").length} active
      </span>
    {/if}
  </header>

  {#if !selectedWorkflow}
    <div class="graph-empty">No workflow definitions found for this head.</div>
  {:else if selectedWorkflow.error}
    <div class="graph-empty error">{selectedWorkflow.error}</div>
  {:else if mode === "workflow"}
    <div class="workflow-canvas" role="group" aria-label={`${selectedWorkflow.name || "Workflow"} dependency graph`}>
      <div class="canvas-inner" style={`width:${graph.width}px;height:${graph.height}px`}>
        <svg class="edges" width={graph.width} height={graph.height} aria-hidden="true">
          <defs>
            <marker id="workflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
          </defs>
          {#each graph.edges as edge}
            <path d={`M ${edge.from.x + 236} ${edge.from.y + 34} C ${edge.from.x + 264} ${edge.from.y + 34}, ${edge.to.x - 28} ${edge.to.y + 34}, ${edge.to.x} ${edge.to.y + 34}`}></path>
          {/each}
        </svg>
        {#each graph.nodes as node (node.job.id)}
          {@const state = stateFor(node.job)}
          <button
            class="graph-node"
            class:clickable={state.jobs.length > 0}
            style={`left:${node.x}px;top:${node.y}px`}
            onclick={() => selectDefinition(node.job)}
            disabled={state.jobs.length === 0}
          >
            {@render statusIcon(state.status, state.conclusion)}
            <span class="node-copy">
              <strong>{node.job.name}</strong>
              <span>{nodeMeta(node.job, state)}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {:else if timeline.length === 0}
    <div class="graph-empty">No job timing is available yet.</div>
  {:else}
    <div class="timeline">
      {#each timeline as item (item.job.id)}
        <button class="timeline-row" onclick={() => onselect(item.job)}>
          <span class="timeline-label">
            {@render statusIcon(item.job.status, item.job.conclusion)}
            <span>{item.job.name}</span>
          </span>
          <span class="track">
            <span class="bar" class:failed={item.job.conclusion === "failure"} style={`left:${item.left}%;width:${item.width}%`}></span>
          </span>
          <span class="duration">{item.job.completedAt ? durationText(item.job.startedAt, item.job.completedAt) : "running"}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .graph-shell {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: var(--shadow-xs);
  }
  .graph-toolbar {
    display: flex;
    min-height: 48px;
    align-items: center;
    gap: 16px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .workflow-picker {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  label,
  .run-summary {
    color: var(--text-faint);
    font-size: 11px;
  }
  select {
    padding: 5px 24px 5px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    background: var(--panel);
    font: 500 12px var(--sans);
  }
  .mode-picker {
    display: flex;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 7px;
  }
  .mode-picker button {
    padding: 5px 10px;
    border: 0;
    color: var(--text-faint);
    background: transparent;
    font: 500 11px var(--sans);
    cursor: pointer;
  }
  .mode-picker button + button {
    border-left: 1px solid var(--border);
  }
  .mode-picker button.active {
    color: var(--text);
    background: var(--panel-raised);
  }
  .run-summary {
    margin-left: auto;
  }
  .workflow-canvas {
    min-height: 420px;
    overflow: auto;
    background-image: radial-gradient(circle, var(--border) 0.75px, transparent 0.75px);
    background-size: 18px 18px;
  }
  .canvas-inner {
    position: relative;
  }
  .edges {
    position: absolute;
    inset: 0;
    overflow: visible;
  }
  .edges path {
    fill: none;
    stroke: var(--border-strong, var(--border));
    stroke-width: 1.5;
    marker-end: url(#workflow-arrow);
  }
  .edges marker path {
    fill: var(--text-faint);
    stroke: none;
  }
  .graph-node {
    position: absolute;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    width: 236px;
    min-height: 68px;
    padding: 11px 12px;
    border: 1px solid var(--border);
    border-radius: 9px;
    color: inherit;
    background: var(--panel);
    box-shadow: var(--shadow-xs);
    text-align: left;
  }
  .graph-node.clickable {
    cursor: pointer;
  }
  .graph-node.clickable:hover {
    border-color: var(--text-faint);
    background: var(--panel-raised);
  }
  .graph-node:disabled {
    opacity: 0.72;
  }
  .node-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }
  .node-copy strong,
  .node-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .node-copy strong {
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
  }
  .node-copy span {
    color: var(--text-faint);
    font-size: 10px;
  }
  .timeline {
    padding: 12px;
  }
  .timeline-row {
    display: grid;
    grid-template-columns: minmax(180px, 28%) minmax(240px, 1fr) 52px;
    width: 100%;
    align-items: center;
    gap: 14px;
    padding: 8px;
    border: 0;
    border-radius: 7px;
    color: inherit;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .timeline-row:hover {
    background: var(--surface-hover);
  }
  .timeline-label {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: 11px;
  }
  .timeline-label > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    position: relative;
    height: 6px;
    border-radius: 999px;
    background: var(--surface);
  }
  .bar {
    position: absolute;
    top: 0;
    height: 6px;
    border-radius: 999px;
    background: var(--ready);
  }
  .bar.failed {
    background: var(--fail);
  }
  .duration {
    color: var(--text-faint);
    font: 10px var(--mono);
    text-align: right;
  }
  .graph-empty {
    display: flex;
    min-height: 420px;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: 12px;
  }
  .graph-empty.error {
    color: var(--fail);
  }
  @media (max-width: 860px) {
    .graph-toolbar {
      flex-wrap: wrap;
      padding-block: 8px;
    }
    .run-summary {
      width: 100%;
      margin-left: 0;
    }
    .timeline-row {
      grid-template-columns: minmax(130px, 35%) minmax(120px, 1fr) 45px;
      gap: 8px;
    }
  }
</style>
