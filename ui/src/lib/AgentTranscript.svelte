<script>
  import { imageFallback, renderMarkdown } from "./markdown.js";
  import { mermaidDiagrams } from "./mermaid.js";
  import { theme } from "./theme.svelte.js";
  import Chevron from "./Chevron.svelte";

  // Expansion state lives here, so callers remount this component to reset it for another run.
  let { turns = [], rawLog = "", showRawLog = false } = $props();

  let expandedTurns = $state(new Set());

  let transcriptEntries = $derived.by(() => {
    const entries = [];
    for (const [index, turn] of turns.entries()) {
      const previous = entries.at(-1);
      if (turn.kind === "tool") {
        if (previous?.tools) previous.tools.push({ turn, index });
        else entries.push({ index, tools: [{ turn, index }] });
      } else if (
        turn.kind === "result" && !turn.isError && turn.text?.trim() &&
        previous?.turn?.kind === "text" && previous.turn.text?.trim() === turn.text.trim()
      ) {
        // Some runners repeat the final assistant message as their result event.
        // Coalesce only an adjacent exact match; errors and distinct output stay visible.
        previous.turn = turn;
      } else {
        entries.push({ index, turn });
      }
    }
    return entries;
  });

  function toggleTurnExpanded(i) {
    const next = new Set(expandedTurns);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    expandedTurns = next;
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
</script>

{#if showRawLog}
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
</style>
