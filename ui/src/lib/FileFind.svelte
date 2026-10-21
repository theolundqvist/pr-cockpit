<script>
  import { tick, untrack } from "svelte";
  import Kbd from "./Kbd.svelte";

  // `root` scrolls one `.pl-code` row per entry of `lines`. Matching runs on the source lines, so a hit
  // spanning several highlight tokens still matches; `revision` changes whenever the rows re-render.
  let { root, lines, revision, open = $bindable(false) } = $props();

  let query = $state("");
  let current = $state(-1);
  let count = $state(0);
  let inputEl = $state(null);
  let ranges = [];
  let searchedLines = null;

  const matchHl = new Highlight();
  const currentHl = new Highlight();
  CSS.highlights.set("file-find-match", matchHl);
  CSS.highlights.set("file-find-current", currentHl);
  $effect(() => () => {
    if (CSS.highlights.get("file-find-match") === matchHl) CSS.highlights.delete("file-find-match");
    if (CSS.highlights.get("file-find-current") === currentHl) CSS.highlights.delete("file-find-current");
  });

  function rangeIn(code, start, end) {
    const range = new Range();
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue.length;
      if (!started && start < offset + length) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && end <= offset + length) {
        range.setEnd(node, end - offset);
        return range;
      }
      offset += length;
    }
    return null;
  }

  // the first match not above the viewport, so a new query starts where the reader is
  function firstVisible() {
    const top = root.getBoundingClientRect().top;
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges[middle].getBoundingClientRect().bottom < top) low = middle + 1;
      else high = middle;
    }
    return low < ranges.length ? low : 0;
  }

  function reveal(range) {
    const rect = range.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (rect.top < view.top || rect.bottom > view.bottom) root.scrollTop += rect.top - view.top - view.height / 2 + rect.height / 2;
    if (rect.left < view.left || rect.right > view.right) root.scrollLeft += rect.left - view.left - view.width / 2;
  }

  function paint(scroll) {
    matchHl.clear();
    currentHl.clear();
    ranges.forEach((range, index) => (index === current ? currentHl : matchHl).add(range));
    if (scroll && ranges[current]) reveal(ranges[current]);
  }

  function search(keepPosition = false) {
    const previous = keepPosition ? current : -1;
    const q = query.toLowerCase();
    ranges = [];
    searchedLines = lines;
    if (q && root) {
      const rows = root.querySelectorAll(".pl-code");
      lines.forEach((line, index) => {
        const text = line.toLowerCase();
        for (let at = text.indexOf(q); at !== -1 && rows[index]; at = text.indexOf(q, at + q.length)) {
          const range = rangeIn(rows[index], at, at + q.length);
          if (range) ranges.push(range);
        }
      });
    }
    count = ranges.length;
    current = !count ? -1 : previous >= 0 ? Math.min(previous, count - 1) : firstVisible();
    paint(previous < 0);
  }

  // re-rendered rows detach the old ranges: colours arriving keep the position, another file starts over
  $effect(() => {
    const shown = lines;
    revision;
    if (!open || !untrack(() => query)) return;
    tick().then(() => search(shown === searchedLines));
  });

  function cycle(dir) {
    if (!count) return;
    current = (current + dir + count) % count;
    paint(true);
  }

  export async function show() {
    open = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  export function hide() {
    open = false;
    query = "";
    ranges = [];
    count = 0;
    current = -1;
    matchHl.clear();
    currentHl.clear();
    root?.focus({ preventScroll: true });
  }

  function onKeydown(e) {
    if (e.key === "Enter") cycle(e.shiftKey ? -1 : 1);
    else if (e.key === "Escape") hide();
    else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") inputEl.select();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if open}
  <div class="file-find">
    <input bind:this={inputEl} bind:value={query} oninput={() => search()} onkeydown={onKeydown} placeholder="Find" spellcheck="false" autocomplete="off" />
    <span class="count" class:none={query && !count}>{count ? `${current + 1}/${count}` : query ? "0" : ""}</span>
    <button class="nav" title="Previous match" aria-label="Previous match" disabled={!count} onclick={() => cycle(-1)}>
      <span aria-hidden="true">↑</span>
      {#if count}<Kbd keys={["shift", "enter"]} />{/if}
    </button>
    <button class="nav" title="Next match" aria-label="Next match" disabled={!count} onclick={() => cycle(1)}>
      <span aria-hidden="true">↓</span>
      {#if count}<Kbd keys="enter" />{/if}
    </button>
    <button class="nav" title="Close find" aria-label="Close find" onclick={hide}><Kbd keys="esc" /></button>
  </div>
{:else}
  <button class="nav find-open" title="Find in file" onclick={show}>Find <Kbd keys={["cmd", "f"]} /></button>
{/if}

<style>
  .file-find {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 1px 4px 1px 9px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
  }
  input {
    background: none;
    border: none;
    color: var(--text);
    font-family: var(--sans);
    font-size: 12.5px;
    width: 160px;
    outline: none;
  }
  .count {
    font-size: 11.5px;
    color: var(--text-faint);
    min-width: 34px;
    text-align: right;
  }
  .count.none {
    color: var(--fail);
  }
  .nav {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-width: 24px;
    min-height: 24px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 11.5px;
    cursor: pointer;
    padding: 2px 5px;
  }
  .nav:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .find-open {
    gap: 6px;
    min-height: 28px;
    padding: 0 6px;
    font-size: 12px;
  }
  @media (hover: hover) and (pointer: fine) {
    .nav:hover:not(:disabled) {
      background: var(--surface);
      color: var(--text);
    }
  }
</style>
