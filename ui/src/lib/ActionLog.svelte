<script>
  import { tick } from "svelte";
  import { parseActionLog } from "./actionLog.js";

  let { body = "", jobConclusion = null, failedStep = null, statusIcon } = $props();
  const failureConclusions = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  let expanded = $state(new Set());
  let expandedGroups = $state(new Set());
  let parsed = $derived(parseActionLog(body, jobConclusion, failedStep));
  let logEl = $state();

  $effect(() => {
    body;
    const failed = parsed.steps.filter((step) => stepTone(step.conclusion) === "failure").map((step) => step.id);
    expanded = new Set(failed.length > 0 ? failed : parsed.steps.length === 1 ? [parsed.steps[0].id] : []);
    expandedGroups = new Set();
    void tick().then(() => {
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
  });

  function toggle(stepId) {
    const next = new Set(expanded);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    expanded = next;
  }

  function toggleGroup(groupId) {
    const next = new Set(expandedGroups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    expandedGroups = next;
  }

  function jump(position) {
    if (!logEl) return;
    logEl.scrollTop = position === "top" ? 0 : logEl.scrollHeight;
  }

  function lineVisible(line) {
    return (line.groups ?? []).every((groupId) => expandedGroups.has(groupId));
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
{#snippet styledContent(value)}
  {#if value.segments}
    {#each value.segments as segment}
      <span class={`${segment.color ? `ansi-${segment.color}` : ""}${segment.bold ? " ansi-bold" : ""}`}>{segment.text}</span>
    {/each}
  {:else}
    {value.text || " "}
  {/if}
{/snippet}

{#snippet logText(line)}
  {#if line.parts}
    {#each line.parts as part}
      {#if part.href}
        <a class="log-link" href={part.href} target={part.external ? "_blank" : undefined} rel={part.external ? "noopener noreferrer" : undefined}>{@render styledContent(part)}</a>
      {:else}
        {@render styledContent(part)}
      {/if}
    {/each}
  {:else}
    {@render styledContent(line)}
  {/if}
{/snippet}

<div class="structured-log" bind:this={logEl}>
  <nav class="log-nav" aria-label="Log position">
    <button type="button" onclick={() => jump("top")} aria-label="Go to top">↑ Top</button>
    <button type="button" onclick={() => jump("bottom")} aria-label="Go to bottom">↓ Bottom</button>
  </nav>
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
                {#if lineVisible(line)}
                  {#if line.groupId}
                    <div class="output-group {stepTone(line.conclusion)}">
                      <span class="line-number">{line.line}</span>
                      <button
                        class="group-summary"
                        aria-expanded={expandedGroups.has(line.groupId)}
                        onclick={() => toggleGroup(line.groupId)}
                      >
                        <svg class:expanded={expandedGroups.has(line.groupId)} class="chevron" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="m4 2.5 3.5 3.5L4 9.5" />
                        </svg>
                        <code>{@render logText(line)}</code>
                      </button>
                    </div>
                  {:else}
                    <div class="output-line {line.tone}" class:blank={line.text === ""}>
                      <span class="line-number">{line.line}</span>
                      <code>{@render logText(line)}</code>
                    </div>
                  {/if}
                {/if}
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

  .log-nav {
    position: sticky;
    top: 8px;
    z-index: 4;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    height: 0;
    padding-right: 8px;
    pointer-events: none;
  }

  .log-nav button {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    box-shadow: 0 1px 4px color-mix(in srgb, black 18%, transparent);
    color: var(--text-dim);
    font: 600 10px/1 var(--font-ui);
    pointer-events: auto;
    cursor: pointer;
  }

  .log-nav button:hover {
    border-color: var(--border-strong);
    color: var(--text);
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
    color: var(--text);
    font: inherit;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .log-link {
    color: var(--accent);
    text-decoration: none;
  }

  .log-link:hover {
    text-decoration: underline;
  }

  .line-number {
    padding-right: 10px;
    border-right: 1px solid var(--border);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    text-align: right;
    user-select: none;
  }

  .output-line.command code {
    color: #0969da;
  }

  .output-group {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    margin: 5px 0 2px;
    background: var(--surface);
  }

  .group-summary {
    display: grid;
    min-width: 0;
    grid-template-columns: 14px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    padding: 4px 14px 4px 10px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .group-summary:hover {
    background: var(--panel-raised);
  }

  .group-summary code {
    min-width: 0;
    padding: 0;
    color: var(--text);
    font: inherit;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .output-group.failure {
    background: color-mix(in srgb, var(--fail) 9%, var(--surface));
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
  .ansi-black,
  .ansi-bright-black { color: var(--text-faint); }
  .ansi-red { color: #cf222e; }
  .ansi-bright-red { color: #a40e26; }
  .ansi-green { color: #1a7f37; }
  .ansi-bright-green { color: #116329; }
  .ansi-yellow { color: #9a6700; }
  .ansi-bright-yellow { color: #7d4e00; }
  .ansi-blue { color: #0969da; }
  .ansi-bright-blue { color: #0550ae; }
  .ansi-magenta { color: #8250df; }
  .ansi-bright-magenta { color: #6639ba; }
  .ansi-cyan { color: #1b7c83; }
  .ansi-bright-cyan { color: #096b72; }
  .ansi-white,
  .ansi-bright-white { color: var(--text); }
  .ansi-bold { font-weight: 650; }

  .output-empty {
    padding: 8px 58px;
    color: var(--text-faint);
  }

  :global(html[data-theme="dark"]) .output-line.command code { color: #58a6ff; }
  :global(html[data-theme="dark"]) .output-line.warning code { color: #d29922; }
  :global(html[data-theme="dark"]) .ansi-red { color: #ff7b72; }
  :global(html[data-theme="dark"]) .ansi-bright-red { color: #ffa198; }
  :global(html[data-theme="dark"]) .ansi-green { color: #3fb950; }
  :global(html[data-theme="dark"]) .ansi-bright-green { color: #56d364; }
  :global(html[data-theme="dark"]) .ansi-yellow { color: #d29922; }
  :global(html[data-theme="dark"]) .ansi-bright-yellow { color: #e3b341; }
  :global(html[data-theme="dark"]) .ansi-blue { color: #58a6ff; }
  :global(html[data-theme="dark"]) .ansi-bright-blue { color: #79c0ff; }
  :global(html[data-theme="dark"]) .ansi-magenta { color: #bc8cff; }
  :global(html[data-theme="dark"]) .ansi-bright-magenta { color: #d2a8ff; }
  :global(html[data-theme="dark"]) .ansi-cyan { color: #39c5cf; }
  :global(html[data-theme="dark"]) .ansi-bright-cyan { color: #56d4dd; }

  @media (max-width: 860px) {
    .structured-log {
      min-height: 300px;
      max-height: none;
    }
  }
</style>
