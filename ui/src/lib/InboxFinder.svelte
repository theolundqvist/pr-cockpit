<script>
  import { tick } from "svelte";
  import { repoBranches } from "./api.js";
  import { isPromptDialogOpen } from "./dom.js";
  import { fuzzyMatch } from "./fuzzy.js";
  import { matchRuns, positionRanges } from "./matchRuns.js";
  import Kbd from "./Kbd.svelte";
  import Telescope from "./Telescope.svelte";

  // Outside a PR, Cmd+P and Cmd+Shift+F first pick a tracked repository and one of its branches.
  let { repos, active } = $props();

  const MAX_ROWS = 200;
  const BRANCH_RETRY_MS = 800;

  let mode = $state("files");
  let step = $state(null); // "repo" | "branch" while picking
  let query = $state("");
  let selected = $state(0);
  let repo = $state(null);
  let branchList = $state({ status: "loading", branches: [] });
  let target = $state(null); // { repo, branch, sha } the browser shows
  let telescope = $state(null);
  let telescopeOpen = $state(false);
  let inputEl = $state(null);
  let branchToken = null;

  let rows = $derived.by(() => {
    const items = step === "repo"
      ? repos.map((name) => ({ name, value: name }))
      : step === "branch" ? branchList.branches.map((branch) => ({ name: branch.name, value: branch })) : [];
    const q = query.trim();
    if (!q) return items.slice(0, MAX_ROWS).map((item) => ({ ...item, ranges: [] }));
    return items
      .map((item) => ({ item, match: fuzzyMatch(q, item.name) }))
      .filter((entry) => entry.match)
      .sort((left, right) => right.match.score - left.match.score)
      .slice(0, MAX_ROWS)
      .map(({ item, match }) => ({ ...item, ranges: positionRanges(match.positions) }));
  });

  let emptyText = $derived.by(() => {
    if (step === "repo") return repos.length ? "No matching repositories" : "No tracked repositories";
    if (branchList.status === "loading") return "Loading branches…";
    if (branchList.status === "fetching") return "Fetching the repository…";
    if (branchList.status === "fetch-failed") return "Couldn't fetch the repository";
    if (branchList.status !== "ok") return "Couldn't list branches";
    return query.trim() ? "No matching branches" : "No branches";
  });

  $effect(() => {
    if (active) return;
    step = null;
    telescopeOpen = false;
    branchToken = null;
  });

  async function focusInput() {
    await tick();
    inputEl?.focus();
  }

  function start(nextMode) {
    mode = nextMode;
    if (repos.length === 1) {
      pickRepo(repos[0]);
      return;
    }
    step = "repo";
    query = "";
    selected = Math.max(0, repos.indexOf(repo));
    branchToken = null;
    focusInput();
  }

  function pickRepo(name, preferredBranch = null) {
    repo = name;
    step = "branch";
    query = "";
    selected = 0;
    loadBranches(name, preferredBranch);
    focusInput();
  }

  async function loadBranches(name, preferredBranch) {
    const token = {};
    branchToken = token;
    branchList = { status: "loading", branches: [] };
    while (branchToken === token) {
      try {
        const res = await repoBranches(name);
        if (branchToken !== token) return;
        if (res.status !== "fetching") {
          branchList = { status: res.status, branches: res.branches ?? [] };
          if (preferredBranch && !query.trim()) selected = Math.max(0, branchList.branches.findIndex((branch) => branch.name === preferredBranch));
          return;
        }
        branchList = { status: "fetching", branches: [] };
      } catch {
        if (branchToken === token) branchList = { status: "error", branches: [] };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, BRANCH_RETRY_MS));
    }
  }

  async function choose(row) {
    if (!row) return;
    if (step === "repo") {
      pickRepo(row.value);
      return;
    }
    step = null;
    branchToken = null;
    target = { repo, branch: row.value.name, sha: row.value.sha };
    await tick();
    telescope?.activate(mode);
  }

  function back() {
    if (step === "branch" && repos.length > 1) {
      step = "repo";
      query = "";
      selected = Math.max(0, repos.indexOf(repo));
      branchToken = null;
      focusInput();
    } else {
      step = null;
      branchToken = null;
    }
  }

  function close() {
    step = null;
    branchToken = null;
  }

  function move(delta) {
    if (!rows.length) return;
    selected = Math.max(0, Math.min(rows.length - 1, selected + delta));
    requestAnimationFrame(() => document.querySelector(".finder-row.active")?.scrollIntoView({ block: "nearest" }));
  }

  $effect(() => {
    if (!active) return;
    function onKey(e) {
      if (isPromptDialogOpen() || telescopeOpen) return;
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (meta && !e.altKey && ((e.shiftKey && key === "f") || (!e.shiftKey && key === "p"))) start(e.shiftKey ? "search" : "files");
      else if (!step) return;
      else if (e.key === "Escape") back();
      else if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "Enter") choose(rows[selected]);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

{#if step}
  <div class="finder-scrim" onmousedown={close} role="presentation">
    <div class="finder" role="dialog" tabindex="-1" aria-label={step === "repo" ? "Choose a repository" : "Choose a branch"} onmousedown={(e) => e.stopPropagation()}>
      <div class="finder-head">
        <span class="finder-mode">{mode === "files" ? "Go to file" : "Search in files"}</span>
        {#if step === "branch"}<span class="finder-crumb mono">{repo}</span>{/if}
      </div>
      <input
        class="finder-input"
        bind:this={inputEl}
        bind:value={query}
        oninput={() => (selected = 0)}
        placeholder={step === "repo" ? "Repository…" : "Branch…"}
        spellcheck="false"
        autocomplete="off"
      />
      <div class="finder-list">
        {#each rows as row, i (row.name)}
          <button class="finder-row" class:active={i === selected} onpointermove={() => (selected = i)} onclick={() => choose(row)}>
            <span class="finder-name mono"
              >{#each matchRuns([{ content: row.name }], row.ranges) as run}{#if run.hit}<mark>{run.content}</mark>{:else}{run.content}{/if}{/each}</span
            >
            {#if step === "branch"}
              {#if row.value.default}<span class="badge wait">default</span>{/if}
              <span class="finder-sha mono">{row.value.sha.slice(0, 7)}</span>
            {/if}
            {#if i === selected}<Kbd keys="enter" />{/if}
          </button>
        {:else}
          <div class="finder-empty">{emptyText}</div>
        {/each}
      </div>
      <div class="finder-hint">
        <span><Kbd keys="enter" />{step === "repo" ? "choose branch" : mode === "files" ? "find files" : "search code"}</span>
        <span><Kbd keys="esc" />{step === "branch" && repos.length > 1 ? "repositories" : "close"}</span>
      </div>
    </div>
  </div>
{/if}

{#if target}
  <Telescope
    bind:this={telescope}
    repo={target.repo}
    headSha={target.sha}
    headRef={target.branch}
    context="{target.repo} · {target.branch}"
    hotkeys={false}
    onBack={() => pickRepo(target.repo, target.branch)}
    bind:open={telescopeOpen}
  />
{/if}

<style>
  .finder-scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: var(--modal-scrim);
    backdrop-filter: blur(4px) saturate(85%);
  }
  .finder {
    width: 100%;
    max-width: 560px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
  }
  .finder-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 14px 16px 0;
    font-size: 12px;
  }
  .finder-mode {
    color: var(--text-dim);
    font-weight: 600;
  }
  .finder-crumb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .finder-input {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 0 16px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 500;
  }
  .finder-input:focus {
    outline: none;
  }
  .finder-input::placeholder {
    color: var(--text-faint);
  }
  .finder-list {
    max-height: 52vh;
    overflow-y: auto;
    padding: 8px;
  }
  .finder-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 38px;
    padding: 6px 10px;
    text-align: left;
    background: none;
    border: none;
    border-radius: 9px;
    color: inherit;
    cursor: pointer;
  }
  .finder-row.active {
    background: var(--link-bg);
  }
  .finder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text);
  }
  .finder-name mark {
    background: none;
    color: var(--link);
    font-weight: 600;
  }
  .finder-sha {
    flex: none;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .finder-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .finder-hint {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 9px 14px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .finder-hint span {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  @media (prefers-reduced-transparency: reduce) {
    .finder-scrim {
      backdrop-filter: none;
    }
  }
</style>
