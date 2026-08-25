<script>
  import { parseActionLog } from "./actionLog.js";

  let { body, jobConclusion, statusIcon } = $props();
  const failureConclusions = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  let expanded = $state(new Set());
  let parsed = $derived(parseActionLog(body, jobConclusion));

  $effect(() => {
    body;
    const failed = parsed.steps.filter((step) => stepTone(step.conclusion) === "failure").map((step) => step.id);
    expanded = new Set(failed.length > 0 ? failed : parsed.steps.length === 1 ? [parsed.steps[0].id] : []);
  });

  function toggle(stepId) {
    const next = new Set(expanded);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    expanded = next;
  }

  function stepTone(conclusion) {
    if (failureConclusions.has(conclusion)) return "failure";
    if (conclusion === "skipped") return "skipped";
    if (conclusion === "warning") return "warning";
    return "success";
  }

  function iconConclusion(conclusion) {
    const tone = stepTone(conclusion);
    if (tone === "failure") return "failure";
    if (tone === "skipped") return "skipped";
    if (tone === "warning") return "neutral";
    return "success";
  }

  function stepState(conclusion) {
    return stepTone(conclusion) === "skipped" ? "neutral" : "completed";
  }

  function duration(ms) {
    if (ms === null) return "";
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return `${minutes}m ${seconds}s`;
  }
</script>

<div class="structured-log">
  {#if parsed.annotations.length > 0}
    <section class="annotations" aria-label="Log annotations">
      <h3>Annotations <span>{parsed.annotations.length}</span></h3>
      {#each parsed.annotations as annotation}
        <div class="annotation {annotation.tone}">
          <span class="annotation-symbol" aria-hidden="true">{annotation.tone === "failure" ? "×" : annotation.tone === "warning" ? "!" : "i"}</span>
          <code>{annotation.text}</code>
          <span class="annotation-line">Line {annotation.line}</span>
        </div>
      {/each}
    </section>
  {/if}

  <section class="log-steps" aria-label="Job steps">
    {#each parsed.steps as step}
      <div class="log-step {stepTone(step.conclusion)}">
        <button
          class="step-summary"
          aria-expanded={expanded.has(step.id)}
          onclick={() => toggle(step.id)}
        >
          <svg class:expanded={expanded.has(step.id)} class="chevron" viewBox="0 0 12 12" aria-hidden="true">
            <path d="m4 2.5 3.5 3.5L4 9.5" />
          </svg>
          <span class="step-status {stepTone(step.conclusion)}">{@render statusIcon(stepState(step.conclusion), iconConclusion(step.conclusion))}</span>
          <span class="step-title">{step.title}</span>
          {#if step.durationMs !== null}<span class="step-duration">{duration(step.durationMs)}</span>{/if}
        </button>

        {#if expanded.has(step.id)}
          <div class="step-output">
            {#if step.lines.length === 0}
              <div class="output-empty">No output</div>
            {:else}
              {#each step.lines as line}
                <div class="output-line {line.tone}" class:blank={line.text === ""}>
                  <span class="line-number">{line.line}</span>
                  <code>{line.text || " "}</code>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </section>
</div>

<style>
  .structured-log {
    min-height: 380px;
    max-height: calc(100vh - 330px);
    overflow: auto;
    background: var(--panel);
    color: var(--text-dim);
    font-size: 12px;
  }

  .annotations {
    border-bottom: 1px solid var(--border);
    padding: 12px 14px;
  }

  .annotations h3 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 8px;
    color: var(--text);
    font-size: 12px;
  }

  .annotations h3 span {
    display: inline-grid;
    min-width: 20px;
    height: 18px;
    padding: 0 5px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-faint);
    font-size: 10px;
  }

  .annotation {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: start;
    gap: 7px;
    padding: 7px 9px;
    border-left: 3px solid var(--review);
    background: color-mix(in srgb, var(--review) 8%, transparent);
  }

  .annotation + .annotation {
    margin-top: 5px;
  }

  .annotation.failure {
    border-left-color: var(--fail);
    background: color-mix(in srgb, var(--fail) 8%, transparent);
  }

  .annotation.warning {
    border-left-color: #bf8700;
    background: color-mix(in srgb, #bf8700 9%, transparent);
  }

  .annotation-symbol {
    display: inline-grid;
    width: 16px;
    height: 16px;
    place-items: center;
    border-radius: 50%;
    background: var(--review);
    color: white;
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
  }

  .annotation.failure .annotation-symbol { background: var(--fail); }
  .annotation.warning .annotation-symbol { background: #bf8700; }

  .annotation code {
    min-width: 0;
    color: var(--text);
    font-family: var(--font-code);
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .annotation-line {
    color: var(--text-faint);
    font-size: 10px;
    white-space: nowrap;
  }

  .log-step {
    border-bottom: 1px solid var(--border);
  }

  .step-summary {
    display: grid;
    width: 100%;
    grid-template-columns: 14px 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    border: 0;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .step-summary:hover {
    background: var(--panel-raised);
  }

  .chevron {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.6;
    transition: transform 100ms ease;
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .step-status {
    display: inline-flex;
    color: var(--ready);
  }

  .step-status.failure { color: var(--fail); }
  .step-status.warning { color: #bf8700; }
  .step-status.skipped { color: var(--text-faint); }

  .step-status :global(.status-icon) {
    width: 16px;
    height: 16px;
  }

  .step-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .step-duration {
    color: var(--text-faint);
    font-size: 10px;
  }

  .step-output {
    padding: 7px 0;
    border-top: 1px solid var(--border);
    background: var(--panel);
    font-family: var(--font-code);
    font-size: 11px;
    line-height: 1.5;
  }

  .output-line {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    min-height: 18px;
  }

  .output-line:hover {
    background: var(--surface);
  }

  .output-line code {
    padding: 0 14px 0 10px;
    color: var(--text-dim);
    font: inherit;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .line-number {
    padding-right: 10px;
    border-right: 1px solid var(--border);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    text-align: right;
    user-select: none;
  }

  .output-line.command code {
    color: #0969da;
  }

  .output-line.group {
    margin: 5px 0 2px;
  }

  .output-line.group code {
    color: var(--text);
    font-weight: 650;
  }

  .output-line.failure {
    background: color-mix(in srgb, var(--fail) 9%, transparent);
  }

  .output-line.failure code {
    color: var(--fail);
    font-weight: 600;
  }

  .output-line.warning {
    background: color-mix(in srgb, #bf8700 8%, transparent);
  }

  .output-line.warning code {
    color: #9a6700;
  }

  .output-empty {
    padding: 8px 58px;
    color: var(--text-faint);
  }

  :global(html[data-theme="dark"]) .output-line.command code { color: #58a6ff; }
  :global(html[data-theme="dark"]) .output-line.warning code { color: #d29922; }

  @media (max-width: 860px) {
    .structured-log {
      min-height: 300px;
      max-height: none;
    }
  }
</style>
