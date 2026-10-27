<script module>
  const findSources = new Set();
  let refreshFind = null;

  // A source searches content it may not have rendered: `search(query)` returns `{ count, at(n),
  // indexOf(match) }`, `ranges(result)` the `{ n, range }` pairs currently in the DOM, and
  // `reveal(match)` mounts a match and returns its range. Its root element is left out of the DOM walk.
  export function registerFindSource(source) {
    findSources.add(source);
    refreshFind?.();
    return {
      changed: () => refreshFind?.(),
      remove() {
        findSources.delete(source);
        refreshFind?.();
      },
    };
  }
</script>

<script>
  import { cancelHoldScroll } from "./scroll.js";
  import Kbd from "./Kbd.svelte";

  let open = $state(false);
  let query = $state("");
  let current = $state(-1);
  let count = $state(0);
  let inputEl;
  let segments = [];
  let revealing = 0;
  let refreshFrame = 0;
  const rootObserver = new MutationObserver(scheduleRefresh);

  const matchHl = new Highlight();
  const currentHl = new Highlight();
  CSS.highlights.set("find-match", matchHl);
  CSS.highlights.set("find-current", currentHl);

  function clearHighlights() {
    matchHl.clear();
    currentHl.clear();
  }

  function centerInScrollAncestors(range) {
    let node = range.startContainer.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const rect = range.getBoundingClientRect();
      const containerRect = node.getBoundingClientRect();
      if (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(style.overflowY)) {
        node.scrollTop += rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2;
      }
      if (node.scrollWidth > node.clientWidth && /(auto|scroll)/.test(style.overflowX) && (rect.left < containerRect.left || rect.right > containerRect.right)) {
        node.scrollLeft += rect.left - containerRect.left - containerRect.width / 2 + rect.width / 2;
      }
      node = node.parentElement;
    }
  }

  function collect() {
    segments = [];
    rootObserver.disconnect();
    const q = query.toLowerCase();
    const root = document.querySelector(".page");
    if (!q || !root) return;
    const sources = new Map();
    for (const source of findSources) {
      const sourceRoot = source.root();
      if (sourceRoot && root.contains(sourceRoot)) sources.set(sourceRoot, source);
    }
    let ranges = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (node.classList.contains("find-bar")) return NodeFilter.FILTER_REJECT;
        const source = sources.get(node);
        if (!source) return NodeFilter.FILTER_SKIP;
        segments.push({ ranges, count: ranges.length });
        const result = source.search(q);
        segments.push({ source, result, count: result.count });
        rootObserver.observe(node, { childList: true, subtree: true, characterData: true });
        ranges = [];
        return NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue.toLowerCase();
      let i = text.indexOf(q);
      while (i !== -1) {
        const range = new Range();
        range.setStart(node, i);
        range.setEnd(node, i + q.length);
        ranges.push(range);
        i = text.indexOf(q, i + q.length);
      }
    }
    segments.push({ ranges, count: ranges.length });
    count = segments.reduce((sum, segment) => sum + segment.count, 0);
  }

  function currentMatch() {
    let n = current;
    for (const segment of segments) {
      if (n < segment.count) return segment.ranges ? { range: segment.ranges[n] } : { source: segment.source, match: segment.result.at(n) };
      n -= segment.count;
    }
    return null;
  }

  function currentRange() {
    const found = currentMatch();
    return found?.source ? found.source.reveal(found.match) : (found?.range ?? null);
  }

  function indexOfMatch(found) {
    let offset = 0;
    for (const segment of segments) {
      const n = segment.ranges
        ? segment.ranges.findIndex((range) => range.startContainer === found.range?.startContainer && range.startOffset === found.range.startOffset)
        : segment.source === found.source ? segment.result.indexOf(found.match) : -1;
      if (n >= 0) return offset + n;
      offset += segment.count;
    }
    return -1;
  }

  function repaint() {
    matchHl.clear();
    currentHl.clear();
    let offset = 0;
    for (const segment of segments) {
      if (segment.ranges) segment.ranges.forEach((range, n) => (offset + n === current ? currentHl : matchHl).add(range));
      else for (const { n, range } of segment.source.ranges(segment.result)) (offset + n === current ? currentHl : matchHl).add(range);
      offset += segment.count;
    }
  }

  // Rows mounting around a revealed match shift it for a few frames; follow it until the reader scrolls.
  function paint() {
    const token = ++revealing;
    const range = currentRange();
    repaint();
    if (!range) return;
    cancelHoldScroll(document.querySelector(".page"));
    centerInScrollAncestors(range);
    let frames = 12;
    let top = range.getBoundingClientRect().top;
    const follow = () => {
      if (token !== revealing || --frames < 0) return;
      const next = currentRange();
      if (!next) return;
      if (next.getBoundingClientRect().top !== top) {
        centerInScrollAncestors(next);
        top = next.getBoundingClientRect().top;
      }
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }

  function search() {
    collect();
    current = count ? 0 : -1;
    paint();
  }

  function scheduleRefresh() {
    if (!refreshFrame) refreshFrame = requestAnimationFrame(refresh);
  }

  // Mounting and unmounting changes which diff text is in the DOM; the current match keeps its place.
  function refresh() {
    refreshFrame = 0;
    if (!open || !query) return;
    const found = currentMatch();
    collect();
    const n = found ? indexOfMatch(found) : -1;
    current = count ? (n >= 0 ? n : Math.min(Math.max(current, 0), count - 1)) : -1;
    repaint();
  }

  function cycle(dir) {
    if (!count) return;
    current = (current + dir + count) % count;
    paint();
  }

  function focusInput() {
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  function close() {
    open = false;
    query = "";
    segments = [];
    count = 0;
    current = -1;
    revealing++;
    rootObserver.disconnect();
    clearHighlights();
  }

  $effect(() => {
    refreshFind = scheduleRefresh;
    const takeOver = () => revealing++;
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (open) focusInput();
        else {
          open = true;
          focusInput();
        }
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", takeOver, { passive: true });
    window.addEventListener("touchstart", takeOver, { passive: true });
    return () => {
      refreshFind = null;
      cancelAnimationFrame(refreshFrame);
      rootObserver.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", takeOver);
      window.removeEventListener("touchstart", takeOver);
      clearHighlights();
    };
  });
</script>

{#if open}
  <div class="find-bar">
    <input bind:this={inputEl} bind:value={query} oninput={search} placeholder="Find" spellcheck="false" autocomplete="off" />
    <span class="count" class:none={query && !count}>{count ? `${current + 1}/${count}` : query ? "0" : ""}</span>
    <button class="nav" title="Previous match" aria-label="Previous match" disabled={!count} onclick={() => cycle(-1)}>
      <span aria-hidden="true">↑</span>
      {#if count}<Kbd keys={["shift", "enter"]} />{/if}
    </button>
    <button class="nav" title="Next match" aria-label="Next match" disabled={!count} onclick={() => cycle(1)}>
      <span aria-hidden="true">↓</span>
      {#if count}<Kbd keys="enter" />{/if}
    </button>
    <button class="nav" title="Close" aria-label="Close" onclick={close}><Kbd keys="esc" /></button>
  </div>
{/if}

<style>
  .find-bar {
    position: fixed;
    top: 14px;
    right: 18px;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--overlay-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 8px;
    backdrop-filter: blur(8px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 11.5px;
    cursor: pointer;
    padding: 2px 5px;
    border-radius: 4px;
  }
  .nav:hover {
    background: var(--panel-raised);
    color: var(--text);
  }

  .find-bar {
    top: 18px;
    right: 24px;
    gap: 7px;
    padding: 7px 9px;
    background: var(--panel);
    border-color: var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-dialog);
    backdrop-filter: blur(18px) saturate(160%);
  }
  .nav {
    min-width: 24px;
    min-height: 24px;
    border-radius: 6px;
  }
  .nav:disabled {
    opacity: 0.4;
    cursor: default;
  }
  @media (hover: hover) and (pointer: fine) {
    .nav:hover {
      background: var(--surface);
    }
  }
</style>
