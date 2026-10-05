<script>
  import { imageFallback, renderMarkdown } from "./markdown.js";
  import { mermaidDiagrams } from "./mermaid.js";
  import { theme } from "./theme.svelte.js";
  import Chevron from "./Chevron.svelte";

  // Expansion state lives here, so callers remount this component to reset it for another run.
  let { turns = [], rawLog = "", showRawLog = false, variant = "default" } = $props();

  // A refreshed transcript is a sliding tail; conversation tool expansion follows content, not shifted indexes.
  let expandedTurns = $state(new Set());
  let openGroups = $state(new Set());

  function turnSignature(turn) {
    const body = turn.kind === "tool"
      ? `${turn.toolName ?? ""}\u0001${typeof turn.toolInput === "string" ? turn.toolInput : JSON.stringify(turn.toolInput ?? null)}`
      : `${turn.isError ? 1 : 0}\u0001${turn.text ?? ""}`;
    return `${turn.kind}\u0001${turn.ts ?? ""}\u0001${body}`;
  }

  let transcriptEntries = $derived.by(() => {
    const entries = [];
    const occurrences = variant === "conversation" ? new Map() : null;
    for (const [index, turn] of turns.entries()) {
      let key = index;
      if (occurrences) {
        const signature = turnSignature(turn);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        key = `${occurrence}\u0002${signature}`;
      }
      const previous = entries.at(-1);
      if (turn.kind === "tool") {
        if (previous?.tools) previous.tools.push({ turn, index, key });
        else entries.push({ index, key, tools: [{ turn, index, key }] });
      } else if (
        turn.kind === "result" && !turn.isError && turn.text?.trim() &&
        previous?.turn?.kind === "text" && previous.turn.text?.trim() === turn.text.trim()
      ) {
        // Some runners repeat the final assistant message as their result event.
        // Coalesce only an adjacent exact match; errors and distinct output stay visible.
        previous.turn = turn;
      } else {
        entries.push({ index, key, turn });
      }
    }
    return entries;
  });

  function toggleTurnExpanded(key) {
    const next = new Set(expandedTurns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedTurns = next;
  }

  function toggleGroup(groupKey) {
    const next = new Set(openGroups);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    openGroups = next;
  }

  // A lone tool call is one row; opening it also opens its group so the input stays visible if
  // later tool calls join the group on refresh.
  function toggleSingleTool(groupKey, key) {
    const open = !expandedTurns.has(key);
    const turnsNext = new Set(expandedTurns);
    const groupsNext = new Set(openGroups);
    if (open) {
      turnsNext.add(key);
      groupsNext.add(groupKey);
    } else {
      turnsNext.delete(key);
      groupsNext.delete(groupKey);
    }
    expandedTurns = turnsNext;
    openGroups = groupsNext;
  }

  const TOOL_PRIMARY_KEYS = ["command", "file_path", "content", "pattern", "query", "url", "prompt"];

  function toolPrimaryArg(input) {
    if (!input || typeof input !== "object") return null;
    for (const key of TOOL_PRIMARY_KEYS) {
      if (typeof input[key] === "string" && input[key]) return [key, input[key]];
    }
    return Object.entries(input).find(([, v]) => typeof v === "string" && v) ?? null;
  }

  function toolLabel(turn, primary) {
    let summary = "";
    if (typeof turn.toolInput?.description === "string" && turn.toolInput.description) {
      summary = turn.toolInput.description;
    } else if (primary) {
      const flat = primary[1].replace(/\s+/g, " ").trim();
      summary = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
    return summary ? `→ ${turn.toolName} — ${summary}` : `→ ${turn.toolName}`;
  }

  function flatPreview(value) {
    const flat = value.slice(0, 400).replace(/\s+/g, " ").trim();
    return value.length > 400 ? `${flat}…` : flat;
  }

  // Claude tools carry their intent as "description", omp tools as "i".
  function toolIntent(input) {
    if (!input || typeof input !== "object") return "";
    for (const key of ["description", "i"]) {
      if (typeof input[key] === "string" && input[key].trim()) return flatPreview(input[key]);
    }
    return "";
  }

  // Bookkeeping fields (Codex item ids/types/status, intents) say nothing about what the tool acted on.
  const TOOL_PREVIEW_SKIP_KEYS = new Set(["description", "i", "id", "type", "status"]);

  function toolArgPreview(input) {
    if (typeof input === "string") return input.trim() ? flatPreview(input) : "";
    if (!input || typeof input !== "object") return "";
    for (const key of TOOL_PRIMARY_KEYS) {
      if (typeof input[key] === "string" && input[key].trim()) return flatPreview(input[key]);
    }
    const fallback = Object.entries(input).find(([key, v]) => !TOOL_PREVIEW_SKIP_KEYS.has(key) && typeof v === "string" && v.trim());
    return fallback ? flatPreview(fallback[1]) : "";
  }

</script>

{#snippet toolHeading(turn)}
  {@const intent = toolIntent(turn.toolInput)}
  {@const arg = toolArgPreview(turn.toolInput)}
  <span class="tool-name mono">{turn.toolName || "Tool"}</span>
  {#if intent}<span class="tool-intent">{intent}</span>{/if}
  {#if arg && arg !== intent}<span class="tool-arg mono">{arg}</span>{/if}
{/snippet}

{#if variant === "conversation"}
  <div class="conversation">
    {#if showRawLog}
      {#if rawLog}
        <pre class="log mono">{rawLog}</pre>
      {:else}
        <p class="empty">No log output is available for this run.</p>
      {/if}
    {:else}
      {#each transcriptEntries as entry (entry.key)}
        {#if entry.tools}
          {#if entry.tools.length === 1}
            {@const tool = entry.tools[0]}
            {@const open = expandedTurns.has(tool.key)}
            <div class="activity">
              <button class="activity-row" aria-expanded={open} onclick={() => toggleSingleTool(entry.key, tool.key)}>
                <Chevron direction={open ? "down" : "right"} size={12} />
                {@render toolHeading(tool.turn)}
              </button>
              {#if open}<pre class="tool-input mono">{typeof tool.turn.toolInput === "string" ? tool.turn.toolInput : JSON.stringify(tool.turn.toolInput ?? {}, null, 2)}</pre>{/if}
            </div>
          {:else}
            {@const groupOpen = openGroups.has(entry.key)}
            <div class="activity">
              <button class="activity-row" aria-expanded={groupOpen} onclick={() => toggleGroup(entry.key)}>
                <Chevron direction={groupOpen ? "down" : "right"} size={12} />
                <span class="activity-count">{entry.tools.length} tool calls</span>
                <span class="activity-names">{entry.tools.map(({ turn }) => turn.toolName).filter((name, index, names) => name && names.indexOf(name) === index).join(" · ")}</span>
              </button>
              {#if groupOpen}
                <ul class="activity-list">
                  {#each entry.tools as tool (tool.key)}
                    {@const open = expandedTurns.has(tool.key)}
                    <li>
                      <button class="activity-row" aria-expanded={open} onclick={() => toggleTurnExpanded(tool.key)}>
                        <Chevron direction={open ? "down" : "right"} size={12} />
                        {@render toolHeading(tool.turn)}
                      </button>
                      {#if open}<pre class="tool-input mono">{typeof tool.turn.toolInput === "string" ? tool.turn.toolInput : JSON.stringify(tool.turn.toolInput ?? {}, null, 2)}</pre>{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        {:else if entry.turn.kind === "result"}
          {@const turn = entry.turn}
          <section class="outcome" class:error={turn.isError} aria-label={turn.isError ? "Error" : "Result"}>
            <div class="outcome-label">{turn.isError ? "Error" : "Result"}</div>
            <div class="md" use:imageFallback use:mermaidDiagrams={theme.name + "" + (turn.text ?? "")}>{@html renderMarkdown(turn.text || (turn.isError ? "The agent reported an error without details." : "Completed without additional output."))}</div>
          </section>
        {:else if entry.turn.text?.trim()}
          {@const turn = entry.turn}
          <div class="message md" use:imageFallback use:mermaidDiagrams={theme.name + "" + (turn.text ?? "")}>{@html renderMarkdown(turn.text)}</div>
        {/if}
      {/each}
    {/if}
  </div>
{:else if showRawLog}
  <pre class="raw-log mono">{rawLog || "no log"}</pre>
{:else}
  <div class="run-turns">
    {#each transcriptEntries as entry (entry.index)}
      {#if entry.tools}
        <details class="turn-activity">
          <summary>
            <span>Tool activity · {entry.tools.length} {entry.tools.length === 1 ? "call" : "calls"}</span>
            <span class="activity-preview">{entry.tools.map(({ turn }) => turn.toolName).filter((name, index, names) => names.indexOf(name) === index).join(" · ")}</span>
          </summary>
          <div class="activity-tools">
            {#each entry.tools as { turn, index } (index)}
              {@const primary = toolPrimaryArg(turn.toolInput)}
              <div class="turn-tool mono">
                <button class="turn-toggle" aria-expanded={expandedTurns.has(index)} onclick={() => toggleTurnExpanded(index)}>
                  <Chevron direction={expandedTurns.has(index) ? "down" : "right"} size={12} />
                  <span class="turn-line">{toolLabel(turn, primary)}</span>
                </button>
                {#if expandedTurns.has(index)}
                  <pre class="turn-tool-input">{typeof turn.toolInput === "string" ? turn.toolInput : JSON.stringify(turn.toolInput ?? {}, null, 2)}</pre>
                {/if}
              </div>
            {/each}
          </div>
        </details>
      {:else}
        {@const turn = entry.turn}
        <div class="turn" class:turn-text={turn.kind === "text"} class:turn-result={turn.kind === "result"} class:err={turn.isError}>
          {#if turn.kind === "result"}<div class="turn-outcome">{turn.isError ? "Error" : "Result"}</div>{/if}
          <div class="md" use:imageFallback use:mermaidDiagrams={theme.name + "" + (turn.text ?? "")}>{@html renderMarkdown(turn.text || (turn.isError ? "The agent reported an error without details." : turn.kind === "result" ? "Completed without additional output." : ""))}</div>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .raw-log {
    margin: 10px 0 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .run-turns {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .turn {
    padding: 8px 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .turn-text {
    color: var(--text);
  }
  .turn-activity {
    border-left: 2px solid var(--border);
    padding-left: 12px;
    color: var(--text-dim);
    font-size: 12px;
    min-width: 0;
  }
  .turn-activity > summary {
    cursor: pointer;
    padding: 5px 0;
  }
  .activity-preview {
    margin-left: 12px;
    color: var(--text-faint);
    font-size: 11px;
  }
  .activity-tools {
    margin-top: 6px;
  }
  .turn-tool {
    padding: 6px 0;
    font-size: 11px;
  }
  .turn-tool + .turn-tool {
    border-top: 1px solid var(--border);
  }
  .turn-line {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .turn-toggle {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .turn-tool-input {
    margin: 8px 0 2px;
    padding: 10px 12px;
    background: var(--panel-raised);
    border-radius: 6px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 11px;
    color: var(--text);
    user-select: text;
  }
  .turn-result {
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
  .turn-outcome {
    margin-bottom: 8px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
  }
  .turn-result.err {
    border-left: 2px solid var(--fail);
    border-top: none;
    padding: 6px 0 6px 12px;
  }
  .turn-result.err .turn-outcome {
    color: var(--fail);
  }

  /* variant="conversation": prose-first reading layout; the caller's scroller owns scrolling. */
  .conversation {
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-width: 0;
    color: var(--text);
  }
  .conversation .message {
    min-width: 0;
  }
  .conversation .activity {
    min-width: 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .conversation .activity-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    min-height: 28px;
    padding: 4px 6px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .conversation .activity-row:hover {
    background: var(--ghost-hover);
    color: var(--text);
  }
  .conversation .activity-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .conversation .tool-name,
  .conversation .activity-count {
    flex: none;
    color: var(--text);
    font-weight: 500;
  }
  .conversation .tool-name {
    font-size: 12px;
  }
  .conversation .tool-intent,
  .conversation .tool-arg,
  .conversation .activity-names {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conversation .tool-intent {
    flex: 0 1 auto;
  }
  .conversation .tool-arg,
  .conversation .activity-names {
    flex: 1 1 0;
    color: var(--text-faint);
  }
  .conversation .tool-arg {
    font-size: 11.5px;
  }
  .conversation .activity-list {
    list-style: none;
    margin: 2px 0 2px 11px;
    padding: 0 0 0 8px;
    border-left: 1px solid var(--border);
  }
  .conversation .tool-input {
    margin: 4px 0 8px 26px;
    padding: 10px 12px;
    background: var(--code-block-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .conversation .outcome {
    min-width: 0;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .conversation .outcome-label {
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .conversation .outcome.error {
    padding: 12px 14px;
    background: var(--fail-bg);
    border: 1px solid color-mix(in srgb, var(--fail) 30%, transparent);
    border-radius: var(--radius-md);
  }
  .conversation .outcome.error .outcome-label {
    color: var(--fail);
  }
  .conversation .log {
    margin: 0;
    padding: 12px 14px;
    background: var(--code-block-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .conversation .empty {
    margin: 0;
    font-size: 13px;
    color: var(--text-dim);
  }
</style>
