<script module>
  // Resolutions outlive the editor, so closing it or reloading after the head moved keeps every
  // file whose conflicted text is unchanged. Only the last PR's session is kept.
  let savedSession = null;
</script>

<script>
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import CodeEditor from "./CodeEditor.svelte";
  import GithubSetupModal from "./GithubSetupModal.svelte";
  import { commitConflictMerge, fetchConflictMerge } from "./api.js";
  import { conflictEditing, findConflicts, hasConflictMarkers, jumpToConflict } from "./conflictMarkers.js";
  import { isTypingTarget } from "./dom.js";
  import { normalizeFileEndings } from "./fileEndings.js";

  let { repo, number, initialPath, headOid, onClose, onCommitted } = $props();

  const sessionKey = `${repo}#${number}`;
  let merge = $state(null);
  let loadState = $state("loading");
  let loadError = $state("");
  let activePath = $state(initialPath);
  let openLine = $state(1);
  let committing = $state(false);
  let commitError = $state("");
  let staleHead = $state(false);
  let githubSetup = $state(null);
  let view = $state(null);
  let committed = false;
  let request = 0;
  const drafts = new SvelteMap();
  const originals = new Map();
  const lineEndings = new Map();

  let files = $derived(
    (merge?.files ?? []).map((file) => {
      const draft = drafts.get(file.path);
      if (draft === undefined) return { path: file.path, unsupported: file.unsupported ?? "Mixed line endings can't be edited here." };
      return { path: file.path, conflicts: findConflicts(draft.split("\n")).length, resolved: !hasConflictMarkers(draft) };
    }),
  );
  let activeFile = $derived(files.find((file) => file.path === activePath) ?? null);
  let resolvedCount = $derived(files.filter((file) => file.resolved).length);
  let headMoved = $derived(!!merge && !!headOid && headOid !== merge.headSha);
  let commitBlocker = $derived.by(() => {
    if (!merge) return "";
    if (!merge.push.allowed) return merge.push.reason ?? "You can't push to this pull request's branch.";
    if (headMoved || staleHead) return "The pull request changed since these conflicts loaded.";
    const unsupported = files.find((file) => file.unsupported);
    if (unsupported) return `Resolve ${unsupported.path} outside Cockpit.`;
    const remaining = files.length - resolvedCount;
    if (remaining) return `Resolve ${remaining} more file${remaining === 1 ? "" : "s"} to commit.`;
    return "";
  });
  onMount(() => {
    void load();
    return () => {
      request += 1;
      savedSession = committed ? null : { key: sessionKey, originals: new Map(originals), drafts: new Map(drafts) };
    };
  });

  function showFile(path) {
    const draft = drafts.get(path);
    openLine = draft === undefined ? 1 : findConflicts(draft.split("\n"))[0]?.start ?? 1;
    activePath = path;
  }

  async function load() {
    const current = ++request;
    const previous = savedSession?.key === sessionKey
      ? savedSession
      : { originals: new Map(originals), drafts: new Map(drafts) };
    loadState = "loading";
    loadError = "";
    commitError = "";
    staleHead = false;
    try {
      const next = await fetchConflictMerge(repo, number);
      if (current !== request) return;
      drafts.clear();
      originals.clear();
      lineEndings.clear();
      for (const file of next.files) {
        if (file.content === undefined) continue;
        const normalized = normalizeFileEndings(file.content);
        if (!normalized) continue;
        originals.set(file.path, normalized.content);
        lineEndings.set(file.path, normalized.eol);
        const kept = previous.originals.get(file.path) === normalized.content ? previous.drafts.get(file.path) : undefined;
        drafts.set(file.path, kept ?? normalized.content);
      }
      savedSession = null;
      merge = next;
      showFile(next.files.some((file) => file.path === activePath) ? activePath : next.files[0]?.path ?? null);
      loadState = "ready";
    } catch (error) {
      if (current !== request) return;
      loadError = error instanceof Error && error.message ? error.message : "Couldn't load the conflicts.";
      loadState = "error";
    }
  }

  async function commit() {
    if (!merge || commitBlocker || committing) return;
    const loaded = merge;
    committing = true;
    commitError = "";
    try {
      const resolutions = loaded.files.map(({ path }) => {
        const draft = drafts.get(path);
        return { path, content: lineEndings.get(path) === "\r\n" ? draft.replace(/\n/g, "\r\n") : draft };
      });
      const result = await commitConflictMerge(repo, number, loaded.headSha, loaded.baseSha, resolutions);
      committed = true;
      onCommitted(loaded.headSha, result.commitOid);
    } catch (error) {
      commitError = error instanceof Error && error.message ? error.message : "Couldn't commit the merge.";
      staleHead = error?.code === "stale-head";
      if (error?.code === "github-setup" && error.auth) githubSetup = error.auth;
    } finally {
      committing = false;
    }
  }

  function finishGithubSetup() {
    githubSetup = null;
    void commit();
  }

  function onKey(event) {
    if (githubSetup) return;
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
      return;
    }
    // Pull request shortcuts behind the editor stay inert; the code editor's own keys still reach it.
    if (!isTypingTarget(event.target)) event.stopImmediatePropagation();
  }

  $effect(() => {
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

<div class="ce-root" role="dialog" aria-modal="true" aria-label="Resolve merge conflicts" tabindex="-1">
  <header class="ce-head">
    <div class="ce-title">
      <strong>Resolve conflicts</strong>
      {#if merge}<span class="ce-message mono">Merge branch '{merge.baseRef}' into {merge.headRef}</span>{/if}
    </div>
    <div class="ce-head-actions">
      {#if commitError}
        <span class="ce-error" role="alert">
          {commitError}
          {#if staleHead}<button type="button" class="link" onclick={load}>Reload</button>{/if}
        </span>
      {:else if headMoved}
        <span class="ce-error" role="alert">
          The pull request has new commits.
          <button type="button" class="link" onclick={load}>Reload</button>
        </span>
      {:else if commitBlocker}
        <span class="ce-hint">{commitBlocker}</span>
      {/if}
      <button type="button" class="ce-commit" disabled={!merge || !!commitBlocker || committing} onclick={commit}>
        {committing ? "Committing…" : "Commit merge"}
      </button>
      <button type="button" class="ce-close" aria-label="Close conflict editor" title="Close" onclick={onClose}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"></path></svg>
      </button>
    </div>
  </header>

  {#if loadState === "loading" && !merge}
    <div class="ce-state">Merging the base branch…</div>
  {:else if loadState === "error"}
    <div class="ce-state ce-state-error">
      <span>{loadError}</span>
      <button type="button" class="link" onclick={load}>Retry</button>
    </div>
  {:else}
    <div class="ce-body">
      <nav class="ce-files" aria-label="Conflicting files">
        <div class="ce-files-head">{resolvedCount} of {files.length} resolved</div>
        <ul>
          {#each files as file (file.path)}
            <li>
              <button
                type="button"
                class="ce-file"
                class:on={file.path === activePath}
                aria-current={file.path === activePath ? "true" : undefined}
                title={file.path}
                onclick={() => showFile(file.path)}
              >
                <span class="ce-file-name mono">{file.path}</span>
                {#if file.unsupported}
                  <span class="ce-status ce-status-blocked">Not editable</span>
                {:else if file.resolved}
                  <span class="ce-status ce-status-done">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.25 2.75 2.75 6.25-6.25"></path></svg>
                    Resolved
                  </span>
                {:else}
                  <span class="ce-status">{file.conflicts ? `${file.conflicts} conflict${file.conflicts === 1 ? "" : "s"}` : "Markers remain"}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </nav>

      <section class="ce-main" aria-label={activePath ?? "Conflicting file"}>
        {#if activeFile}
          <div class="ce-bar">
            <span class="ce-path mono" title={activeFile.path}>{activeFile.path}</span>
            {#if !activeFile.unsupported}
              <span class="ce-count">
                {activeFile.resolved ? "No conflicts left" : activeFile.conflicts ? `${activeFile.conflicts} conflict${activeFile.conflicts === 1 ? "" : "s"}` : "Conflict markers remain"}
              </span>
              <button type="button" class="ce-nav" disabled={!activeFile.conflicts} title="Previous conflict" aria-label="Previous conflict" onclick={() => view && jumpToConflict(view, -1)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"></path></svg>
              </button>
              <button type="button" class="ce-nav" disabled={!activeFile.conflicts} title="Next conflict" aria-label="Next conflict" onclick={() => view && jumpToConflict(view, 1)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg>
              </button>
            {/if}
          </div>
          {#if activeFile.unsupported}
            <div class="ce-state">{activeFile.unsupported} Resolve it locally or with an agent.</div>
          {:else}
            <div class="ce-editor">
              {#key activePath}
                <CodeEditor
                  bind:content={() => drafts.get(activePath), (next) => drafts.set(activePath, next)}
                  bind:view
                  path={activePath}
                  layout="file"
                  initialLine={openLine}
                  rowOffset={120}
                  extensions={[conflictEditing({ current: merge.headRef, incoming: merge.baseRef })]}
                />
              {/key}
            </div>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>
{#if githubSetup}
  <GithubSetupModal initialStatus={githubSetup} onReady={finishGithubSetup} onClose={() => (githubSetup = null)} />
{/if}

<style>
  .ce-root {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--panel);
  }
  .ce-head {
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 52px;
    padding: 8px 12px 8px 16px;
    border-bottom: 1px solid var(--border);
  }
  :global(.app-shell.shell) .ce-head {
    padding-left: 84px;
  }
  .ce-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .ce-title strong {
    flex: none;
    color: var(--text);
    font-size: 14px;
    font-weight: 650;
  }
  .ce-message {
    min-width: 0;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ce-head-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    max-width: 60%;
  }
  .ce-hint,
  .ce-error {
    min-width: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.35;
    text-align: right;
  }
  .ce-error {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    color: var(--fail);
  }
  .ce-commit {
    flex: none;
    min-height: 32px;
    padding: 0 13px;
    border: 0;
    border-radius: 7px;
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }
  .ce-commit:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
    cursor: default;
  }
  .ce-close,
  .ce-nav {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }
  .ce-nav {
    width: 26px;
    height: 26px;
  }
  .ce-close svg,
  .ce-nav svg,
  .ce-status svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ce-nav:disabled {
    opacity: 0.4;
    cursor: default;
  }
  @media (hover: hover) and (pointer: fine) {
    .ce-commit:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    .ce-close:hover,
    .ce-nav:hover:not(:disabled) {
      background: var(--surface);
      color: var(--text);
    }
    .ce-file:hover:not(.on) {
      background: var(--surface);
    }
  }
  .ce-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    color: var(--text-dim);
    font-size: 13px;
    text-align: center;
  }
  .ce-state-error {
    color: var(--fail);
  }
  .ce-body {
    display: grid;
    grid-template-columns: clamp(240px, 22vw, 320px) minmax(0, 1fr);
    min-height: 0;
  }
  .ce-files {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .ce-files-head {
    padding: 12px 14px 8px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 600;
  }
  .ce-files ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    margin: 0;
    padding: 0 8px 12px;
    overflow-y: auto;
    list-style: none;
  }
  .ce-file {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .ce-file.on {
    background: var(--surface);
    box-shadow: var(--shadow-control-selected);
  }
  .ce-file-name {
    max-width: 100%;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .ce-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fail);
    font-size: 11px;
    font-weight: 550;
  }
  .ce-status-done {
    color: var(--ready);
  }
  .ce-status-blocked {
    color: var(--text-dim);
  }
  .ce-main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }
  .ce-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 4px 10px 4px 16px;
    border-bottom: 1px solid var(--border-soft);
  }
  .ce-path {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    color: var(--text);
    font-size: 12.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ce-count {
    flex: none;
    color: var(--text-dim);
    font-size: 12px;
  }
  .ce-editor {
    display: flex;
    min-height: 0;
  }
  .ce-editor :global(.cm-conflict-current) {
    background: color-mix(in srgb, var(--native-green) 12%, transparent);
  }
  .ce-editor :global(.cm-conflict-incoming) {
    background: color-mix(in srgb, var(--native-accent) 12%, transparent);
  }
  .ce-editor :global(.cm-conflict-base) {
    background: color-mix(in srgb, var(--native-gray) 10%, transparent);
  }
  .ce-editor :global(.cm-conflict-marker) {
    background: var(--surface);
    color: var(--text-dim);
    font-weight: 600;
  }
  .ce-editor :global(.cm-conflict-actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    padding: 6px 0 3px;
    font-family: var(--sans);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .ce-editor :global(.cm-conflict-actions button) {
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font: inherit;
    font-weight: 550;
    cursor: pointer;
  }
  .ce-editor :global(.cm-conflict-actions button:hover) {
    text-decoration: underline;
  }
  @media (max-width: 760px) {
    .ce-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .ce-files {
      max-height: 30vh;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
    .ce-head {
      flex-wrap: wrap;
    }
    .ce-head-actions {
      max-width: none;
    }
  }
</style>
