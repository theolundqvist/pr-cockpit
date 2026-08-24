<script>
  import DiffView from "./DiffView.svelte";
  import { parseDiff } from "./diff.js";
  import { fetchFileHistory, fetchFileHistoryDiff } from "./api.js";
  import { relativeTime } from "./time.js";
  import Kbd from "./Kbd.svelte";

  let { repo, path, base, baseSha = null, symbol = null, open = false, currentFile = null, currentPr, onClose, layout = "split" } = $props();

  let status = $state("loading");
  let commits = $state([]);
  let diffs = $state(new Map());
  let selectedIndex = $state(0);
  let railEl = $state(null);
  let loadToken;

  const noop = () => {};
  const emptyMap = new Map();
  const emptySet = new Set();

  function changedRowsMention(file, identifier) {
    if (!file) return false;
    if (!identifier) return true;
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`);
    return file.hunks.some((hunk) =>
      hunk.rows.some((row) => (row.type !== "context" || row.wsOnly) && pattern.test(row.text)),
    );
  }

  let entries = $derived([
    ...(changedRowsMention(currentFile, symbol)
      ? [{ sha: currentPr.sha, author: currentPr.author, date: currentPr.date, prNumber: currentPr.number, currentPr: true }]
      : []),
    ...commits,
  ]);
  let currentCol = $derived(
    currentFile
      ? {
          status: "ready",
          files: [currentFile],
          additions: currentFile.additions,
          deletions: currentFile.deletions,
        }
      : { status: "unavailable" },
  );
  let selected = $derived(entries[selectedIndex] ?? null);
  let selectedCol = $derived.by(() => {
    if (!selected) return null;
    if (!selected.currentPr) return diffs.get(selected.sha) ?? null;
    return currentCol;
  });

  function close() {
    onClose();
  }

  const MAX_HISTORY_FETCH_RETRIES = 15;

  async function loadHistory(token, args, attempt = 0) {
    try {
      const list = await fetchFileHistory(args.repo, args.path, args.base, args.symbol, args.baseSha);
      if (loadToken !== token) return;
      commits = list.filter((commit) => commit.sha !== args.currentPrSha);
      status = "ready";
      prefetchDiffs(commits, token);
    } catch (error) {
      if (loadToken !== token) return;
      if (error?.code === "fetching" && attempt < MAX_HISTORY_FETCH_RETRIES) {
        setTimeout(() => loadToken === token && loadHistory(token, args, attempt + 1), 800);
      } else {
        status = "error";
      }
    }
  }

  $effect(() => {
    if (!open) return;
    const token = {};
    loadToken = token;
    status = "loading";
    commits = [];
    diffs = new Map();
    selectedIndex = 0;
    loadHistory(token, { repo, path, base, symbol, baseSha, currentPrSha: currentPr.sha });
    return () => {
      loadToken = null;
    };
  });

  $effect(() => {
    if (!open || status !== "ready" || !selected || selected.currentPr) return;
    loadDiff(selected.sha);
  });

  $effect(() => {
    selectedIndex;
    if (!open || !railEl) return;
    requestAnimationFrame(() => railEl.querySelector(".fh-row.active")?.scrollIntoView({ block: "nearest" }));
  });

  function patchToFiles(entry) {
    const from = entry.previous_filename ?? path;
    const header =
      `diff --git a/${from} b/${path}\n` +
      (entry.status === "added" ? "new file mode 100644\n" : entry.status === "removed" ? "deleted file mode 100644\n" : "");
    return parseDiff(header + entry.patch);
  }

  async function loadDiff(sha) {
    if (diffs.has(sha)) return;
    const next = new Map(diffs);
    next.set(sha, { status: "loading" });
    diffs = next;
    let entry;
    try {
      const res = await fetchFileHistoryDiff(repo, sha, path, Boolean(symbol));
      if (res.notFound) {
        entry = { status: "unavailable" };
      } else if (res.localPatch != null) {
        const files = parseDiff(res.localPatch);
        entry = files.length
          ? {
              status: "ready",
              files,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            }
          : { status: "unavailable" };
      } else if (res.patch == null) {
        entry = { status: "unavailable" };
      } else {
        entry = {
          status: "ready",
          files: patchToFiles(res),
          additions: res.additions,
          deletions: res.deletions,
          previousFilename: res.previous_filename,
        };
      }
    } catch {
      entry = { status: "error" };
    }
    const after = new Map(diffs);
    after.set(sha, entry);
    diffs = after;
  }

  async function prefetchDiffs(list, token) {
    const queue = [...list];
    const worker = async () => {
      while (queue.length && loadToken === token) await loadDiff(queue.shift().sha);
    };
    await Promise.allSettled(Array.from({ length: 3 }, worker));
  }

  function move(delta) {
    selectedIndex = Math.max(0, Math.min(entries.length - 1, selectedIndex + delta));
  }

  $effect(() => {
    function onKey(e) {
      if (!open) return;
      if (e.key === "Escape") close();
      else if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  function displaySubject(subject) {
    return subject.replace(/\s*\(#\d+\)\s*$/, "");
  }
</script>

{#if open}
  <div class="fh-view">
    <div class="fh-head">
      <button class="fh-back" onclick={close}>← Back</button>
      <span class="fh-title">{symbol ? "History mentioning" : "History"} · {#if symbol}<span class="fh-symbol mono">{symbol}</span>{" · "}{/if}<span class="fh-path mono">{path}</span> on <span class="mono">{base}</span></span>
      <button class="fh-esc" onclick={close} aria-label="Close"><Kbd keys="esc" /></button>
    </div>

    {#if status === "loading"}
      <div class="fh-state">Loading history…</div>
    {:else if status === "error"}
      <div class="fh-state">Couldn’t load history.</div>
    {:else}
      <div class="fh-body">
        <div class="fh-rail" bind:this={railEl}>
          {#each entries as commit, i (commit.sha)}
            {@const col = commit.currentPr ? currentCol : diffs.get(commit.sha)}
            <button class="fh-row" class:active={i === selectedIndex} class:current={commit.currentPr} onclick={() => (selectedIndex = i)}>
              <span class="fh-spine"><span class="fh-dot"></span></span>
              <span class="fh-row-body">
                <span class="fh-row-title">
                  {#if commit.currentPr}
                    <span class="fh-row-subject fh-current-label">this PR</span>
                    <span class="fh-chip">#{commit.prNumber}</span>
                  {:else if commit.prNumber}
                    <span class="fh-row-subject link">{displaySubject(commit.subject)}</span>
                    <span class="fh-chip">#{commit.prNumber}</span>
                  {:else}
                    <span class="fh-row-subject">{commit.subject}</span>
                    <span class="fh-chip">{commit.sha.slice(0, 7)}</span>
                  {/if}
                </span>
                <span class="fh-row-meta">
                  <span class="fh-author">{commit.author}</span>
                  <span class="fh-dim">·</span>
                  <span>{relativeTime(commit.date)}</span>
                  {#if col?.status === "ready"}
                    <span class="fh-add">+{col.additions}</span>
                    <span class="fh-del">−{col.deletions}</span>
                  {/if}
                </span>
              </span>
            </button>
          {/each}
        </div>

        <div class="fh-detail">
          {#if selected}
            <div class="fh-detail-head">
              <div class="fh-detail-title">
                {#if selected.currentPr}
                  <span class="fh-detail-subject">{currentPr.title}</span>
                  <span class="fh-chip fh-current-chip">this PR · #{selected.prNumber}</span>
                {:else if selected.prNumber}
                  <a class="fh-link" href="#/pr/{repo}/{selected.prNumber}">{displaySubject(selected.subject)}</a>
                  <span class="fh-chip">#{selected.prNumber}</span>
                {:else}
                  <span class="fh-detail-subject">{selected.subject}</span>
                  <a class="fh-link" href="https://github.com/{repo}/commit/{selected.sha}" target="_blank" rel="noopener">{selected.sha.slice(0, 7)}</a>
                {/if}
              </div>
              <div class="fh-detail-meta">
                <span class="fh-author">{selected.author}</span>
                <span class="fh-dim">·</span>
                <span>{relativeTime(selected.date)}</span>
                {#if selectedCol?.status === "ready"}
                  <span class="fh-add">+{selectedCol.additions}</span>
                  <span class="fh-del">−{selectedCol.deletions}</span>
                {/if}
                {#if selectedCol?.status === "ready" && selectedCol.previousFilename}
                  <span class="fh-renamed">renamed from {selectedCol.previousFilename}</span>
                {/if}
              </div>
            </div>
            <div class="fh-diff">
              {#if !selectedCol || selectedCol.status === "loading"}
                <div class="fh-skeleton"></div>
              {:else if selectedCol.status === "ready"}
                <DiffView
                  files={selectedCol.files}
                  anchored={emptyMap}
                  threadProps={noop}
                  collapsed={emptySet}
                  onToggleFile={noop}
                  {repo}
                  headSha={selected.sha}
                  pendingInline={[]}
                  commentable={false}
                  onInlineComment={noop}
                  onRetryMutation={noop}
                  onDiscardMutation={noop}
                  {layout}
                />
              {:else}
                <div class="fh-state">Diff unavailable</div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
      <div class="fh-keybar">
        <span><kbd>j</kbd><kbd>k</kbd> move</span>
        <span class="fh-dim">·</span>
        <span><kbd>esc</kbd> back</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .fh-view {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .fh-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 49px;
    padding: 10px 20px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border);
  }
  :global(.app-shell.shell) .fh-head {
    padding-left: 84px;
  }
  .fh-back {
    flex: none;
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: 12.5px;
    cursor: pointer;
    padding: 0;
    -webkit-app-region: no-drag;
  }
  .fh-back:hover {
    color: var(--text-dim);
  }
  .fh-title {
    flex: 1;
    font-size: 12.5px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fh-path {
    color: var(--text);
    font-weight: 600;
  }
  .fh-esc {
    flex: none;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .fh-state {
    padding: 24px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .fh-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .fh-rail {
    flex: none;
    width: 300px;
    min-height: 0;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    padding: 8px 0;
  }
  .fh-row {
    display: grid;
    grid-template-columns: 28px 1fr;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 10px 16px 10px 0;
  }
  .fh-row.active {
    background: var(--link-bg);
    box-shadow: inset 2px 0 var(--link);
  }
  .fh-row:hover:not(.active) {
    background: var(--surface);
  }
  .fh-spine {
    position: relative;
  }
  .fh-spine::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    transform: translateX(-0.5px);
  }
  .fh-row:first-child .fh-spine::before {
    top: 18px;
  }
  .fh-row:last-child .fh-spine::before {
    bottom: calc(100% - 18px);
  }
  .fh-dot {
    position: absolute;
    left: 50%;
    top: 18px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 2px solid var(--text-faint);
    background: var(--bg);
    transform: translate(-50%, -50%);
  }
  .fh-row.active .fh-dot {
    border-color: var(--link);
    background: var(--link);
  }
  .fh-row.current .fh-dot {
    border-color: var(--link);
  }
  .fh-row-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .fh-row-title {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .fh-row-subject {
    color: var(--text);
    font-size: 12.5px;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .fh-row-subject.link {
    color: var(--link);
  }
  .fh-row.active .fh-row-subject.link {
    color: var(--link);
    font-weight: 600;
  }
  .fh-current-label {
    color: var(--link);
    font-weight: 600;
  }
  .fh-row-meta {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11px;
    color: var(--text-faint);
  }
  .fh-chip {
    flex: none;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 11px;
  }
  .fh-row.current .fh-chip,
  .fh-current-chip {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text-dim);
  }
  .fh-author {
    color: var(--text-dim);
  }
  .fh-dim {
    color: var(--text-faint);
  }
  .fh-add {
    color: var(--ready);
  }
  .fh-del {
    color: var(--fail);
  }
  .fh-renamed {
    color: var(--text-faint);
    font-style: italic;
  }
  .fh-detail {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .fh-detail-head {
    flex: none;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fh-detail-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .fh-link {
    color: var(--link);
    text-decoration: none;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fh-link:hover {
    text-decoration: underline;
  }
  .fh-detail-subject {
    color: var(--text);
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fh-detail-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .fh-diff {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px 20px;
  }
  .fh-skeleton {
    height: 220px;
    border-radius: 10px;
    background: linear-gradient(90deg, var(--surface) 0%, var(--panel-raised) 50%, var(--surface) 100%);
    background-size: 200% 100%;
    animation: fh-shimmer 1.4s ease-in-out infinite;
  }
  @keyframes fh-shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }
  .fh-keybar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 39px;
    padding: 10px 20px;
    box-sizing: border-box;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .fh-keybar kbd {
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 500;
    color: color-mix(in srgb, var(--text-dim) 80%, transparent);
    background: color-mix(in srgb, var(--surface-hover) 50%, transparent);
    border: 0;
    border-radius: 6px;
    padding: 0 6px;
    margin-right: 2px;
  }
</style>
