<script>
  import { tick, untrack } from "svelte";
  import { repoSearch, repoFiles, repoFile, repoDefinition } from "./api.js";
  import { isPromptDialogOpen } from "./dom.js";
  import { langForPath } from "./highlight.js";
  import { tokenizeCodeBlock, tokenizeLines } from "./offThreadHighlight.js";
  import { theme } from "./theme.svelte.js";
  import { fuzzyRankWithPriority } from "./fuzzy.js";
  import { showFlash } from "./flash.svelte.js";
  import { testMatcher } from "./testPath.js";
  import { excludedPath } from "../../../shared/reviewFiles.js";
  import { prefs } from "./prefs.svelte.js";
  import Kbd from "./Kbd.svelte";
  import FileFind from "./FileFind.svelte";
  import FileTree from "./FileTree.svelte";
  import { matchRuns, positionRanges, queryRanges } from "./matchRuns.js";
  import { columnWithin, createDefinitionHover, tokenAtPoint, wordAtPoint } from "./wordAtPoint.js";

  // With `hotkeys` off, Cmd+P and Cmd+Shift+F only switch modes once open; the owner opens it through `activate`.
  let { repo, headSha, headRef, context = "", fileFilter = "all", changedFiles = [], onOpenChangedFile, onOpenHistory = null, onBack = null, hotkeys = true, open = $bindable(false) } = $props();

  const definitionHover = createDefinitionHover(() => view);
  $effect(() => () => definitionHover.destroy());

  let mode = $state("search");
  let query = $state("");
  let matches = $state([]);
  let matchedQuery = $state("");
  let filePaths = $state([]);
  let generatedPaths = $state(new Set());
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
  let rootEl = $state(null);
  let inputEl = $state(null);
  let listEl = $state(null);
  let editorEl = $state(null);
  let fileTree = $state(null);
  let treeFiles = $derived(filePaths.map((path) => ({ path })));
  let previews = $state(new Map());

  let view = $state(null); // { path, line } shown in the editor
  let hist = $state([]);
  let histIndex = $state(-1);
  let fileOpen = $state(false); // the shown file fills the browser
  let fileFind = $state(null);
  let findOpen = $state(false);

  let explorerOpened = $state(false);
  let workspace = $derived(explorerOpened || mode === "explore");
  let quickOpen = $state(false);
  let quickQuery = $state("");
  let quickSelected = $state(0);
  let quickInputEl = $state(null);
  let quickListEl = $state(null);
  let quickReturnFocus = null;
  let quickScrollTop = $state(0);
  let quickHeight = $state(560);
  const QUICK_ROW_HEIGHT = 28;
  let quickStart = $derived(Math.max(0, Math.floor(quickScrollTop / QUICK_ROW_HEIGHT) - 6));
  let quickEnd = $derived(Math.min(quickResults.length, quickStart + Math.ceil(quickHeight / QUICK_ROW_HEIGHT) + 12));

  $effect(() => {
    if (!quickListEl) return;
    const element = quickListEl;
    const resize = new ResizeObserver(() => (quickHeight = element.clientHeight));
    resize.observe(element);
    return () => resize.disconnect();
  });

  let defCandidates = $state([]);
  let defsSymbol = $state("");
  let defsReturnMode = "search";

  const MAX_RESULTS = 200;
  const SNIPPET_BATCH_LINES = 300;
  const PREVIEW_MAX_HIGHLIGHT_LINES = 5000;
  const MAX_FETCH_RETRIES = 15;
  const MIN_SEARCH_QUERY = 2;
  // a snippet row shows about this many characters; a match beyond them leads with an ellipsis
  const SNIPPET_VISIBLE_CHARS = 32;
  const SNIPPET_LEAD_CHARS = 10;

  let testPattern = $derived(testMatcher(prefs.testPathRegex, prefs.hiddenReviewPaths[repo]));
  let shownPath = $derived(fileFilter === "all" ? null : (path) => excludedPath(path, testPattern, generatedPaths) === (fileFilter === "only"));

  // Snippets drop their indentation, and a match past the visible width pulls the snippet's start forward.
  function snippetRuns(item, tokens) {
    const ranges = queryRanges(item.text, matchedQuery);
    const indent = item.text.length - item.text.trimStart().length;
    const clipped = ranges.length > 0 && ranges[0][1] - indent > SNIPPET_VISIBLE_CHARS;
    const runs = matchRuns(tokens ?? [{ content: item.text }], ranges, clipped ? ranges[0][0] - SNIPPET_LEAD_CHARS : indent);
    return clipped ? [{ content: "…", hit: false }, ...runs] : runs;
  }

  function rankFiles(input) {
    if (shownPath && filesStatus !== "ok") return [];
    const q = input.trim();
    const paths = shownPath ? filePaths.filter(shownPath) : filePaths;
    const changedPaths = changedFiles
      .map((file) => file.path)
      .filter((path) => !shownPath || shownPath(path));
    const priority = new Set(changedPaths);
    const ranked = q
      ? fuzzyRankWithPriority(q, priority, paths)
      : [
          ...[...priority].map((path) => ({ path, priority: true })),
          ...paths.filter((path) => !priority.has(path)).map((path) => ({ path, priority: false })),
        ];
    return ranked.slice(0, MAX_RESULTS).map((r) => ({ path: r.path, line: null, changed: r.priority, positions: r.positions ?? null }));
  }

  let results = $derived.by(() => {
    if (mode === "defs") return defCandidates.map((c) => ({ path: c.path, line: c.line, text: c.text }));
    if (mode === "explore") return [];
    if (shownPath && filesStatus !== "ok") return [];
    if (mode === "search") {
      const rows = shownPath ? matches.filter((m) => shownPath(m.path)) : matches;
      return rows.map((m) => ({ path: m.path, line: m.line, text: m.text }));
    }
    return rankFiles(query);
  });
  let quickResults = $derived(quickOpen ? rankFiles(quickQuery) : []);
  let groups = $derived.by(() => {
    const out = [];
    results.forEach((r, i) => {
      const last = out[out.length - 1];
      if (last && last.path === r.path) last.items.push({ ...r, index: i });
      else out.push({ path: r.path, items: [{ ...r, index: i }] });
    });
    return out;
  });

  let preview = $derived(view ? previews.get(view.path) ?? null : null);

  // the live x toggle can shrink the list under the cursor
  $effect(() => {
    if (selected >= results.length) selected = Math.max(0, results.length - 1);
  });

  let snipTokens = $state(new Map());
  const snipKey = (path, text, themeName) => `${themeName}\n${path}\n${text}`;

  // up to 2000 match lines - tokenized in the highlight worker once per (theme, path, line), cached
  // across keystrokes, in batches of one language so the first rows colour before the last are done
  $effect(() => {
    const rows = mode === "search" || mode === "defs" ? results : null;
    const themeName = theme.shiki;
    if (!open || !rows || rows.length === 0) return;
    let cancelled = false;
    (async () => {
      const tokens = new Map(untrack(() => snipTokens));
      const known = tokens.size;
      const batches = [];
      const filling = new Map();
      for (const r of rows) {
        if (r.line == null) continue;
        const key = snipKey(r.path, r.text, themeName);
        if (tokens.has(key)) continue;
        const lang = langForPath(r.path);
        if (!lang) {
          tokens.set(key, null);
          continue;
        }
        let batch = filling.get(lang);
        if (!batch || batch.rows.length >= SNIPPET_BATCH_LINES) {
          batch = { lang, rows: [] };
          filling.set(lang, batch);
          batches.push(batch);
        }
        batch.rows.push({ key, text: r.text });
      }
      for (const { lang, rows: batchRows } of batches) {
        const lineTokens = await tokenizeLines(batchRows.map((row) => row.text), lang, themeName).catch(() => null);
        if (cancelled) return;
        batchRows.forEach((row, index) => tokens.set(row.key, lineTokens?.[index] ?? null));
        snipTokens = new Map(tokens);
      }
      if (batches.length === 0 && tokens.size !== known) snipTokens = tokens;
    })();
    return () => {
      cancelled = true;
    };
  });

  let cacheSource = untrack(() => `${repo}\0${headSha}`);
  $effect(() => {
    const source = `${repo}\0${headSha}`;
    if (source === cacheSource) return;
    cacheSource = source;
    filesToken = null;
    generatedPaths = new Set();
    previews = new Map();
    snipTokens = new Map();
    filePaths = [];
    filesStatus = "loading";
    matches = [];
    matchedQuery = "";
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
    matchedQuery = "";
    selected = 0;
    searchStatus = "ok";
  }

  export async function activate(nextMode) {
    if (open && workspace && nextMode === "files") return openQuickOpen();
    fileOpen = false;
    quickOpen = false;
    quickReturnFocus = null;
    if (!open) {
      open = true;
      explorerOpened = false;
      resetList(nextMode);
      if (filesStatus !== "ok") loadFiles();
    } else if (mode !== nextMode) {
      if (!workspace) resetList(nextMode);
      else {
        mode = nextMode;
        if (searchStatus !== "ok") {
          matches = [];
          matchedQuery = "";
          searchStatus = "ok";
        }
      }
    }
    if (nextMode === "explore") explorerOpened = true;
    await tick();
    if (nextMode === "explore") fileTree?.focus();
    else {
      inputEl?.focus();
      inputEl?.select();
    }
  }

  async function openQuickOpen() {
    if (!quickOpen) {
      quickReturnFocus = document.activeElement;
      quickQuery = "";
      quickScrollTop = 0;
      quickSelected = 0;
      quickOpen = true;
    }
    await tick();
    quickInputEl?.focus();
    quickInputEl?.select();
  }

  function closeQuickOpen() {
    const target = quickReturnFocus;
    quickOpen = false;
    quickReturnFocus = null;
    if (target?.isConnected && rootEl?.contains(target)) target.focus({ preventScroll: true });
    else if (mode === "explore") fileTree?.focus();
    else editorEl?.focus({ preventScroll: true });
  }

  function commitQuickOpen(index = quickSelected) {
    const r = quickResults[index];
    if (!r) return;
    quickOpen = false;
    quickReturnFocus = null;
    navigateTo({ path: r.path });
    editorEl?.focus({ preventScroll: true });
  }

  function quickMove(delta) {
    if (!quickResults.length) return;
    quickSelected = Math.max(0, Math.min(quickResults.length - 1, quickSelected + delta));
    const top = quickSelected * QUICK_ROW_HEIGHT;
    if (top < quickListEl.scrollTop) quickListEl.scrollTop = top;
    else if (top + QUICK_ROW_HEIGHT > quickListEl.scrollTop + quickHeight) quickListEl.scrollTop = top + QUICK_ROW_HEIGHT - quickHeight;
    quickScrollTop = quickListEl.scrollTop;
  }

  function leaveDefs() {
    activate(defsReturnMode);
  }

  function close() {
    open = false;
    fileOpen = false;
    explorerOpened = false;
    quickOpen = false;
    quickReturnFocus = null;
  }

  async function openFile() {
    fileOpen = true;
    findOpen = false;
    await tick();
    editorEl?.focus({ preventScroll: true });
  }

  async function closeFile() {
    fileOpen = false;
    await tick();
    inputEl?.focus();
  }

  let filesToken;
  async function loadFiles(attempt = 0) {
    const token = {};
    filesToken = token;
    if (attempt === 0) filesStatus = "loading";
    const sourceRepo = repo;
    const sourceHead = headSha;
    const sourceRef = headRef;
    try {
      const res = await repoFiles(sourceRepo, sourceHead, sourceRef);
      if (filesToken !== token || repo !== sourceRepo || headSha !== sourceHead) return;
      if (res.status === "ok") {
        filePaths = res.paths;
        generatedPaths = new Set(res.generatedPaths);
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
    const searchRepo = repo;
    const searchHead = headSha;
    const searchRef = headRef;
    // too-short queries match a huge chunk of the repo — never send them; the cleanup below aborts any in-flight one
    if (q.length < MIN_SEARCH_QUERY) {
      matches = [];
      matchedQuery = "";
      searchStatus = "ok";
      return;
    }
    if (untrack(() => q === matchedQuery && searchStatus === "ok")) return;
    const token = {};
    searchStatus = "loading";
    searchToken = token;
    const controller = new AbortController();
    const run = async (attempt = 0) => {
      try {
        const res = await repoSearch(searchRepo, searchHead, searchRef, q, controller.signal);
        if (searchToken !== token || controller.signal.aborted) return;
        if (res.status === "ok") {
          matches = res.matches;
          matchedQuery = q;
          searchStatus = "ok";
          selected = 0;
        } else if (res.status === "fetching" && attempt < MAX_FETCH_RETRIES) {
          searchStatus = "fetching";
          setTimeout(() => searchToken === token && run(attempt + 1), 800);
        } else {
          matches = [];
          matchedQuery = "";
          searchStatus = res.status === "fetching" ? "not-found" : res.status;
        }
      } catch (err) {
        if (searchToken === token && err?.name !== "AbortError") {
          matches = [];
          matchedQuery = "";
          searchStatus = "error";
        }
      }
    };
    const timer = setTimeout(run, 25);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  async function ensurePreview(path) {
    if (!path || previews.has(path)) return;
    const source = `${repo}\0${headSha}`;
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
        entry = { status: "ready", lines, tokens: null };
        void colourPreview(path, entry);
      }
    } catch {
      entry = { status: "missing" };
    }
    if (source !== `${repo}\0${headSha}`) return;
    const after = new Map(previews);
    after.set(path, entry);
    previews = after;
  }

  // The file shows at once; its colours follow from the highlight worker, which can take a
  // second for a file of a few thousand lines.
  async function colourPreview(path, entry) {
    const lang = langForPath(path);
    if (!lang || entry.lines.length > PREVIEW_MAX_HIGHLIGHT_LINES) return;
    const tokens = await tokenizeCodeBlock(entry.lines.join("\n"), lang, theme.shiki).catch(() => null);
    if (!tokens || previews.get(path) !== entry) return;
    const after = new Map(previews);
    after.set(path, { ...entry, tokens });
    previews = after;
  }

  $effect(() => {
    if (open && view) ensurePreview(view.path);
  });

  // Scroll once per shown file and target; colours arriving later must not undo the reader's scroll.
  let scrolled = { editor: null, view: null, lines: null };
  $effect(() => {
    const v = view;
    const p = v ? previews.get(v.path) : null;
    if (!open || !editorEl || !v || !p || p.status !== "ready") return;
    if (scrolled.editor === editorEl && scrolled.view === v && scrolled.lines === p.lines) return;
    scrolled = { editor: editorEl, view: v, lines: p.lines };
    const editor = editorEl;
    requestAnimationFrame(() => {
      const target = v.line != null ? editor.querySelector(".pl.hit") : editor.querySelector(".pl");
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

  // An arrow move previews the selection without touching history; typing and arriving results never
  // fetch candidates, and the editor's sidebar changes the file only on Enter or click.
  function move(delta) {
    if (!results.length) return;
    selected = Math.max(0, Math.min(results.length - 1, selected + delta));
    const r = results[selected];
    if (!workspace && !fileOpen) view = { path: r.path, line: r.line ?? null };
    requestAnimationFrame(() => {
      listEl?.querySelector(".ts-item.active")?.scrollIntoView({ block: "nearest" });
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
    if (prefs.fileFinderEnabled && !workspace) openFile();
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
        if (!workspace && !fileOpen) view = { path: res.candidates[0].path, line: res.candidates[0].line ?? null };
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
    if (!view || !onOpenHistory) return;
    const word = wordAtPoint(e.clientX, e.clientY);
    if (!word) return;
    e.preventDefault();
    close();
    onOpenHistory(view.path, word);
  }

  function scrollFile(key) {
    const page = editorEl.clientHeight * 0.9;
    if (key === "Home" || key === "End") editorEl.scrollTo({ top: key === "Home" ? 0 : editorEl.scrollHeight });
    else if (key === "PageDown" || key === "PageUp") editorEl.scrollBy({ top: key === "PageDown" ? page : -page });
    else if (key === "ArrowLeft" || key === "ArrowRight") editorEl.scrollBy({ left: key === "ArrowRight" ? 40 : -40 });
    else editorEl.scrollBy({ top: key === "ArrowDown" || key === "j" ? 40 : -40 });
  }
  const FILE_SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "j", "k", "PageDown", "PageUp", "Home", "End"]);

  $effect(() => {
    function onKey(e) {
      if (isPromptDialogOpen()) return;
      const meta = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (prefs.fileFinderEnabled && (open || hotkeys) && meta && e.shiftKey && key === "e") {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate("explore");
        return;
      }
      if ((open || hotkeys) && meta && e.shiftKey && key === "f") {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate("search");
        return;
      }
      if ((open || hotkeys) && meta && !e.shiftKey && key === "p") {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate("files");
        return;
      }
      if (!open) return;
      if (quickOpen) {
        if (e.key === "Escape") closeQuickOpen();
        else if (e.key === "ArrowDown") quickMove(1);
        else if (e.key === "ArrowUp") quickMove(-1);
        else if (e.key === "Enter") commitQuickOpen();
        else if (e.key === "Tab") quickInputEl?.focus({ preventScroll: true });
        else {
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const editing = fileOpen || workspace;
      if (editing && e.target.closest?.(".file-find")) return;
      if (editing && meta && !e.shiftKey && key === "f") fileFind?.show();
      else if (fileOpen && e.key === "Escape") findOpen ? fileFind?.hide() : closeFile();
      else if (workspace && findOpen && e.key === "Escape") fileFind?.hide();
      else if (workspace && mode === "defs" && e.key === "Escape") leaveDefs();
      else if (workspace && mode === "search" && e.key === "Escape") activate("explore");
      else if (fileOpen && !meta && !e.altKey && FILE_SCROLL_KEYS.has(e.key)) scrollFile(e.key);
      else if (e.key === "Escape") {
        close();
        onBack?.();
      } else if (meta && e.key === "[") goBack();
      else if (meta && e.key === "]") goForward();
      else if (workspace && e.target.closest?.(".ts-editor") && !meta && !e.altKey && FILE_SCROLL_KEYS.has(e.key)) scrollFile(e.key);
      else if (mode === "explore") {
        // the tree owns its navigation keys; anything else, or any key without a focused owner, stops here
        if (!meta && !e.altKey && ((e.key.length === 1 && e.key !== " ") || !rootEl?.contains(e.target))) e.stopImmediatePropagation();
        return;
      }
      else if (fileOpen) {
        // the browser covers the page, whose single-key shortcuts must not act beneath it
        if (!meta && !e.altKey) e.stopImmediatePropagation();
        return;
      } else if (e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowUp") move(-1);
      else if (e.key === "j" && e.target !== inputEl) move(1);
      else if (e.key === "k" && e.target !== inputEl) move(-1);
      else if (e.key === "Enter") openCurrent();
      else {
        if (prefs.fileFinderEnabled && !meta && !e.altKey) e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // Keys the editor's own controls leave unhandled bubble to the page beneath, whose window listeners act on single keys.
  function holdKeys(e) {
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  }

  const tail = (p) => p.slice(p.lastIndexOf("/") + 1);
</script>

{#snippet marked(text, ranges)}{#each matchRuns([{ content: text }], ranges) as run}{#if run.hit}<mark class="ts-hl">{run.content}</mark>{:else}{run.content}{/if}{/each}{/snippet}

{#if open}
  <div class="ts-root" class:full={fileOpen} role="dialog" aria-label="code browser" tabindex="-1" bind:this={rootEl} onkeydown={workspace ? holdKeys : undefined}>
    <div class="ts-side">
      <div class="ts-tabs">
        <button class="ts-tab" class:on={mode === "search"} onclick={() => activate("search")}>
          search {#if mode !== "search"}<Kbd keys={["cmd", "shift", "f"]} />{/if}
        </button>
        <button class="ts-tab" class:on={mode === "files"} onclick={() => activate("files")}>
          files {#if mode !== "files"}<Kbd keys={["cmd", "p"]} />{/if}
        </button>
        {#if prefs.fileFinderEnabled}
        <button class="ts-tab" class:on={mode === "explore"} onclick={() => activate("explore")}>
          explore {#if mode !== "explore"}<Kbd keys={["cmd", "shift", "e"]} />{/if}
        </button>
        {/if}
        {#if mode === "defs"}
          <span class="ts-tab on ts-tab-defs" title="definitions of {defsSymbol}">defs: {defsSymbol}</span>
        {/if}
      </div>
      {#if context}<div class="ts-source"><span class="ts-context mono" title={context}>{context}</span><span class="mono" title={headSha}>{headSha.slice(0, 7)}</span></div>{/if}
      {#if mode === "defs"}
        <div class="ts-defbar mono">
          <span class="ts-defsym">{results.length} definition{results.length === 1 ? "" : "s"} of {defsSymbol}</span>
          <button class="ts-defback" onclick={leaveDefs}>back</button>
        </div>
      {:else if mode !== "explore"}
        <input
          class="ts-input mono"
          bind:this={inputEl}
          bind:value={query}
          placeholder={mode === "search" ? "Search in files…" : "Go to file…"}
          spellcheck="false"
          autocomplete="off"
        />
      {/if}
      <div class="ts-count">
        {#if searchStatus === "fetching" || filesStatus === "fetching"}fetching…
        {:else if mode === "search" && searchStatus === "loading"}searching…
        {:else if searchStatus === "fetch-failed" || filesStatus === "fetch-failed"}cache fetch failed
        {:else if searchStatus === "error" || filesStatus === "error"}request failed
        {:else if searchStatus === "not-found" || filesStatus === "not-found"}sha not found
        {:else if filesStatus === "loading" && (shownPath || mode !== "search")}loading…
        {:else if mode === "explore"}{filePaths.length.toLocaleString()} files
        {:else if results.length}{selected + 1}/{results.length}
        {:else if (mode === "search" ? query.trim() : true)}no matches{/if}
      </div>
      {#if workspace}
        <div class="ts-list" hidden={mode !== "explore"}>
          <FileTree bind:this={fileTree} files={treeFiles} selectedPath={view?.path} onSelect={(path) => navigateTo({ path })} browse active={mode === "explore"} />
        </div>
      {/if}
      {#if mode !== "explore"}
      <div class="ts-list" bind:this={listEl} onmousemove={trackMouse}>
        {#each groups as group (group.path)}
          {#if mode !== "files"}
          <div class="ts-group-head mono" title={group.path}>
            <span class="ts-name"
              >{#if prefs.fileFinderEnabled && group.items[0].positions}{@render marked(tail(group.path), positionRanges(group.items[0].positions, group.path.lastIndexOf("/") + 1))}{:else}{tail(group.path)}{/if}</span
            >
            <span class="ts-dir">{#if prefs.fileFinderEnabled && group.items[0].positions}{@render marked(group.path, positionRanges(group.items[0].positions))}{:else}{group.path}{/if}</span>
            {#if mode !== "files"}<span class="ts-gc">{group.items.length}</span>{/if}
          </div>
          {/if}
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
                  >{#if prefs.fileFinderEnabled && mode === "search"}{#each snippetRuns(item, toks) as run}<span class:ts-hit={run.hit} style:color={run.color}>{run.content}</span>{/each}{:else if toks}{#each toks as t}<span style="color:{t.color}">{t.content}</span>{/each}{:else}{item.text}{/if}</span
                >
              {:else}
                <span class="ts-path">{#if prefs.fileFinderEnabled && item.positions}{@render marked(group.path, positionRanges(item.positions))}{:else}{group.path}{/if}</span>
                {#if item.changed}<span class="ts-diff badge review">diff</span>{/if}
              {/if}
              {#if item.index === selected}<Kbd keys="enter" />{/if}
            </button>
          {/each}
        {/each}
      </div>
      {/if}
    </div>
    <div class="ts-main">
      <div class="ts-bar">
        <button class="ts-nav shortcut" disabled={histIndex <= 0} onclick={goBack} title="Back" aria-label="Back">
          <span aria-hidden="true">←</span>
          {#if histIndex > 0}<Kbd keys={["cmd", "["]} />{/if}
        </button>
        <button class="ts-nav shortcut" disabled={histIndex >= hist.length - 1} onclick={goForward} title="Forward" aria-label="Forward">
          <span aria-hidden="true">→</span>
          {#if histIndex < hist.length - 1}<Kbd keys={["cmd", "]"]} />{/if}
        </button>
        <span class="ts-loc" title={view?.path}>
          {#if view}{view.path}{#if view.line != null}:{view.line}{/if}{:else}no file{/if}
        </span>
        {#if !(fileOpen && findOpen)}
          <span class="ts-hint">ctrl+click → definition{onOpenHistory ? " · right-click → mention history" : ""}</span>
        {/if}
        {#if fileOpen || workspace}
          <FileFind bind:this={fileFind} bind:open={findOpen} root={editorEl} lines={preview?.status === "ready" ? preview.lines : []} revision={preview} />
        {/if}
        <button class="ts-nav shortcut" onclick={fileOpen ? closeFile : close} title={fileOpen ? "Back to results" : "Close"} aria-label={fileOpen ? "Back to results" : "Close"}>
          <span aria-hidden="true">✕</span>
          <Kbd keys="esc" />
        </button>
      </div>
      <div
        class="ts-editor mono"
        tabindex="-1"
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
    {#if quickOpen}
      <div
        class="ts-quick-scrim"
        role="presentation"
        onmousedown={(e) => {
          e.preventDefault();
          closeQuickOpen();
        }}
      >
        <div class="ts-quick" role="dialog" tabindex="-1" aria-label="Go to file" onmousedown={(e) => e.stopPropagation()}>
          <input
            class="ts-input mono"
            bind:this={quickInputEl}
            bind:value={quickQuery}
            oninput={() => {
              quickSelected = 0;
              quickScrollTop = 0;
              if (quickListEl) quickListEl.scrollTop = 0;
            }}
            placeholder="Go to file…"
            spellcheck="false"
            autocomplete="off"
          />
          {#if filesStatus !== "ok" || !quickResults.length}
            <div class="ts-count">
              {#if filesStatus === "loading"}loading…
              {:else if filesStatus === "fetching"}fetching…
              {:else if filesStatus === "fetch-failed"}cache fetch failed
              {:else if filesStatus === "not-found"}sha not found
              {:else if filesStatus !== "ok"}request failed
              {:else}no matches{/if}
            </div>
          {/if}
          <div class="ts-list" bind:this={quickListEl} onmousemove={trackMouse} onscroll={(event) => (quickScrollTop = event.currentTarget.scrollTop)}>
            <div style:height="{quickStart * QUICK_ROW_HEIGHT}px" aria-hidden="true"></div>
            {#each quickResults.slice(quickStart, quickEnd) as item, offset (item.path)}
              {@const i = quickStart + offset}
              <button
                class="ts-item mono"
                tabindex="-1"
                class:active={i === quickSelected}
                onmouseenter={(e) => {
                  if (e.screenX !== lastMouseX || e.screenY !== lastMouseY) quickSelected = i;
                }}
                onclick={() => commitQuickOpen(i)}
              >
                <span class="ts-name">{#if item.positions}{@render marked(tail(item.path), positionRanges(item.positions, item.path.lastIndexOf("/") + 1))}{:else}{tail(item.path)}{/if}</span>
                <span class="ts-dir">{#if item.positions}{@render marked(item.path, positionRanges(item.positions))}{:else}{item.path}{/if}</span>
                {#if item.changed}<span class="ts-diff badge review">diff</span>{/if}
                {#if i === quickSelected}<Kbd keys="enter" />{/if}
              </button>
            {/each}
            <div style:height="{Math.max(0, quickResults.length - quickEnd) * QUICK_ROW_HEIGHT}px" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    {/if}
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
  .ts-root.full {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .ts-root.full .ts-side {
    display: none;
  }
  :global(.app-shell.shell) .ts-root.full .ts-bar {
    padding-left: 84px;
  }
  .ts-side {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
  }
  .ts-tabs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  :global(.app-shell.shell) .ts-tabs {
    padding-left: 84px;
  }
  .ts-source {
    display: flex;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--text-faint);
    font-size: 11px;
  }
  .ts-source .ts-context { margin-left: 0; flex: 1; }
  .ts-context {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .ts-hl {
    background: none;
    color: var(--link);
    font-weight: 600;
  }
  .ts-hit {
    background: color-mix(in srgb, var(--review) 30%, transparent);
    border-radius: 2px;
  }
  .ts-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 140ms ease, box-shadow 140ms ease, transform 140ms var(--ease-out);
  }
  .ts-tab.on {
    background: var(--surface);
    box-shadow: var(--shadow-control-selected);
    color: var(--text);
  }
  .ts-tab:active {
    transform: scale(0.99);
  }
  @media (hover: hover) and (pointer: fine) {
    .ts-tab:hover {
      background: var(--surface);
    }
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
  .ts-nav.shortcut {
    width: auto;
    padding: 0 4px;
    gap: 4px;
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
    font-family: var(--mono);
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
  .ts-editor:focus {
    outline: none;
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
  .ts-quick-scrim {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
  }
  .ts-quick {
    display: flex;
    flex-direction: column;
    width: min(600px, calc(100% - 32px));
    max-height: 60vh;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
  }
  .ts-quick .ts-item {
    padding-left: 14px;
    height: 28px;
    box-sizing: border-box;
  }
  .ts-quick .ts-list {
    padding: 0;
  }
  .ts-quick .ts-name {
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
