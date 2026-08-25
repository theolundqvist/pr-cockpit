<script>
  import { tick } from "svelte";
  import { fetchInbox, fetchPrIndex, searchPrs } from "./api.js";
  import { isTypingTarget } from "./dom.js";
  import { isRecordingShortcut } from "./shortcutCapture.js";
  import { prKey } from "./prKey.js";
  import Kbd from "./Kbd.svelte";

  let { standalone = false } = $props();

  let open = $state(standalone);
  let query = $state("");
  let cached = $state([]);
  let indexed = $state([]);
  let live = $state([]);
  let selected = $state(0);
  let inputEl = $state(null);
  let searchToken;

  const repoTail = (repo) => repo.split("/")[1] ?? repo;

  function stateChip(state, isDraft) {
    if (isDraft) return { label: "draft", tone: "wait" };
    const s = state.toUpperCase();
    if (s === "MERGED") return { label: "merged", tone: "merged" };
    if (s === "CLOSED") return { label: "closed", tone: "closed" };
    return { label: "open", tone: "ready" };
  }

  const RANK_TONE = ["fail", "review", "ready", "wait"];

  const matches = (hay, tokens) => tokens.every((t) => hay.includes(t));

  let instant = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/\s+/);
    const rows = q
      ? cached.filter((pr) => matches(`${pr.title} ${pr.number} ${pr.headRef}`.toLowerCase(), tokens))
      : cached;
    return rows.slice(0, 20).map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      chip: stateChip(pr.state, pr.isDraft),
      rankTone: RANK_TONE[pr.needsMeRank],
    }));
  });

  let indexInstant = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    return indexed
      .filter((pr) => matches(`${pr.title} ${pr.number} ${pr.author}`.toLowerCase(), tokens))
      .slice(0, 20)
      .map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        chip: stateChip(pr.state, pr.isDraft),
        rankTone: null,
      }));
  });

  let results = $derived.by(() => {
    const seen = new Set();
    const merged = [];
    for (const row of [...instant, ...indexInstant]) {
      const key = prKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    for (const hit of live) {
      const key = prKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ repo: hit.repo, number: hit.number, title: hit.title, chip: stateChip(hit.state, false), rankTone: null });
    }
    return merged;
  });

  $effect(() => {
    query;
    selected = 0;
  });

  $effect(() => {
    const q = query.trim();
    if (!open || !q) {
      searchToken = {};
      live = [];
      return;
    }
    const token = {};
    searchToken = token;
    const timer = setTimeout(async () => {
      try {
        const hits = await searchPrs(q);
        if (searchToken === token) live = hits;
      } catch {
        if (searchToken === token) live = [];
      }
    }, 400);
    return () => clearTimeout(timer);
  });

  let onInbox = $state(!/^#\/(pr|settings)\b/.test(location.hash));
  $effect(() => {
    const sync = () => (onInbox = !/^#\/(pr|settings)\b/.test(location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  });

  async function openPalette() {
    open = true;
    query = "";
    live = [];
    selected = 0;
    held = "none";
    fetchInbox()
      .then((res) => (cached = res.prs))
      .catch(() => (cached = []));
    fetchPrIndex()
      .then((rows) => (indexed = rows))
      .catch(() => (indexed = []));
    await tick();
    inputEl?.focus();
  }

  function close() {
    if (standalone) {
      location.hash = "#/palette/close";
      return;
    }
    open = false;
  }

  $effect(() => {
    const onOpen = () => openPalette();
    window.addEventListener("cockpit:open-palette", onOpen);
    return () => window.removeEventListener("cockpit:open-palette", onOpen);
  });

  $effect(() => {
    if (!standalone) return;
    document.documentElement.classList.add("palette-standalone-page");
    document.body.classList.add("palette-standalone-page");
    openPalette();
    return () => {
      document.documentElement.classList.remove("palette-standalone-page");
      document.body.classList.remove("palette-standalone-page");
    };
  });

  function choose(result) {
    if (standalone) {
      location.hash = `#/palette/go/${result.repo}/${result.number}`;
      return;
    }
    location.hash = `#/pr/${result.repo}/${result.number}`;
    close();
  }

  function chooseInNewWindow(result) {
    if (standalone) {
      location.hash = `#/palette/window/${result.repo}/${result.number}`;
      return;
    }
    const hash = `#/pr/${result.repo}/${result.number}`;
    if (window.cockpitShell?.openWindow) window.cockpitShell.openWindow(hash);
    else window.open(`${location.pathname}${hash}`, "_blank");
    close();
  }

  function chooseOnGithub(result) {
    if (standalone) {
      location.hash = `#/palette/github/${result.repo}/${result.number}`;
      return;
    }
    window.open(`https://github.com/${result.repo}/pull/${result.number}`, "_blank", "noopener");
    close();
  }

  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      document.querySelectorAll(".palette-result")[selected]?.scrollIntoView({ block: "nearest" });
    });
  }

  $effect(() => {
    function onKey(e) {
      if (isRecordingShortcut()) return; // a ShortcutInput is capturing this key
      if (!open) {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
          e.preventDefault();
          openPalette();
        } else if (e.key === "/" && !isTypingTarget(e.target) && !onInbox) {
          e.preventDefault();
          openPalette();
        }
        return;
      }
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowDown") {
        selected = Math.min(results.length - 1, selected + 1);
        scrollSelectedIntoView();
      } else if (e.key === "ArrowUp") {
        selected = Math.max(0, selected - 1);
        scrollSelectedIntoView();
      } else if (e.key === "Enter") {
        const result = results[selected];
        if (result) {
          if (e.shiftKey) chooseInNewWindow(result);
          else if (e.metaKey || e.ctrlKey) chooseOnGithub(result);
          else choose(result);
        }
      } else {
        return;
      }
      e.stopImmediatePropagation();
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // the hint row names the action the held modifier will take, so ⇧ and ⌘ are discoverable
  let held = $state("none");
  $effect(() => {
    if (!open) return;
    const sync = (e) => (held = e.shiftKey ? "shift" : e.metaKey || e.ctrlKey ? "meta" : "none");
    const clear = () => (held = "none");
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  });
  let enterKeys = $derived(held === "shift" ? "shift+enter" : held === "meta" ? "cmd+enter" : "enter");
</script>

{#if open}
  <div class="scrim" class:standalone onmousedown={close}>
    <div class="palette" class:standalone onmousedown={(e) => e.stopPropagation()}>
      {#if standalone}
        <div class="palette-standalone-head">Find PR</div>
      {/if}
      <div class="palette-input-row">
        <svg class="palette-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 4 4" />
        </svg>
        <input
          class="palette-input"
          bind:this={inputEl}
          bind:value={query}
          placeholder="PR, branch, or #"
          spellcheck="false"
          autocomplete="off"
        />
        {#if standalone}<span class="palette-esc">esc</span>{/if}
      </div>
      <div class="palette-results">
        {#each results as result, i (prKey(result))}
          <button
            class="palette-result"
            data-pr-key={prKey(result)}
            class:active={i === selected}
            onmouseenter={() => (selected = i)}
            onclick={() => choose(result)}
          >
            <span class="pr-chip badge {result.chip.tone}">{result.chip.label}</span>
            <span class="pr-title">{result.title}</span>
            <span class="pr-ref mono">{repoTail(result.repo)}#{result.number}</span>
            {#if result.rankTone}
              <span class="pr-rank {result.rankTone}"></span>
            {/if}
            {#if i === selected}<Kbd keys={enterKeys} />{/if}
          </button>
        {:else}
          <div class="palette-empty">{query.trim() ? "No matching PRs" : ""}</div>
        {/each}
      </div>
      {#if results.length}
        <div class="palette-hint">
          <span class="hint" class:on={held === "none"}><Kbd keys="enter" />open</span>
          <span class="hint" class:on={held === "shift"}><Kbd keys="shift+enter" />new window</span>
          <span class="hint" class:on={held === "meta"}><Kbd keys="cmd+enter" />github</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--modal-scrim);
    backdrop-filter: blur(4px) saturate(85%);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 50;
  }
  .scrim.standalone {
    align-items: center;
    padding: 56px 32px;
    background: transparent;
  }
  :global(html.palette-standalone-page),
  :global(body.palette-standalone-page) {
    background: transparent;
  }
  .palette {
    width: 100%;
    max-width: 640px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
  .palette.standalone {
    width: min(860px, 100%);
    max-width: 860px;
    max-height: min(720px, calc(var(--general-height) - 112px));
    height: auto;
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 12px 28px rgb(0 0 0 / 0.16), 0 2px 6px rgb(0 0 0 / 0.1);
  }
  .palette.standalone .palette-results {
    max-height: min(540px, calc(var(--general-height) - 288px));
  }
  .palette-input {
    width: 100%;
    box-sizing: border-box;
    background: none;
    border: none;
    border: none;
    color: var(--text);
    font-size: 14px;
    padding: 15px 0;
  }
  .palette-input:focus {
    outline: none;
  }
  .palette-input::placeholder {
    color: var(--text-faint);
  }
  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
  }
  .palette-search-icon {
    flex: none;
    width: 17px;
    height: 17px;
    color: var(--text-faint);
  }
  .palette-esc {
    flex: none;
    padding: 3px 5px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 9.5px;
  }
  .palette-standalone-head {
    padding: 18px 18px 10px;
    color: var(--text);
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .palette-results {
    max-height: 52vh;
    overflow-y: auto;
    padding: 6px;
  }
  .palette-hint {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 9px 14px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 5px;
    opacity: 0.5;
    transition: opacity 110ms ease, color 110ms ease;
  }
  .hint.on {
    opacity: 1;
    color: var(--text);
  }
  .palette-result {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 7px;
    padding: 8px 10px;
    cursor: pointer;
    color: inherit;
  }
  .palette-result.active {
    background: var(--panel-raised);
  }
  .pr-chip {
    flex: none;
    min-width: 58px;
    justify-content: center;
  }
  .pr-title {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pr-ref {
    flex: none;
    font-size: 12px;
    color: var(--text-faint);
  }
  .pr-rank {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .pr-rank.fail {
    background: var(--fail);
  }
  .pr-rank.review {
    background: var(--review);
  }
  .pr-rank.ready {
    background: var(--ready);
  }
  .pr-rank.wait {
    background: var(--wait);
  }
  .palette-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12.5px;
  }

  .palette {
    background: var(--panel);
    border-color: var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow-dialog);
  }
  .palette-input {
    min-height: 56px;
    padding: 0;
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.012em;
  }
  .palette-results {
    padding: 8px;
  }
  .palette-result {
    min-height: 44px;
    gap: 12px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 9px;
  }
  @media (hover: hover) and (pointer: fine) {
    .palette-result:hover {
      background: var(--surface);
    }
  }
  .palette-result.active {
    background: var(--link-bg);
    border-color: transparent;
    box-shadow: none;
  }
  .pr-title {
    font-size: 13.5px;
    font-weight: 500;
    letter-spacing: 0;
  }
  .pr-ref {
    font-size: 11.5px;
  }
  @media (max-width: 620px) {
    .scrim.standalone {
      align-items: flex-start;
      padding: 28px 14px;
    }
    .palette.standalone {
      max-height: calc(var(--general-height) - 56px);
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .scrim {
      backdrop-filter: none;
    }
  }
</style>
