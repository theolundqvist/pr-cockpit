<script>
  import { cancelHoldScroll } from "./scroll.js";
  import Kbd from "./Kbd.svelte";

  let open = $state(false);
  let query = $state("");
  let current = $state(-1);
  let count = $state(0);
  let inputEl;
  let matches = [];

  const matchHl = new Highlight();
  const currentHl = new Highlight();
  CSS.highlights.set("find-match", matchHl);
  CSS.highlights.set("find-current", currentHl);

  function clearHighlights() {
    matchHl.clear();
    currentHl.clear();
  }

  function centerInScrollAncestors(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
        const rect = el.getBoundingClientRect();
        const containerRect = node.getBoundingClientRect();
        node.scrollTop += rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2;
      }
      node = node.parentElement;
    }
  }

  function paint() {
    matchHl.clear();
    currentHl.clear();
    matches.forEach((r, i) => (i === current ? currentHl : matchHl).add(r));
    const el = matches[current]?.startContainer.parentElement;
    if (el) {
      cancelHoldScroll(document.querySelector(".page"));
      centerInScrollAncestors(el);
    }
  }

  function search() {
    matches = [];
    current = -1;
    const q = query.toLowerCase();
    const root = document.querySelector(".page");
    if (q && root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest(".find-bar")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
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
          matches.push(range);
          i = text.indexOf(q, i + q.length);
        }
      }
    }
    count = matches.length;
    if (count) current = 0;
    paint();
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
    matches = [];
    count = 0;
    current = -1;
    clearHighlights();
  }

  $effect(() => {
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
    return () => {
      window.removeEventListener("keydown", onKey);
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
