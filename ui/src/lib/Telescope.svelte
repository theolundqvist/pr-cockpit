<script>
  import { tick, untrack } from "svelte";
  import { repoSearch, repoFiles, repoFile, repoDefinition } from "./api.js";
  import { getHighlighter, ensureTheme, langForPath, tokenizeLine } from "./highlight.js";
  import { theme } from "./theme.svelte.js";
  import { fuzzyRankWithPriority } from "./fuzzy.js";
  import { showFlash } from "./flash.svelte.js";
  import { testMatcher } from "./testPath.js";
  import { prefs } from "./prefs.svelte.js";
  import { columnWithin, createDefinitionHover, tokenAtPoint, wordAtPoint } from "./wordAtPoint.js";

  let { repo, headSha, headRef, testsHidden = false, changedFiles = [], onOpenChangedFile, onOpenHistory, open = $bindable(false) } = $props();

  const definitionHover = createDefinitionHover(() => view);
  $effect(() => () => definitionHover.destroy());

  let mode = $state("search");
  let query = $state("");
  let matches = $state([]);
  let filePaths = $state([]);
  let filesStatus = $state("loading");
  let searchStatus = $state("ok");
  let selected = $state(0);
  let lastMouseX = -1;
  let lastMouseY = -1;
  function trackMouse(e) {
    lastMouseX = e.screenX;
    lastMouseY = e.screenY;
  }
  function onItemHover(e, index) {
    if (e.screenX !== lastMouseX || e.screenY !== lastMouseY) selected = index;
  }
  let inputEl = $state(null);
  let editorEl = $state(null);
  let previews = $state(new Map());

  let view = $state(null); // { path, line } shown in the editor
  let hist = $state([]);
  let histIndex = $state(-1);

  let defCandidates = $state([]);
  let defsSymbol = $state("");
  let defsReturnMode = "search";

  const MAX_RESULTS = 200;
  const MAX_FETCH_RETRIES = 15;
  const MIN_SEARCH_QUERY = 2;

  let hidePattern = $derived(testsHidden ? testMatcher(prefs.testPathRegex) : null);

  let results = $derived.by(() => {
    if (mode === "defs") return defCandidates.map((c) => ({ path: c.path, line: c.line, text: c.text }));
    if (mode === "search") {
      const rows = hidePattern ? matches.filter((m) => !hidePattern.test(m.path)) : matches;
      return rows.map((m) => ({ path: m.path, line: m.line, text: m.text }));
    }
    const q = query.trim();
    const paths = hidePattern ? filePaths.filter((p) => !hidePattern.test(p)) : filePaths;
    const changedPaths = changedFiles
      .map((file) => file.path)
      .filter((path) => !hidePattern || !hidePattern.test(path));
    const priority = new Set(changedPaths);
    const ranked = q
      ? fuzzyRankWithPriority(q, priority, paths)
      : [
          ...[...priority].map((path) => ({ path, priority: true })),
          ...paths.filter((path) => !priority.has(path)).map((path) => ({ path, priority: false })),
        ];
    return ranked.slice(0, MAX_RESULTS).map((r) => ({ path: r.path, line: null, changed: r.priority }));
  });
  let groups = $derived.by(() => {
    const out = [];
    results.forEach((r, i) => {
      const last = out[out.length - 1];
      if (last && last.path === r.path) last.items.push({ ...r, index: i });
      else out.push({ path: r.path, items: [{ ...r, index: i }] });
    });
    return out;
  });

  let current = $derived(results[selected] ?? null);
  let preview = $derived(view ? previews.get(view.path) ?? null : null);

  // live hide-tests toggle can shrink the list under the cursor
  $effect(() => {
    if (selected >= results.length) selected = Math.max(0, results.length - 1);
  });

  let snipTokens = $state(new Map());
  const snipKey = (path, text, themeName) => `${themeName}\n${path}\n${text}`;

  // up to 2000 match lines - tokenize once per (theme, path, line), cached across keystrokes, chunked so a keystroke never blocks
  $effect(() => {
    const rows = mode !== "files" ? results : null;
    const themeName = theme.shiki;
    if (!open || !rows || rows.length === 0) return;
    let cancelled = false;
    (async () => {
      const h = await getHighlighter();
      await ensureTheme(h, themeName);
      if (cancelled) return;
      const loaded = new Set(h.getLoadedLanguages());
      const tokens = new Map(snipTokens);
      let pending = 0;
      for (const r of rows) {
        if (r.line == null) continue;
        const key = snipKey(r.path, r.text, themeName);
        if (tokens.has(key)) continue;
        const lang = langForPath(r.path);
        tokens.set(key, lang && loaded.has(lang) ? tokenizeLine(h, r.text, lang, themeName) : null);
        if (++pending >= 300) {
          snipTokens = new Map(tokens);
          pending = 0;
          await new Promise((res) => setTimeout(res));
          if (cancelled) return;
        }
      }
      if (!cancelled) snipTokens = new Map(tokens);
    })();
    return () => {
      cancelled = true;
    };
  });

  // new head sha invalidates every per-sha cache; a close/reopen on the same sha keeps them
  let cacheSha = headSha;
  $effect(() => {
    if (headSha === cacheSha) return;
    cacheSha = headSha;
    previews = new Map();
    snipTokens = new Map();
    filePaths = [];
    filesStatus = "loading";
    matches = [];
    hist = [];
    histIndex = -1;
    view = null;
    defCandidates = [];
    if (open) loadFiles();
  });

  function resetList(nextMode) {
    mode = nextMode;
    query = "";
    matches = [];
    selected = 0;
    searchStatus = "ok";
  }

  async function activate(nextMode) {
    if (!open) {
      open = true;
      resetList(nextMode);
      if (filesStatus !== "ok") loadFiles();
    } else if (mode !== nextMode) {
      resetList(nextMode);
    }
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function leaveDefs() {
    activate(defsReturnMode);
  }

  function close() {
    open = false;
  }

  let filesToken;
  async function loadFiles(attempt = 0) {
    const token = {};
    filesToken = token;
    if (attempt === 0) filesStatus = "loading";
    try {
      const res = await repoFiles(repo, headSha, headRef);
      if (filesToken !== token) return;
      if (res.status === "ok") {
        filePaths = res.paths;
        filesStatus = "ok";
      } else if (res.status === "fetching" && attempt < MAX_FETCH_RETRIES) {
        filesStatus = "fetching";
        setTimeout(() => filesToken === token && loadFiles(attempt + 1), 800);
      } else {
        filesStatus = res.status === "fetching" ? "not-found" : res.status;
      }
    } catch {
      if (filesToken === token) filesStatus = "error";
    }
  }

  let searchToken;
  $effect(() => {
    if (!open || mode !== "search") return;
    const q = query.trim();
    // too-short queries match a huge chunk of the repo — never send them; the cleanup below aborts any in-flight one
    if (q.length < MIN_SEARCH_QUERY) {
      matches = [];
      searchStatus = "ok";
      return;
    }
    const token = {};
    searchToken = token;
    const controller = new AbortController();
    const run = async (attempt = 0) => {
      try {
        const res = await repoSearch(repo, headSha, headRef, q, controller.signal);
        if (searchToken !== token) return;
        if (res.status === "ok") {
          matches = res.matches;
          searchStatus = "ok";
          selected = 0;
        } else if (res.status === "fetching" && attempt < MAX_FETCH_RETRIES) {
          searchStatus = "fetching";
          setTimeout(() => searchToken === token && run(attempt + 1), 800);
        } else {
          matches = [];
          searchStatus = res.status === "fetching" ? "not-found" : res.status;
        }
      } catch (err) {
        if (searchToken === token && err?.name !== "AbortError") {
          matches = [];
          searchStatus = "error";
        }
      }
    };
    const timer = setTimeout(run, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  async function ensurePreview(path) {
    if (!path || previews.has(path)) return;
    const next = new Map(previews);
    next.set(path, { status: "loading" });
    previews = next;
    let entry;
    try {
      const res = await repoFile(repo, headSha, headRef, path);
      if (res.status !== "ok") {
        entry = { status: "missing" };
      } else {
        const lines = res.content.split("\n");
        const highlighter = await getHighlighter();
        await ensureTheme(highlighter, theme.shiki);
        const lang = langForPath(path);
        const loaded = new Set(highlighter.getLoadedLanguages());
        const tokens =
          lang && loaded.has(lang) && lines.length <= 5000
            ? lines.map((l) => tokenizeLine(highlighter, l, lang, theme.shiki))
            : null;
        entry = { status: "ready", lines, tokens };
      }
    } catch {
      entry = { status: "missing" };
    }
    const after = new Map(previews);
    after.set(path, entry);
    previews = after;
  }

  let previewedSelectionKey = null;

  // sidebar selection previews in the editor without touching history
  $effect(() => {
    const c = current;
    if (!open || !c) return;
    const key = `${headSha}\n${mode}\n${selected}\n${c.path}\n${c.line ?? ""}`;
    untrack(() => {
      if (key === previewedSelectionKey) return;
      previewedSelectionKey = key;
      view = { path: c.path, line: c.line ?? null };
    });
  });

  $effect(() => {
    if (open && view) ensurePreview(view.path);
  });

  $effect(() => {
    const v = view;
    const p = v ? previews.get(v.path) : null;
    if (!open || !editorEl || !v || !p || p.status !== "ready") return;
    requestAnimationFrame(() => {
      const target = v.line != null ? editorEl.querySelector(".pl.hit") : editorEl.querySelector(".pl");
      target?.scrollIntoView({ block: v.line != null ? "center" : "start" });
    });
  });

  function navigateTo(loc) {
    view = { path: loc.path, line: loc.line ?? null };
    const top = hist[histIndex];
    if (top && top.path === view.path && top.line === view.line) return;
    hist = [...hist.slice(0, histIndex + 1), view];
    histIndex = hist.length - 1;
  }

  function goBack() {
    if (histIndex <= 0) return;
    histIndex -= 1;
    view = hist[histIndex];
  }

  function goForward() {
    if (histIndex >= hist.length - 1) return;
    histIndex += 1;
    view = hist[histIndex];
  }

  function move(delta) {
    if (!results.length) return;
    selected = Math.max(0, Math.min(results.length - 1, selected + delta));
    requestAnimationFrame(() => {
      document.querySelector(".ts-item.active")?.scrollIntoView({ block: "nearest" });
    });
  }

  function openCurrent(index = selected) {
    const r = results[index];
    if (!r) return;
    selected = index;
    if (r.changed) {
      onOpenChangedFile(r.path);
      close();
      return;
    }
    navigateTo({ path: r.path, line: r.line ?? null });
  }

  let defToken;
  async function lookupDefinition(symbol, fromPath, ensureOpen = false, position = null) {
    const token = {};
    defToken = token;
    try {
      const res = await repoDefinition(repo, headSha, headRef, fromPath, symbol, position);
      if (defToken !== token || (!open && !ensureOpen)) return;
      if (res.status !== "ok") {
        showFlash(res.status === "fetching" ? "repo still fetching…" : `definition lookup: ${res.status}`);
        return;
      }
      if (res.definition) {
        if (ensureOpen) open = true;
        navigateTo({ path: res.definition.path, line: res.definition.line ?? null });
      } else if (res.candidates?.length) {
        if (ensureOpen) open = true;
        if (mode !== "defs") defsReturnMode = mode;
        defCandidates = res.candidates;
        defsSymbol = symbol;
        mode = "defs";
        selected = 0;
      } else {
        showFlash(`no definition for ${symbol}`);
      }
    } catch {
      if (defToken === token) showFlash("definition lookup failed");
    }
  }

  export function openDefinition(symbol, fromPath, position = null) {
    lookupDefinition(symbol, fromPath, true, position);
  }

  // 1-based line + 0-based column of a clicked token in the editor pane.
  function editorPosition(token) {
    const row = token.node.parentElement?.closest(".pl");
    const code = row?.querySelector(".pl-code");
    if (!code) return null;
    const line = Number(row.querySelector(".pl-ln")?.textContent);
    const character = columnWithin(code, token);
    return Number.isInteger(line) && line > 0 && character != null ? { line, character } : null;
  }

  function onEditorMouseDown(e) {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || !view) return;
    const token = tokenAtPoint(e.clientX, e.clientY);
    if (!token) return;
    e.preventDefault();
    lookupDefinition(token.word, view.path, false, editorPosition(token));
  }

  function onEditorContext(e) {
    if (!view) return;
    const word = wordAtPoint(e.clientX, e.clientY);
    if (!word) return;
    e.preventDefault();
    close();
    onOpenHistory(view.path, word);
  }

  $effect(() => {
    function onKey(e) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate("search");
        return;
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate("files");
        return;
      }
      if (!open) return;
      if (e.key === "Escape") close();
      else if (meta && e.key === "[") goBack();
      else if (meta && e.key === "]") goForward();
      else if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "j" && e.target !== inputEl) move(1);
      else if (e.key === "k" && e.target !== inputEl) move(-1);
      else if (e.key === "Enter") openCurrent();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  const tail = (p) => p.slice(p.lastIndexOf("/") + 1);
</script>

{#if open}
  <div class="ts-root" role="dialog" aria-label="code browser">
    <div class="ts-side">
      <div class="ts-tabs mono">
        <button class="ts-tab" class:on={mode === "search"} onclick={() => activate("search")}>
          search <kbd>⌘⇧F</kbd>
        </button>
        <button class="ts-tab" class:on={mode === "files"} onclick={() => activate("files")}>
          files <kbd>⌘P</kbd>
        </button>
        {#if mode === "defs"}
          <span class="ts-tab on ts-tab-defs" title="definitions of {defsSymbol}">defs: {defsSymbol}</span>
        {/if}
      </div>
      {#if mode === "defs"}
        <div class="ts-defbar mono">
          <span class="ts-defsym">{results.length} definition{results.length === 1 ? "" : "s"} of {defsSymbol}</span>
          <button class="ts-defback" onclick={leaveDefs}>back</button>
        </div>
      {:else}
        <input
          class="ts-input mono"
          bind:this={inputEl}
          bind:value={query}
          placeholder={mode === "search" ? "Search in files…" : "Go to file…"}
          spellcheck="false"
          autocomplete="off"
        />
      {/if}
      <div class="ts-count mono">
        {#if searchStatus === "fetching" || filesStatus === "fetching"}fetching…
        {:else if searchStatus === "fetch-failed" || filesStatus === "fetch-failed"}cache fetch failed
        {:else if searchStatus === "error" || filesStatus === "error"}request failed
        {:else if searchStatus === "not-found" || filesStatus === "not-found"}sha not found
        {:else if results.length}{selected + 1}/{results.length}
        {:else if (mode === "search" ? query.trim() : true)}no matches{/if}
      </div>
      <div class="ts-list" onmousemove={trackMouse}>
        {#each groups as group (group.path)}
          <div class="ts-group-head mono" title={group.path}>
            <span class="ts-name">{tail(group.path)}</span>
            <span class="ts-dir">{group.path}</span>
            {#if mode !== "files"}<span class="ts-gc">{group.items.length}</span>{/if}
          </div>
          {#each group.items as item (item.index)}
            {@const toks = item.line != null ? snipTokens.get(snipKey(item.path, item.text, theme.shiki)) : null}
            <button
              class="ts-item mono"
              class:active={item.index === selected}
              onmouseenter={(e) => onItemHover(e, item.index)}
              onclick={() => openCurrent(item.index)}
            >
              {#if item.line != null}
                <span class="ts-ln">{item.line}</span>
                <span class="ts-snip"
                  >{#if toks}{#each toks as t}<span style="color:{t.color}">{t.content}</span>{/each}{:else}{item.text}{/if}</span
                >
              {:else}
                <span class="ts-path">{group.path}</span>
                {#if item.changed}<span class="ts-diff badge review">diff</span>{/if}
              {/if}
            </button>
          {/each}
        {/each}
      </div>
    </div>
    <div class="ts-main">
      <div class="ts-bar mono">
        <button class="ts-nav" disabled={histIndex <= 0} onclick={goBack} title="Back (⌘[)" aria-label="Back">←</button>
        <button
          class="ts-nav"
          disabled={histIndex >= hist.length - 1}
          onclick={goForward}
          title="Forward (⌘])"
          aria-label="Forward">→</button
        >
        <span class="ts-loc" title={view?.path}>
          {#if view}{view.path}{#if view.line != null}:{view.line}{/if}{:else}no file{/if}
        </span>
        <span class="ts-hint">ctrl+click → definition · right-click → mention history</span>
        <button class="ts-nav" onclick={close} title="Close (esc)" aria-label="Close">✕</button>
      </div>
      <div
        class="ts-editor mono"
        bind:this={editorEl}
        onmousemove={(e) => definitionHover.onMouseMove(e, e.target.closest(".ts-editor"))}
        onmouseleave={definitionHover.onMouseLeave}
        onmousedown={onEditorMouseDown}
        oncontextmenu={onEditorContext}
      >
        {#if !view}
          <div class="ts-empty">no selection</div>
        {:else if !preview || preview.status === "loading"}
          <div class="ts-empty">loading…</div>
        {:else if preview.status !== "ready"}
          <div class="ts-empty">preview unavailable</div>
        {:else}
          {#each preview.lines as line, i}
            <div class="pl" class:hit={view.line === i + 1}>
              <span class="pl-ln">{i + 1}</span>
              <span class="pl-code"
                >{#if preview.tokens}{#each preview.tokens[i] as t}<span style="color:{t.color}">{t.content}</span>{/each}{:else}{line}{/if}</span
              >
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .ts-root {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--panel);
    display: grid;
    grid-template-columns: clamp(300px, 32vw, 440px) minmax(0, 1fr);
  }
  .ts-side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .ts-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  :global(.app-shell.shell) .ts-tabs {
    padding-left: 84px;
  }
  .ts-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 4px 8px;
    color: var(--text-dim);
    font-size: 11.5px;
    cursor: pointer;
  }
  .ts-tab.on {
    background: var(--surface);
    color: var(--text);
  }
  .ts-tab kbd {
    font-size: 9.5px;
    color: var(--text-faint);
  }
  .ts-tab-defs {
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }
  .ts-input {
    width: 100%;
    box-sizing: border-box;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-size: 14px;
    min-height: 46px;
    padding: 0 16px;
    font-family: var(--sans);
    font-weight: 500;
  }
  .ts-input:focus {
    outline: none;
  }
  .ts-defbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 46px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text);
  }
  .ts-defsym {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts-defback {
    flex: none;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
  }
  .ts-defback:hover {
    background: var(--panel-raised);
    color: var(--text);
  }
  .ts-count {
    padding: 6px 16px;
    font-size: 11px;
    color: var(--text-faint);
    border-bottom: 1px solid var(--border-soft);
  }
  .ts-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 0;
  }
  .ts-group-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 14px 2px;
    font-size: 11.5px;
  }
  .ts-name {
    color: var(--text);
    font-weight: 600;
  }
  .ts-dir {
    flex: 1;
    color: var(--text-faint);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts-gc {
    flex: none;
    color: var(--text-faint);
    font-size: 10.5px;
  }
  .ts-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    padding: 2px 14px 2px 22px;
    font-size: 12px;
    min-height: 26px;
  }
  .ts-item.active {
    background: var(--surface);
  }
  .ts-ln {
    flex: none;
    width: 40px;
    text-align: right;
    color: var(--text-faint);
  }
  .ts-snip {
    flex: 1;
    min-width: 0;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }
  .ts-path {
    flex: 1;
    min-width: 0;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .ts-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .ts-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .ts-nav {
    flex: none;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 15px;
    cursor: pointer;
  }
  .ts-nav:hover:not(:disabled) {
    background: var(--panel-raised);
    color: var(--text);
  }
  .ts-nav:disabled {
    color: var(--text-faint);
    opacity: 0.4;
    cursor: default;
  }
  .ts-loc {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    font-size: 11.5px;
    color: var(--text);
  }
  .ts-hint {
    flex: none;
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .ts-editor {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    font-size: 12.5px;
    line-height: 1.55;
    padding: 6px 0;
  }
  .ts-empty {
    padding: 24px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .pl {
    display: flex;
    min-width: max-content;
    white-space: pre;
  }
  .pl.hit {
    background: var(--add-bg);
  }
  .pl-ln {
    flex: none;
    width: 52px;
    padding: 0 10px;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
    background: var(--ln-tint);
  }
  .pl-code {
    padding: 0 14px;
    color: var(--text);
  }

  @media (max-width: 760px) {
    .ts-root {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(180px, 42%) minmax(0, 1fr);
    }
    .ts-side {
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .ts-hint {
      display: none;
    }
  }
</style>
