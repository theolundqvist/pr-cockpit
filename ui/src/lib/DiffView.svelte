<script>
  import { tick } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import Thread from "./Thread.svelte";
  import MutationBadge from "./MutationBadge.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import { getHighlighter, ensureTheme, langForPath, tokenizeLine } from "./highlight.js";
  import { renderMarkdown } from "./markdown.js";
  import { theme } from "./theme.svelte.js";
  import { buildWholeFile, buildGapRows, fileUsesSplitLayout, hunkOldOffset, revertHunk, splitDiffRows } from "./diff.js";
  import { fetchFileContents } from "./api.js";
  import { columnWithin, createDefinitionHover, tokenAtPoint } from "./wordAtPoint.js";

  let {
    files,
    anchored,
    threadProps,
    collapsed,
    onToggleFile,
    viewed = new Set(),
    onToggleViewed = null,
    repo,
    headSha,
    pendingInline,
    onInlineComment,
    onRetryMutation,
    onDiscardMutation,
    commentable = true,
    editable = false,
    onCommitFileEdit = null,
    base = null,
    onOpenHistory = null,
    onLookupDefinition = null,
    layout = "split",
  } = $props();

  const definitionHover = createDefinitionHover(() => onLookupDefinition);
  $effect(() => () => definitionHover.destroy());

  let openKey = $state(null);
  let openCtx = $state(null);
  let draft = $state("");
  let submitting = $state(false);
  let copiedPath = $state(null);
  let copiedTimer;
  let fileEditor = $state(null);
  let fileEditRequest;
  let editMenu = $state(null);
  let editMenuRequest = 0;
  let editMenuNode;
  let commentDrag = $state(null);
  let fileEditSpan = $derived.by(() => {
    if (!fileEditor || fileEditor.phase === "loading" || fileEditor.phase === "error") return null;
    return changedLineSpan(fileEditor.original, fileEditor.content);
  });

  $effect(() => {
    if (!editMenu) return;
    const dismiss = () => (editMenu = null);
    const dismissOutside = (event) => {
      if (!editMenuNode?.contains(event.target)) dismiss();
    };
    const dismissKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", dismissKey);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", dismissKey);
    };
  });

  function copyPath(e, path) {
    e.stopPropagation();
    navigator.clipboard.writeText(path).then(() => {
      copiedPath = path;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copiedPath = null), 1200);
    }, () => {});
  }

  // 1-based head-file line + 0-based column of a clicked token; null for
  // deleted rows (no head position) so lookup falls back to symbol-only.
  function linePosition(lineEl, token) {
    const newNum = Number(lineEl.dataset.newLine);
    const code = lineEl.querySelector(".code");
    if (!code || !Number.isInteger(newNum) || newNum <= 0) return null;
    const character = columnWithin(code, token);
    return character == null ? null : { line: newNum, character };
  }

  function onCodeMouseDown(e, file) {
    if (!onLookupDefinition || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    const token = tokenAtPoint(e.clientX, e.clientY);
    if (!token) return;
    const lineEl = token.node.parentElement?.closest(".line");
    if (!lineEl) return;
    e.preventDefault();
    onLookupDefinition(token.word, file.path, linePosition(lineEl, token));
  }

  function renderedFileBody(section) {
    return section.querySelector(".file-diff-content > .hunks, .file-diff-content > .binary, .file-diff-content > div");
  }

  function editPlacement(section, lineEl, column = 0) {
    const line = Number(lineEl?.dataset.newLine);
    if (!Number.isInteger(line) || line <= 0) return null;
    const body = renderedFileBody(section);
    const lineRect = lineEl.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const bodyHeight = Math.max(bodyRect?.height ?? 0, LINE_H * diffLayoutScale);
    return {
      line,
      column,
      rowOffset: Math.max(0, lineRect.top - (bodyRect?.top ?? lineRect.top)),
      bodyHeight,
    };
  }

  function fallbackEditPlacement(section) {
    const bodyHeight = Math.max(renderedFileBody(section)?.getBoundingClientRect().height ?? 0, LINE_H * diffLayoutScale);
    return { line: 1, column: 0, rowOffset: 0, bodyHeight };
  }

  function toolbarEditPlacement(button) {
    const section = button.closest(".file");
    const rows = [...section.querySelectorAll(".file-diff-content .line[data-new-line]")].filter(
      (row) => Number(row.dataset.newLine) > 0,
    );
    const headerBottom = section.querySelector(".file-head-row")?.getBoundingClientRect().bottom ?? 0;
    const viewportTop = Math.max(0, headerBottom);
    const row =
      rows.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > viewportTop && rect.top < window.innerHeight;
      }) ?? rows[0];
    return row ? editPlacement(section, row) : fallbackEditPlacement(section);
  }

  function caretAtPoint(x, y) {
    const range = document.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
    const position = document.caretPositionFromPoint?.(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }

  function columnAtPoint(code, x, y) {
    const caret = caretAtPoint(x, y);
    if (caret && code.contains(caret.node)) {
      const range = document.createRange();
      range.setStart(code, 0);
      range.setEnd(caret.node, caret.offset);
      return range.toString().length;
    }
    const text = code.textContent ?? "";
    if (!text) return 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = getComputedStyle(code).font;
    const characterWidth = context.measureText("M").width || 1;
    return Math.max(0, Math.min(text.length, Math.round((x - code.getBoundingClientRect().left) / characterWidth)));
  }
  function selectionEndpoint(section, node, offset) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const code = element?.closest(".code");
    const lineEl = code?.closest(".line");
    const line = Number(lineEl?.dataset.newLine);
    if (!code || lineEl?.closest(".file") !== section || !Number.isInteger(line) || line <= 0) return null;
    const range = document.createRange();
    range.setStart(code, 0);
    range.setEnd(node, offset);
    return { line, column: range.toString().length };
  }

  function selectedEditRange(section, event) {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !event.target.closest(".code")) return null;
    const range = selection.getRangeAt(0);
    const start = selectionEndpoint(section, range.startContainer, range.startOffset);
    const end = selectionEndpoint(section, range.endContainer, range.endOffset);
    const caret = caretAtPoint(event.clientX, event.clientY);
    if (!start || !end || !caret || !range.isPointInRange(caret.node, caret.offset)) return null;
    return start.line < end.line || (start.line === end.line && start.column <= end.column)
      ? { from: start, to: end }
      : { from: end, to: start };
  }

  async function positionEditMenu(request, clientX, clientY) {
    await tick();
    if (editMenuRequest !== request || !editMenu || !editMenuNode) return;
    const rect = editMenuNode.getBoundingClientRect();
    const app = editMenuNode.closest("#app");
    const scale = Number.parseFloat(getComputedStyle(app).zoom);
    const viewportX = Math.max(8, Math.min(clientX, Math.max(8, window.innerWidth - rect.width - 8)));
    const viewportY = Math.max(8, Math.min(clientY, Math.max(8, window.innerHeight - rect.height - 8)));
    // Fixed descendants of a zoomed #app use pre-zoom coordinates while pointer and menu rects use viewport coordinates.
    editMenu = { ...editMenu, x: (viewportX - rect.left) / scale, y: (viewportY - rect.top) / scale };
  }

  function onEditContextMenu(event, file) {
    if (!editable || file.isBinary || file.isDeleted || fileEditor) return;
    const hunkNode = event.target.closest("[data-hunk-index]");
    const hunkIndex = Number(hunkNode?.dataset.hunkIndex);
    const hunk = !file.isNew && Number.isInteger(hunkIndex) ? file.hunks[hunkIndex] : null;
    const lineEl = event.target.closest(".line");
    const line = Number(lineEl?.dataset.newLine);
    const section = event.currentTarget.closest(".file");
    let placement = null;
    if (lineEl && Number.isInteger(line) && line > 0) {
      const code = lineEl.querySelector(".code");
      const column = code && event.clientX >= code.getBoundingClientRect().left ? columnAtPoint(code, event.clientX, event.clientY) : 0;
      placement = editPlacement(section, lineEl, column);
    }
    if (!placement && !hunk) return;
    const selection = placement ? selectedEditRange(section, event) : null;
    const menu = {
      file,
      hunk,
      canEdit: !!placement,
      placement: placement
        ? selection
          ? { ...placement, selection }
          : placement
        : fallbackEditPlacement(section),
      x: 0,
      y: 0,
    };
    event.preventDefault();
    editMenu = menu;
    positionEditMenu(++editMenuRequest, event.clientX, event.clientY);
  }

  function startContextEdit() {
    if (!editMenu?.canEdit) return;
    const { file, placement } = editMenu;
    editMenu = null;
    startFileEdit(file, placement);
  }

  function startContextRevert() {
    if (!editMenu?.hunk) return;
    const { file, hunk, placement } = editMenu;
    editMenu = null;
    startFileEdit(file, placement, {
      apply: (content) => revertHunk(content, hunk),
      message: `Revert hunk in ${file.path.split("/").pop()}`,
    });
  }

  let pendingByLine = $derived.by(() => {
    const map = new Map();
    for (const m of pendingInline) {
      const key = `${m.payload.path}:${m.payload.side}:${m.payload.line}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    return map;
  });

  function rowTarget(row) {
    if (row.type === "del") return { side: "LEFT", line: row.oldNum };
    return { side: "RIGHT", line: row.newNum };
  }

  function commentRange() {
    const context = commentDrag
      ? { path: commentDrag.file.path, side: commentDrag.anchor.side, line: commentDrag.current.line, startLine: commentDrag.anchor.line }
      : openCtx;
    if (!context) return null;
    return {
      path: context.path,
      side: context.side,
      start: Math.min(context.startLine ?? context.line, context.line),
      end: Math.max(context.startLine ?? context.line, context.line),
    };
  }

  function isCommentSelected(file, row) {
    const range = commentRange();
    if (!range) return false;
    const target = rowTarget(row);
    return file.path === range.path && target.side === range.side && target.line >= range.start && target.line <= range.end;
  }

  function isCommentEndpoint(file, target) {
    return commentDrag?.file.path === file.path && commentDrag.current.side === target.side && commentDrag.current.line === target.line;
  }

  function commentTargetAt(x, y) {
    const line = document.elementFromPoint(x, y)?.closest(".line");
    const button = line?.querySelector(".add-comment:not(:disabled)");
    if (!button) return null;
    return {
      path: button.dataset.commentPath,
      side: button.dataset.commentSide,
      line: Number(button.dataset.commentLine),
      hunk: button.dataset.commentHunk,
    };
  }

  function startCommentDrag(event, file, target) {
    if (!commentable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const hunk = event.currentTarget.dataset.commentHunk;
    commentDrag = { file, anchor: target, current: target };

    const move = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      const next = commentTargetAt(pointerEvent.clientX, pointerEvent.clientY);
      if (!next || next.path !== file.path || next.side !== target.side || next.hunk !== hunk || !Number.isInteger(next.line)) return;
      commentDrag = { file, anchor: target, current: next };
    };
    const finish = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const selection = commentDrag;
      commentDrag = null;
      if (!selection) return;
      const startLine = Math.min(selection.anchor.line, selection.current.line);
      const line = Math.max(selection.anchor.line, selection.current.line);
      openComposer(
        file,
        { side: target.side, line },
        startLine === line ? null : { side: target.side, line: startLine },
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function openComposer(file, target, start = null) {
    openKey = `${file.path}:${target.side}:${target.line}`;
    openCtx = {
      path: file.path,
      side: target.side,
      line: target.line,
      ...(start ? { startLine: start.line, startSide: start.side } : {}),
    };
    draft = "";
  }

  function cancelInline() {
    openKey = null;
    openCtx = null;
    draft = "";
  }

  async function submitInline() {
    if (!draft.trim() || submitting) return;
    submitting = true;
    try {
      await onInlineComment({ ...openCtx, body: draft });
      cancelInline();
    } finally {
      submitting = false;
    }
  }

  function composerKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      cancelInline();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submitInline();
    }
  }

  function focusOnMount(node) {
    node.focus();
  }

  $effect(() => {
    if (!commentable && openKey) cancelInline();
  });

  const rowTokens = new SvelteMap();
  const splitRowsCache = new WeakMap();
  function pairedRows(rows) {
    let pairs = splitRowsCache.get(rows);
    if (!pairs) {
      pairs = splitDiffRows(rows);
      splitRowsCache.set(rows, pairs);
    }
    return pairs;
  }
  function usesSplitLayout(file) {
    return fileUsesSplitLayout(file, layout);
  }
  let wholeFile = $state(new Map());
  let gapRows = $state(new Map());

  const HEAD_H = 37;
  const LINE_H = 20;
  const HUNK_HEAD_TEXT_H = 20;
  const HUNK_HEAD_PADDING_H = 6;
  const HUNK_HEAD_BORDER_H = 2;
  const MAX_HIGHLIGHT_LINE = 1000;
  const SLICE_MAX_ROWS = 150;
  const SLICE_BUDGET_MS = 8;
  const IDLE_TIMEOUT_MS = 300;
  let diffLayoutScale = $derived(theme.diffScale / theme.generalScale);
  let generalLayoutScale = $derived(theme.generalScale / 100);

  function estimateHeight(file, isCollapsed, whole = null) {
    if (isCollapsed || file.isBinary) return HEAD_H;
    const split = usesSplitLayout(file);
    if (whole?.status === "ready") {
      return HEAD_H + (split ? pairedRows(whole.rows).length : whole.rows.length) * LINE_H * diffLayoutScale;
    }
    let rows = 0;
    for (const hunk of file.hunks) rows += split ? pairedRows(hunk.rows).length : hunk.rows.length;
    return (
      HEAD_H +
      rows * LINE_H * diffLayoutScale +
      file.hunks.length * (HUNK_HEAD_TEXT_H * diffLayoutScale + HUNK_HEAD_PADDING_H + HUNK_HEAD_BORDER_H / generalLayoutScale)
    );
  }

  function hunkNewBounds(hunk) {
    let first = null;
    let last = null;
    for (const row of hunk.rows) {
      if (row.newNum !== null) {
        if (first === null) first = row.newNum;
        last = row.newNum;
      }
    }
    return { first: first ?? 1, last: last ?? 0 };
  }

  function gapBounds(file, hi) {
    const to = hunkNewBounds(file.hunks[hi]).first;
    const from = hi === 0 ? 0 : hunkNewBounds(file.hunks[hi - 1]).last;
    return { from, to };
  }

  async function expandGap(file, hi) {
    const key = `${file.path}#${hi}`;
    if (gapRows.has(key)) return;
    const { from, to } = gapBounds(file, hi);
    const oldOffset = hunkOldOffset(file.hunks[hi].range);
    if (to - from <= 1) return;
    const loading = new Map(gapRows);
    loading.set(key, "loading");
    gapRows = loading;
    let rows = null;
    try {
      const result = await fetchFileContents(repo, file.path, headSha);
      if (!result.tooLarge) rows = buildGapRows(result.content, from, to, oldOffset);
    } catch {
      rows = null;
    }
    const next = new Map(gapRows);
    if (rows && rows.length) next.set(key, rows);
    else next.delete(key);
    gapRows = next;
  }

  async function toggleWholeFile(file) {
    const current = wholeFile.get(file.path);
    if (current) {
      if (current.status === "loading") return;
      const next = new Map(wholeFile);
      next.delete(file.path);
      wholeFile = next;
      return;
    }
    const loading = new Map(wholeFile);
    loading.set(file.path, { status: "loading" });
    wholeFile = loading;
    let entry;
    try {
      const result = await fetchFileContents(repo, file.path, headSha);
      entry = result.tooLarge
        ? { status: "toolarge" }
        : { status: "ready", rows: buildWholeFile(file, result.content) };
    } catch {
      entry = null;
    }
    const next = new Map(wholeFile);
    if (entry) next.set(file.path, entry);
    else next.delete(file.path);
    wholeFile = next;
  }

  function fileContentLines(content) {
    const endsWithNewline = content.endsWith("\n");
    if (!content) return { lines: [], endsWithNewline };
    const lines = content.split("\n");
    if (endsWithNewline) lines.pop();
    return { lines, endsWithNewline };
  }

  function changedLineSpan(original, content) {
    const { lines: oldLines, endsWithNewline: oldEndsWithNewline } = fileContentLines(original);
    const { lines: newLines, endsWithNewline: newEndsWithNewline } = fileContentLines(content);
    const newlineChanged = oldEndsWithNewline !== newEndsWithNewline;
    let first = 0;
    const shared = Math.min(oldLines.length, newLines.length);
    while (first < shared && oldLines[first] === newLines[first]) first++;

    if (first === oldLines.length && first === newLines.length) {
      if (!newlineChanged) return null;
      const line = Math.max(oldLines.length, newLines.length);
      return {
        oldStart: line || 1,
        oldCount: line ? 1 : 0,
        newStart: line || 1,
        newCount: line ? 1 : 0,
        removed: [],
        added: [],
        beforeContext: line ? (oldLines[line - 1] ?? newLines[line - 1]) : null,
        afterContext: null,
        oldEndsWithNewline,
        newEndsWithNewline,
        newlineChanged,
      };
    }

    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;
    while (oldEnd >= first && newEnd >= first && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    return {
      oldStart: first + 1,
      oldCount: Math.max(0, oldEnd - first + 1),
      newStart: first + 1,
      newCount: Math.max(0, newEnd - first + 1),
      removed: oldLines.slice(first, oldEnd + 1),
      added: newLines.slice(first, newEnd + 1),
      beforeContext: first > 0 ? oldLines[first - 1] : null,
      afterContext: oldEnd + 1 < oldLines.length ? oldLines[oldEnd + 1] : null,
      oldEndsWithNewline,
      newEndsWithNewline,
      newlineChanged,
    };
  }

  function normalizeFileEndings(content) {
    if (!content.includes("\r")) return { content, eol: "\n" };
    if (/\r(?!\n)/.test(content) || content.replace(/\r\n/g, "").includes("\n")) return null;
    return { content: content.replace(/\r\n/g, "\n"), eol: "\r\n" };
  }

  function fileEditError(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  async function startFileEdit(file, placement, change = null) {
    if (!editable || file.isBinary || file.isDeleted || fileEditor || !placement) return;
    const token = {};
    fileEditRequest = token;
    fileEditor = {
      path: file.path,
      expectedHeadOid: headSha,
      eol: "\n",
      original: "",
      content: "",
      message: change?.message ?? "",
      phase: "loading",
      error: null,
      ...placement,
    };
    try {
      const result = await fetchFileContents(repo, file.path, headSha);
      if (fileEditRequest !== token) return;
      const normalized = result.tooLarge ? null : normalizeFileEndings(result.content);
      if (result.tooLarge) {
        fileEditor = { ...fileEditor, phase: "error", error: "This file is too large to edit inline." };
      } else if (!normalized) {
        fileEditor = { ...fileEditor, phase: "error", error: "This file has mixed or bare CR line endings and can't be edited inline." };
      } else {
        fileEditor = {
          ...fileEditor,
          eol: normalized.eol,
          original: normalized.content,
          content: change ? change.apply(normalized.content) : normalized.content,
          phase: change ? "review" : "editing",
        };
      }
      fileEditRequest = null;
    } catch (error) {
      if (fileEditRequest !== token) return;
      fileEditRequest = null;
      fileEditor = { ...fileEditor, phase: "error", error: fileEditError(error, "Couldn't load this file.") };
    }
  }

  function discardFileEdit() {
    if (fileEditor?.phase === "committing") return;
    fileEditRequest = null;
    fileEditor = null;
  }

  export function finishFileEdit() {
    if (!fileEditor) return true;
    if (fileEditor.phase === "loading" || fileEditor.phase === "error") {
      discardFileEdit();
      return true;
    }
    if (fileEditor.phase === "editing" && !fileEditSpan) {
      discardFileEdit();
      return true;
    }
    if (fileEditor.phase === "editing") reviewFileEdit();
    return false;
  }

  export async function openEditor(target) {
    if (fileEditor) {
      finishFileEdit();
      return true;
    }
    if (!editable) return false;
    const index = Math.max(0, target ? files.findIndex((file) => file.path === target.path) : 0);
    const file = files[index];
    const section = document.getElementById(`diff-file-${index}`);
    if (!file || !section || file.isBinary || file.isDeleted) return false;
    if (collapsed.has(file.path)) {
      onToggleFile(file);
      await tick();
    }
    const line = target?.line;
    const row = Number.isInteger(line) ? section.querySelector(`.file-diff-content .line[data-new-line="${line}"]`) : null;
    await startFileEdit(file, row ? editPlacement(section, row) : fallbackEditPlacement(section));
    return true;
  }

  $effect(() => {
    if (!editable && fileEditor && fileEditor.phase !== "committing") finishFileEdit();
  });

  $effect(() => {
    if (!fileEditSpan) return;
    const guardNavigation = (event) => {
      const anchor = event.target.closest?.("a[href]");
      if (!anchor || anchor.target === "_blank") return;
      event.preventDefault();
      reviewFileEdit();
    };
    const guardBrowserNavigation = (event) => {
      if (!event.cancelable) return;
      event.preventDefault();
      reviewFileEdit();
    };
    const guardUnload = (event) => event.preventDefault();
    document.addEventListener("click", guardNavigation, true);
    window.addEventListener("beforeunload", guardUnload);
    window.navigation?.addEventListener("navigate", guardBrowserNavigation);
    return () => {
      document.removeEventListener("click", guardNavigation, true);
      window.removeEventListener("beforeunload", guardUnload);
      window.navigation?.removeEventListener("navigate", guardBrowserNavigation);
    };
  });

  function reviewFileEdit() {
    if (!fileEditor || fileEditor.phase !== "editing") return;
    if (!fileEditSpan) {
      fileEditor.error = "Make a change before reviewing.";
      return;
    }
    fileEditor.error = null;
    fileEditor.phase = "review";
  }

  function returnToFileEdit() {
    if (!fileEditor || fileEditor.phase !== "review") return;
    fileEditor.error = null;
    fileEditor.phase = "editing";
  }

  async function commitFileEdit() {
    if (!fileEditor || fileEditor.phase !== "review") return;
    if (!editable) {
      fileEditor.error = "Editing is only available for the current open pull request.";
      return;
    }
    if (!fileEditSpan) {
      fileEditor.error = "Make a change before committing.";
      return;
    }
    const message = fileEditor.message.trim();
    if (!message) {
      fileEditor.error = "Enter a commit message.";
      return;
    }
    const editor = fileEditor;
    editor.phase = "committing";
    editor.error = null;
    try {
      const content = editor.eol === "\r\n" ? editor.content.replace(/\n/g, "\r\n") : editor.content;
      await onCommitFileEdit(editor.path, editor.expectedHeadOid, content, message);
      if (fileEditor?.path === editor.path) fileEditor = null;
    } catch (error) {
      if (fileEditor?.path === editor.path) {
        fileEditor.phase = "review";
        fileEditor.error = fileEditError(error, "Couldn't commit this file.");
      }
    }
  }


  const hotPaths = new SvelteSet();
  let observer;

  function nearViewport(node, path) {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            hotPaths.add(entry.target.dataset.path);
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "2000px 0px" },
    );
    node.dataset.path = path;
    observer.observe(node);
    return {
      destroy() {
        observer.unobserve(node);
      },
    };
  }

  $effect(() => () => observer?.disconnect());

  // only on empty: range switches reuse keyed sections whose actions won't re-observe
  $effect(() => {
    if (files.length === 0) hotPaths.clear();
  });

  $effect(() => {
    const snapshot = files;
    const hotSnapshot = new Set(hotPaths);
    const wholeSnapshot = wholeFile;
    const gapSnapshot = gapRows;
    const themeName = theme.shiki;
    let cancelled = false;
    (async () => {
      const highlighter = await getHighlighter();
      await ensureTheme(highlighter, themeName);
      if (cancelled) return;
      const loaded = new Set(highlighter.getLoadedLanguages());
      const seen = new Set();
      let sliceStart = performance.now();
      let sliceRows = 0;
      const tokenize = async (rows, lang) => {
        for (const row of rows) {
          if (row.text.length > MAX_HIGHLIGHT_LINE) continue;
          seen.add(row);
          const tokens = tokenizeLine(highlighter, row.text, lang, themeName);
          if (rowTokens.get(row) !== tokens) {
            rowTokens.set(row, tokens);
            sliceRows++;
          }
          if (sliceRows >= SLICE_MAX_ROWS || performance.now() - sliceStart > SLICE_BUDGET_MS) {
            await new Promise((resolve) => requestIdleCallback(resolve, { timeout: IDLE_TIMEOUT_MS }));
            if (cancelled) return false;
            sliceStart = performance.now();
            sliceRows = 0;
          }
        }
        return true;
      };
      for (const file of snapshot) {
        if (!hotSnapshot.has(file.path)) continue;
        const lang = langForPath(file.path);
        if (!lang || !loaded.has(lang)) continue;
        for (const hunk of file.hunks) if (!(await tokenize(hunk.rows, lang))) return;
        const whole = wholeSnapshot.get(file.path);
        if (whole?.status === "ready" && !(await tokenize(whole.rows, lang))) return;
        for (let hi = 0; hi < file.hunks.length; hi++) {
          const g = gapSnapshot.get(`${file.path}#${hi}`);
          if (Array.isArray(g) && !(await tokenize(g, lang))) return;
        }
      }
      for (const row of [...rowTokens.keys()]) {
        if (!seen.has(row)) rowTokens.delete(row);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  function intraSegments(row) {
    const { start, end } = row.intra;
    const tokens = rowTokens.get(row);
    if (!tokens) {
      return [
        { content: row.text.slice(0, start), color: null, intra: false },
        { content: row.text.slice(start, end), color: null, intra: true },
        { content: row.text.slice(end), color: null, intra: false },
      ].filter((seg) => seg.content.length);
    }
    const out = [];
    let off = 0;
    for (const token of tokens) {
      const from = off;
      const to = off + token.content.length;
      off = to;
      const cs = Math.max(start, from);
      const ce = Math.min(end, to);
      if (cs >= ce) {
        out.push({ content: token.content, color: token.color, intra: false });
        continue;
      }
      if (cs > from) out.push({ content: token.content.slice(0, cs - from), color: token.color, intra: false });
      out.push({ content: token.content.slice(cs - from, ce - from), color: token.color, intra: true });
      if (ce < to) out.push({ content: token.content.slice(ce - from), color: token.color, intra: false });
    }
    return out;
  }
</script>

{#snippet codeContent(row)}
  {#if row.intra}
    {#each intraSegments(row) as seg}<span class:intra={seg.intra} style={seg.color ? `color:${seg.color}` : undefined}>{seg.content}</span>{/each}
  {:else if rowTokens.has(row)}
    {#each rowTokens.get(row) as token}<span style="color:{token.color}">{token.content}</span>{/each}
  {:else}
    {row.text}
  {/if}
{/snippet}

{#snippet lineExtras(file, row, includeThreads)}
  {@const target = rowTarget(row)}
  {@const key = target.line !== null ? `${file.path}:${target.side}:${target.line}` : null}
  {#if includeThreads && row.newNum !== null && anchored.has(`${file.path}:${row.newNum}`)}
    <div class="inline-threads">
      {#each anchored.get(`${file.path}:${row.newNum}`) as thread (thread.id)}
        <Thread {thread} {...threadProps(thread)} inline />
      {/each}
    </div>
  {/if}
  {#if key && (openKey === key || pendingByLine.has(key))}
    <div class="inline-compose">
      {#each pendingByLine.get(key) ?? [] as m (m.id)}
        <div class="ip">
          <div class="ip-head mono">
            <span class="ip-author">you</span>
            <MutationBadge state={m.state} onRetry={() => onRetryMutation(m.id)} onDiscard={() => onDiscardMutation(m.id)} />
          </div>
          {#if m.state === "failed" && m.error}<div class="ip-error mono">{m.error}</div>{/if}
          <div class="md">{@html renderMarkdown(m.payload.body)}</div>
        </div>
      {/each}
      {#if openKey === key}
        <div class="compose">
          <textarea
            class="mono"
            placeholder={openCtx?.startLine ? `Comment on lines ${openCtx.startLine}–${target.line}…` : `Comment on line ${target.line}…`}
            bind:value={draft}
            onkeydown={composerKey}
            use:focusOnMount
          ></textarea>
          <div class="compose-actions">
            <button class="cbtn mono" disabled={!draft.trim() || submitting} onclick={submitInline}>
              {submitting ? "Posting…" : "Comment"}
            </button>
            <button class="cbtn ghost mono" onclick={cancelInline}>Cancel</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet lineRow(file, row, hunkIndex)}
  {@const target = rowTarget(row)}
  {@const key = target.line !== null ? `${file.path}:${target.side}:${target.line}` : null}
  <div
    class="line {row.type}"
    class:ws-only={row.wsOnly}
    class:comment-selected={isCommentSelected(file, row)}
    data-new-line={row.newNum ?? undefined}
    data-hunk-index={hunkIndex ?? undefined}
    title={row.wsOnly ? "whitespace-only change" : undefined}
  >
    {#if key}
      <button
        class="add-comment"
        class:active={openKey === key || isCommentEndpoint(file, target)}
        class:disabled={!commentable}
        disabled={!commentable}
        data-comment-path={file.path}
        data-comment-side={target.side}
        data-comment-line={target.line}
        data-comment-hunk={hunkIndex ?? undefined}
        title={commentable ? "Comment on this line or drag to select a range" : "Comments anchor to the latest commit — switch to All changes to comment"}
        aria-label="Comment on this line"
        onpointerdown={(event) => startCommentDrag(event, file, target)}
        onclick={(event) => event.detail === 0 && openComposer(file, target)}
      >+</button>
    {/if}
    <span class="ln">{row.oldNum ?? ""}</span>
    <span class="ln">{row.newNum ?? ""}</span>
    <span class="sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
    <span class="code">{@render codeContent(row)}</span>
  </div>
  {@render lineExtras(file, row, true)}
{/snippet}

{#snippet splitCell(file, row, side, hunkIndex)}
  <div
    class="line split-cell {row?.type ?? "empty"} {side}"
    class:ws-only={row?.wsOnly}
    class:comment-selected={row && (side === "right" || row.type === "del") && isCommentSelected(file, row)}
    data-new-line={row?.newNum ?? undefined}
    data-hunk-index={hunkIndex ?? undefined}
    title={row?.wsOnly ? "whitespace-only change" : undefined}
  >
    {#if row}
      {@const target = rowTarget(row)}
      {@const key = target.line !== null ? `${file.path}:${target.side}:${target.line}` : null}
      {@const canComment = key && (side === "right" || row.type === "del")}
      {#if canComment}
        <button
          class="add-comment"
          class:active={openKey === key || isCommentEndpoint(file, target)}
          class:disabled={!commentable}
          disabled={!commentable}
          data-comment-path={file.path}
          data-comment-side={target.side}
          data-comment-line={target.line}
          data-comment-hunk={hunkIndex ?? undefined}
          title={commentable ? "Comment on this line or drag to select a range" : "Comments anchor to the latest commit — switch to All changes to comment"}
          aria-label="Comment on this line"
          onpointerdown={(event) => startCommentDrag(event, file, target)}
          onclick={(event) => event.detail === 0 && openComposer(file, target)}
        >+</button>
      {/if}
      <span class="ln">{side === "left" ? row.oldNum ?? "" : row.newNum ?? ""}</span>
      <span class="sign">{row.type === "add" ? "+" : row.type === "del" ? "−" : " "}</span>
      <span class="code">{@render codeContent(row)}</span>
    {:else}
      <span class="ln"></span><span class="sign"></span><span class="code"></span>
    {/if}
  </div>
{/snippet}

{#snippet splitPair(file, pair, hunkIndex)}
  <div class="split-row">
    {@render splitCell(file, pair.left, "left", hunkIndex)}
    {@render splitCell(file, pair.right, "right", hunkIndex)}
  </div>
  {#if pair.left && pair.left !== pair.right}
    {@render lineExtras(file, pair.left, false)}
  {/if}
  {#if pair.right}
    {@render lineExtras(file, pair.right, true)}
  {/if}
{/snippet}

{#snippet diffRows(file, rows, hunkIndex)}
  {#if usesSplitLayout(file)}
    {#each pairedRows(rows) as pair}{@render splitPair(file, pair, hunkIndex)}{/each}
  {:else}
    {#each rows as row}{@render lineRow(file, row, hunkIndex)}{/each}
  {/if}
{/snippet}

<div class="diff" class:file-editing={!!fileEditor}>
  {#each files as file, i (file.path)}
    {@const isCollapsed = collapsed.has(file.path)}
    {@const isViewed = viewed.has(file.path)}
    {@const whole = wholeFile.get(file.path)}
    <section class="file" id="diff-file-{i}" style="--est-h:{estimateHeight(file, isCollapsed, whole)}px" use:nearViewport={file.path}>
      <div class="file-head-row">
        <button class="file-head mono" onclick={() => (fileEditor?.path === file.path ? finishFileEdit() : onToggleFile(file))}>
          <span class="caret">{isCollapsed ? "▸" : "▾"}</span>
          <span class="file-path">{file.path}</span>
          <span
            class="path-copy"
            role="button"
            tabindex="-1"
            title="Copy file path"
            aria-label="Copy file path"
            onclick={(e) => copyPath(e, file.path)}
          >
            {#if copiedPath === file.path}✓{:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="10" height="10" rx="1.5" />
                <path d="M15 9V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H9" />
              </svg>
            {/if}
          </span>
          <span class="file-stat">
            {#if file.isNew}<span class="new">new</span>{/if}
            {#if file.isDeleted}<span class="del">deleted</span>{/if}
            <span class="add">+{file.additions}</span>
            <span class="del">−{file.deletions}</span>
          </span>
        </button>
        {#if fileEditor?.path === file.path}
          <div class="file-editor-actions file-editor-header-actions">
            {#if fileEditor.phase === "editing"}
              <button class="cbtn mono" onclick={finishFileEdit}>{fileEditSpan ? "Review changes" : "Close"}</button>
            {:else if fileEditor.phase === "loading" || fileEditor.phase === "error"}
              <button class="cbtn ghost mono" onclick={discardFileEdit}>Close</button>
            {/if}
          </div>
        {:else if !isCollapsed && editable && !file.isBinary && !file.isDeleted}
          <button class="whole-btn file-edit-btn mono" onclick={(event) => startFileEdit(file, toolbarEditPlacement(event.currentTarget))}>edit</button>
        {/if}
        {#if onToggleViewed}
          <button
            class="viewed-btn mono"
            class:active={isViewed}
            aria-pressed={isViewed}
            aria-label={isViewed ? "Mark file unviewed" : "Mark file viewed"}
            onclick={() => onToggleViewed(file)}
          >
            <span class="viewed-check" aria-hidden="true">{isViewed ? "✓" : ""}</span>
            <span class="viewed-label">Viewed</span>
          </button>
        {/if}
        {#if !isCollapsed && !file.isBinary && !file.isDeleted}
          <button class="whole-btn mono" disabled={whole?.status === "loading"} onclick={() => toggleWholeFile(file)}>
            {whole?.status === "ready"
              ? "hunks"
              : whole?.status === "loading"
                ? "loading…"
                : whole?.status === "toolarge"
                  ? "too large"
                  : "whole file"}
          </button>
        {/if}
        {#if onOpenHistory && base}
          <button class="whole-btn mono" onclick={() => onOpenHistory(file.path)}>history</button>
        {/if}
      </div>
      {#if !isCollapsed && fileEditor?.path === file.path}
        {#if fileEditor.phase === "loading"}
          <div class="file-editor-state mono" style="height:{fileEditor.bodyHeight}px">
            <span>loading full file…</span>
          </div>
        {:else if fileEditor.phase === "error"}
          <div class="file-editor-state mono" style="height:{fileEditor.bodyHeight}px">
            <div class="file-edit-error" role="alert">{fileEditor.error}</div>
          </div>
        {:else if fileEditor.phase === "editing"}
          <div class="file-editor" style="height:{fileEditor.bodyHeight}px">
            <div class="file-editor-body">
              <CodeEditor
                path={file.path}
                bind:content={fileEditor.content}
                initialLine={fileEditor.line}
                initialColumn={fileEditor.column}
                rowOffset={fileEditor.rowOffset}
                initialSelection={fileEditor.selection}
                layout={usesSplitLayout(file) ? "split" : "unified"}
                onFinish={finishFileEdit}
              />
            </div>
            {#if fileEditor.error}<div class="file-edit-error file-editor-overlay-error mono" role="alert">{fileEditor.error}</div>{/if}
          </div>
        {:else}
          <div class="file-editor file-edit-review">
            {#if fileEditSpan}
              <div class="file-edit-preview mono">
                <div class="file-edit-hunk">@@ -{fileEditSpan.oldStart},{fileEditSpan.oldCount} +{fileEditSpan.newStart},{fileEditSpan.newCount} @@</div>
                {#if fileEditSpan.beforeContext !== null}<div class="file-edit-context"> {fileEditSpan.beforeContext}</div>{/if}
                {#each fileEditSpan.removed as line}<div class="file-edit-removed">-{line}</div>{/each}
                {#if fileEditSpan.newlineChanged}<div class="file-edit-removed">- {fileEditSpan.oldEndsWithNewline ? "ends with newline" : "no trailing newline"}</div>{/if}
                {#each fileEditSpan.added as line}<div class="file-edit-added">+{line}</div>{/each}
                {#if fileEditSpan.newlineChanged}<div class="file-edit-added">+ {fileEditSpan.newEndsWithNewline ? "ends with newline" : "no trailing newline"}</div>{/if}
                {#if fileEditSpan.afterContext !== null}<div class="file-edit-context"> {fileEditSpan.afterContext}</div>{/if}
              </div>
            {/if}
            <label class="file-edit-message mono">
              Commit message
              <input
                bind:value={fileEditor.message}
                maxlength="200"
                disabled={fileEditor.phase === "committing"}
              />
            </label>
            {#if fileEditor.error}<div class="file-edit-error mono" role="alert">{fileEditor.error}</div>{/if}
            <div class="file-editor-actions">
              <button class="cbtn ghost mono" disabled={fileEditor.phase === "committing"} onclick={returnToFileEdit}>Back</button>
              <button class="cbtn mono" disabled={fileEditor.phase === "committing" || !fileEditor.message.trim()} onclick={commitFileEdit}>
                {fileEditor.phase === "committing" ? "Committing…" : "Commit to PR"}
              </button>
              <button class="cbtn ghost mono" disabled={fileEditor.phase === "committing"} onclick={discardFileEdit}>Ignore changes</button>
            </div>
          </div>
        {/if}
      {/if}
      {#if !isCollapsed}
      <div class="file-diff-content" hidden={fileEditor?.path === file.path}>
        {#if !hotPaths.has(file.path)}
        <div style="height:{estimateHeight(file, false, whole) - HEAD_H}px"></div>
      {:else if file.isBinary}
        <div class="binary mono">Binary file not shown</div>
      {:else if whole?.status === "ready"}
        <div
          class="hunks mono"
          class:split={usesSplitLayout(file)}
          onmousemove={(e) => definitionHover.onMouseMove(e, e.target.closest(".hunks"))}
          onmouseleave={definitionHover.onMouseLeave}
          onmousedown={(e) => onCodeMouseDown(e, file)}
          oncontextmenu={(event) => onEditContextMenu(event, file)}
        >
          {@render diffRows(file, whole.rows, null)}
        </div>
      {:else}
        <div
          class="hunks mono"
          class:split={usesSplitLayout(file)}
          onmousemove={(e) => definitionHover.onMouseMove(e, e.target.closest(".hunks"))}
          onmouseleave={definitionHover.onMouseLeave}
          onmousedown={(e) => onCodeMouseDown(e, file)}
          oncontextmenu={(event) => onEditContextMenu(event, file)}
        >
          {#each file.hunks as hunk, hi}
            {@const gap = gapRows.get(`${file.path}#${hi}`)}
            {@const bounds = gapBounds(file, hi)}
            {@const expandable = !file.isNew && bounds.to - bounds.from > 1}
            {#if Array.isArray(gap)}
              {@render diffRows(file, gap, null)}
            {:else}
              <button
                class="hunk-head"
                class:expandable
                data-hunk-index={hi}
                disabled={!expandable}
                onclick={() => expandGap(file, hi)}
              >
                <span class="ln"></span><span class="ln"></span>
                <span class="hunk-label">{hunk.range}{hunk.context ? " " + hunk.context : ""}</span>
                {#if expandable}<span class="hunk-expand">expand ↕</span>{/if}
              </button>
            {/if}
            {@render diffRows(file, hunk.rows, hi)}
          {/each}
        </div>
      {/if}
      </div>
    {/if}
    </section>
  {/each}
  {#if editMenu}
    <div
      class="edit-context-menu"
      bind:this={editMenuNode}
      role="menu"
      aria-label="Diff actions"
      style="left:{editMenu.x}px;top:{editMenu.y}px"
      oncontextmenu={(event) => event.preventDefault()}
    >
      {#if editMenu.canEdit}
        <button class="mono" role="menuitem" use:focusOnMount onclick={startContextEdit}>Edit here</button>
        {#if editMenu.hunk}<button class="mono" role="menuitem" onclick={startContextRevert}>Revert hunk</button>{/if}
      {:else if editMenu.hunk}
        <button class="mono" role="menuitem" use:focusOnMount onclick={startContextRevert}>Revert hunk</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .diff {
    min-width: 0;
    max-width: 100%;
  }
  .file {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    background: var(--panel);
    min-width: 0;
    max-width: 100%;
    content-visibility: auto;
    contain-intrinsic-size: auto var(--est-h, 400px);
  }
  .file-head-row {
    display: flex;
    align-items: stretch;
    background: var(--panel-raised);
    border-bottom: 1px solid var(--border);
    border-radius: 7px 7px 0 0;
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .file-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 8px 12px;
    background: none;
    border: none;
    font-size: 12.5px;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .file-head:hover {
    background: var(--hunk-hover);
  }
  .viewed-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    min-height: 26px;
    padding: 0 8px;
    border: none;
    border-left: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
  }
  .viewed-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: 1px solid var(--border-hover);
    border-radius: 3px;
    color: var(--ready);
    font-size: 10px;
    font-weight: 700;
  }
  .viewed-btn.active .viewed-check {
    border-color: color-mix(in srgb, var(--ready) 55%, var(--border));
    background: color-mix(in srgb, var(--ready) 12%, transparent);
  }
  .whole-btn {
    flex: none;
    background: none;
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 11.5px;
    padding: 0 12px;
    cursor: pointer;
  }
  .whole-btn:hover:not(:disabled) {
    background: var(--hunk-hover);
    color: var(--text);
  }
  .whole-btn:disabled {
    cursor: default;
    color: var(--text-faint);
  }
  .caret {
    flex: none;
    color: var(--text-faint);
    font-size: 9px;
  }
  .file-path {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path-copy {
    flex: none;
    display: inline-flex;
    align-items: center;
    font-size: 11px;
    color: var(--text-faint);
    cursor: pointer;
  }
  .path-copy:hover {
    color: var(--text);
  }
  .path-copy svg {
    width: 13px;
    height: 13px;
  }
  .file-stat {
    flex: none;
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }
  .file-stat .new {
    color: var(--ready);
  }
  .file-stat .add {
    color: var(--ready);
  }
  .file-stat .del {
    color: var(--fail);
  }
  .binary {
    padding: 14px 16px;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .file-edit-btn {
    color: var(--text-faint);
  }
  .file-editor {
    position: relative;
    min-width: 0;
    background: var(--panel);
  }
  .file-editor-state {
    box-sizing: border-box;
    padding: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
  }
  .file-editor-body {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background: var(--panel);
  }
  .file-editor-actions {
    display: flex;
    gap: 8px;
  }
  .file-editor-header-actions {
    align-items: center;
    flex: none;
    padding: 0 8px;
    border-left: 1px solid var(--border);
  }
  .file-editor-overlay-error {
    position: absolute;
    right: 10px;
    bottom: 10px;
    z-index: 2;
    max-width: min(520px, calc(100% - 20px));
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--panel-raised);
  }
  .file-edit-review {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
  }
  .file-edit-preview {
    max-height: 260px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--code-block-bg);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
  }
  .file-edit-preview > div {
    padding: 1px 10px;
  }
  .file-edit-hunk,
  .file-edit-context {
    color: var(--text-faint);
  }
  .file-edit-hunk {
    border-bottom: 1px solid var(--border-soft);
  }
  .file-edit-removed {
    background: var(--del-bg);
    color: var(--code-fg);
  }
  .file-edit-added {
    background: var(--add-bg);
    color: var(--code-fg);
  }
  .file-edit-message {
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .file-edit-message input {
    min-width: 0;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font: inherit;
  }
  .file-edit-message input:focus {
    outline: none;
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .file-edit-error {
    color: var(--fail);
    font-size: 12px;
  }
  .edit-context-menu {
    position: fixed;
    z-index: 100;
    min-width: 124px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-raised);
    box-shadow: var(--shadow-sm);
  }
  .edit-context-menu button {
    width: 100%;
    padding: 6px 9px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .edit-context-menu button:hover,
  .edit-context-menu button:focus-visible {
    outline: none;
    background: var(--hunk-hover);
  }
  .file-diff-content {
    display: contents;
  }
  .file-diff-content[hidden] {
    display: none;
  }
  .hunks {
    min-width: 0;
    max-width: 100%;
    font-family: var(--code-font);
    font-size: var(--diff-font-size);
    line-height: 1.6;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }
  .hunk-head {
    display: flex;
    align-items: center;
    width: 100%;
    background: var(--code-block-bg);
    color: var(--text-faint);
    border: none;
    border-top: 1px solid var(--border-soft);
    border-bottom: 1px solid var(--border-soft);
    font: inherit;
    text-align: left;
    cursor: default;
  }
  .hunk-head.expandable {
    cursor: pointer;
  }
  .hunk-head.expandable:hover {
    background: var(--hunk-hover);
    color: var(--text-dim);
  }
  .hunk-label {
    padding: 2px 8px;
    white-space: pre;
  }
  .hunk-expand {
    margin-left: auto;
    padding: 2px 10px;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    color: var(--text-faint);
    opacity: 0;
  }
  .hunk-head.expandable:hover .hunk-expand {
    opacity: 1;
  }
  .line {
    display: flex;
    min-width: 100%;
    white-space: pre;
    position: relative;
  }
  .split-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    min-width: 900px;
  }
  .hunks.split .hunk-head,
  .hunks.split .inline-threads,
  .hunks.split .inline-compose {
    min-width: 900px;
  }
  .split-cell.line {
    min-width: 0;
  }
  .split-cell.left {
    border-right: 1px solid var(--border-soft);
  }
  .split-cell.empty {
    background: var(--code-block-bg);
  }
  .add-comment {
    position: absolute;
    left: 2px;
    top: 1px;
    width: 18px;
    height: 18px;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: var(--link);
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    z-index: 2;
  }
  .line:hover .add-comment,
  .add-comment.active {
    display: flex;
  }
  .add-comment:hover:not(.disabled) {
    filter: brightness(1.12);
  }
  .add-comment.disabled {
    background: var(--text-faint);
    cursor: default;
    opacity: 0.7;
  }
  .line.comment-selected {
    box-shadow: inset 3px 0 var(--link);
  }
  .line.add {
    background: var(--add-bg);
  }
  .line.del {
    background: var(--del-bg);
  }
  .line.ws-only {
    border-left: 2px solid var(--border);
  }
  .ln {
    flex: none;
    width: 46px;
    padding: 0 8px;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
    background: var(--ln-tint);
  }
  .sign {
    flex: none;
    width: 20px;
    text-align: center;
    user-select: none;
  }
  .line.add .sign {
    color: var(--add-gutter);
  }
  .line.del .sign {
    color: var(--del-gutter);
  }
  .code {
    flex: 1;
    padding-right: 16px;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: normal;
    min-width: 0;
  }
  .line.add .code,
  .line.del .code {
    color: var(--code-fg);
  }
  .line.add .code .intra {
    background: var(--add-bg-intra);
  }
  .line.del .code .intra {
    background: var(--del-bg-intra);
  }
  .inline-threads {
    min-width: 0;
    max-width: 100%;
    padding: 8px 16px 8px 66px;
    background: var(--inline-thread-bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .inline-compose {
    min-width: 0;
    max-width: 100%;
    padding: 8px 16px 8px 66px;
    background: var(--inline-thread-bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .compose {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .compose textarea {
    width: 100%;
    resize: vertical;
    min-height: 54px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12.5px;
    padding: 8px;
  }
  .compose textarea:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .compose-actions {
    display: flex;
    gap: 8px;
  }
  .cbtn {
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
  }
  .cbtn:hover:not(:disabled) {
    border-color: var(--text-faint);
  }
  .cbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .cbtn.ghost {
    background: none;
    color: var(--text-dim);
  }
  .ip {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    padding: 8px 10px;
  }
  .ip-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 4px;
  }
  .ip-author {
    color: var(--text);
    font-weight: 600;
  }
  .ip-error {
    color: var(--fail);
    font-size: 11.5px;
    margin-bottom: 4px;
  }

  .file {
    border-radius: 12px;
    margin-bottom: 20px;
    box-shadow: var(--shadow-xs);
    overflow: visible;
  }
  .file-head-row {
    min-height: 42px;
    background: var(--surface);
    border-radius: 11px 11px 0 0;
  }
  .file-head {
    padding: 9px 14px;
    font-family: var(--sans);
    font-weight: 600;
    letter-spacing: -0.008em;
  }
  .whole-btn,
  .viewed-btn {
    font-family: var(--sans);
    font-size: 11.5px;
  }
  @media (hover: hover) and (pointer: fine) {
    .file-head:hover,
    .whole-btn:hover:not(:disabled),
    .viewed-btn:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
  }
  @media (max-width: 660px) {
    .viewed-label {
      display: none;
    }
    .viewed-btn {
      padding-inline: 7px;
    }
  }
  .hunk-head {
    background: var(--code-block-bg);
  }
  .compose textarea {
    background: var(--panel);
    border-color: var(--border);
    border-radius: 8px;
  }
  .compose textarea:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .cbtn {
    min-height: 28px;
    border-radius: 7px;
    background: var(--panel);
    border-color: var(--border);
    box-shadow: var(--shadow-xs);
  }
  .ip {
    border-radius: 9px;
    box-shadow: var(--shadow-xs);
  }
</style>
