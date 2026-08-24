<script>
  import { relativeTime } from "./time.js";
  import Chevron from "./Chevron.svelte";
  import Kbd from "./Kbd.svelte";

  let { commits, rangeKey, showSince, sinceLabel, onSelect, open = $bindable(false) } = $props();

  let activeIdx = $state(0);
  let dragStart = $state(null);
  let dragEnd = $state(null);
  let rootEl;

  let ordered = $derived([...commits].reverse());
  let fixedRows = $derived([
    { key: "all", label: "All changes" },
    ...(showSince ? [{ key: "since", label: sinceLabel }] : []),
  ]);

  let currentLabel = $derived.by(() => {
    if (rangeKey === "all") return "All changes";
    if (rangeKey === "since") return sinceLabel;
    if (rangeKey.startsWith("r")) {
      const [base, head] = rangeKey.slice(1).split(":");
      const older = commits.find((c) => c.parents.nodes[0].oid === base);
      const newer = commits.find((c) => c.oid === head);
      if (older && newer) return `${commits.indexOf(newer) - commits.indexOf(older) + 1} commits · ${newer.abbreviatedOid}`;
      return "commit range";
    }
    const c = commits.find((x) => x.oid === rangeKey.slice(1));
    return c ? `${c.abbreviatedOid} · ${c.messageHeadline}` : "commit";
  });

  function close() {
    open = false;
    dragStart = null;
    dragEnd = null;
  }

  function pick(key) {
    onSelect(key);
    close();
  }

  function commitInDrag(i) {
    if (dragStart === null || dragEnd === null) return false;
    return i >= Math.min(dragStart, dragEnd) && i <= Math.max(dragStart, dragEnd);
  }

  function finishDrag() {
    if (dragStart === null) return;
    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    if (lo === hi) {
      pick(`c${ordered[lo].oid}`);
    } else {
      const newer = ordered[lo];
      const older = ordered[hi];
      pick(`r${older.parents.nodes[0].oid}:${newer.oid}`);
    }
  }

  function onKey(e) {
    if (!open) return;
    const total = fixedRows.length + ordered.length;
    if (e.key === "ArrowDown" || e.key === "j") {
      activeIdx = Math.min(total - 1, activeIdx + 1);
      if (dragStart !== null) dragEnd = Math.max(0, activeIdx - fixedRows.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      activeIdx = Math.max(0, activeIdx - 1);
      if (dragStart !== null) dragEnd = Math.max(0, activeIdx - fixedRows.length);
      e.preventDefault();
    } else if (e.key === " ") {
      if (activeIdx >= fixedRows.length) {
        const i = activeIdx - fixedRows.length;
        if (dragStart === null) {
          dragStart = i;
          dragEnd = i;
        } else {
          dragStart = null;
          dragEnd = null;
        }
      }
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (dragStart !== null) finishDrag();
      else if (activeIdx < fixedRows.length) pick(fixedRows[activeIdx].key);
      else pick(`c${ordered[activeIdx - fixedRows.length].oid}`);
      e.preventDefault();
    } else if (e.key === "Escape") {
      close();
      e.preventDefault();
    }
  }

  $effect(() => {
    if (!open) return;
    activeIdx = 0;
    if (rangeKey === "since") activeIdx = showSince ? 1 : 0;
    else if (rangeKey.startsWith("c")) {
      const i = ordered.findIndex((c) => c.oid === rangeKey.slice(1));
      if (i >= 0) activeIdx = fixedRows.length + i;
    }
    const onDocDown = (e) => {
      if (rootEl && !rootEl.contains(e.target)) close();
    };
    const onUp = () => finishDrag();
    document.addEventListener("mousedown", onDocDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="rangepicker" bind:this={rootEl}>
  <button class="rp-trigger" aria-haspopup="listbox" aria-expanded={open} onclick={() => (open ? close() : (open = true))}>
    <span class="rp-label">{currentLabel}</span>
    <Kbd keys="c" />
    <Chevron />
  </button>
  {#if open}
    <div class="rp-popover" role="listbox">
      {#each fixedRows as row, i}
        <button class="rp-row fixed" class:active={activeIdx === i} onmouseenter={() => (activeIdx = i)} onclick={() => pick(row.key)}>
          {row.label}
        </button>
      {/each}
      {#if ordered.length}
        <div class="rp-sep"></div>
        {#each ordered as c, i}
          <button
            class="rp-row commit mono"
            class:active={activeIdx === fixedRows.length + i}
            class:indrag={commitInDrag(i)}
            onmousedown={() => {
              dragStart = i;
              dragEnd = i;
            }}
            onmouseenter={() => {
              activeIdx = fixedRows.length + i;
              if (dragStart !== null) dragEnd = i;
            }}
          >
            <span class="rp-sha">{c.abbreviatedOid}</span>
            <span class="rp-msg">{c.messageHeadline}</span>
            <span class="rp-time">{relativeTime(c.committedDate)}</span>
          </button>
        {/each}
        <div class="rp-hint">Drag, or press Space + J/K, to select a range</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .rangepicker {
    position: relative;
  }
  .rp-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 340px;
    min-height: 32px;
    padding: 0 12px;
    background: var(--panel);
    border: 0;
    border-radius: 999px;
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .rp-trigger:hover {
    background: var(--surface);
  }
  .rp-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rp-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 40;
    min-width: 320px;
    max-width: 460px;
    max-height: 60vh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    box-shadow: 0 8px 24px var(--overlay-bg);
    user-select: none;
  }
  .rp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 5px;
    color: var(--text-dim);
    font-size: 12px;
    padding: 6px 8px;
    cursor: pointer;
  }
  .rp-row.active {
    background: var(--hunk-hover);
    color: var(--text);
  }
  .rp-row.indrag {
    background: var(--link-bg);
    color: var(--text);
  }
  .rp-sep {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }
  .rp-sha {
    flex: none;
    color: var(--text-faint);
  }
  .rp-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rp-time {
    flex: none;
    color: var(--text-faint);
    font-size: 11px;
  }
  .rp-hint {
    padding: 6px 8px 3px;
    color: var(--text-faint);
    font-size: 10.5px;
  }

  .rp-trigger {
    min-height: 32px;
    padding-inline: 12px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    transition: background-color 140ms ease, box-shadow 140ms ease, transform 140ms var(--ease-out);
  }
  .rp-trigger:hover {
    background: var(--surface-hover);
  }
  .rp-trigger:active {
    transform: scale(0.99);
  }
  .rp-popover {
    padding: 6px;
    background: var(--panel);
    border-radius: 11px;
    box-shadow: var(--shadow-dialog);
  }
  .rp-row {
    min-height: 32px;
    border-radius: 7px;
  }
  .rp-row.active {
    background: var(--surface);
    box-shadow: var(--shadow-xs);
  }
</style>
