<script>
  import { tick, untrack } from "svelte";
  import Chevron from "./Chevron.svelte";

  let { files, selectedPath, hoveredPath = null, onSelect } = $props();

  const INDENT = 16;
  let lastSelectedPath = null;
  const ROW_HEIGHT = 32;
  const OVERSCAN = 12;

  let collapsedDirs = $state(new Set());
  let treeEl = $state();
  let windowStart = $state(0);
  let windowEnd = $state(40);

  let tree = $derived.by(() => {
    const root = { name: "", path: "", dirs: new Map(), files: [] };
    files.forEach((file) => {
      const parts = file.path.split("/");
      const name = parts.pop();
      let node = root;
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: acc, dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({
        name,
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        tone: fileTone(file),
        isRenamed: Boolean(file.previousPath),
        isUnchangedRename: file.isUnchangedRename,
      });
    });
    compress(root);
    sumLines(root);
    return root;
  });

  let rows = $derived.by(() => {
    const flattened = [];
    function append(node, depth) {
      for (const dir of node.dirs.values()) {
        flattened.push({ key: `dir:${dir.path}`, kind: "dir", depth, value: dir });
        if (!collapsedDirs.has(dir.path)) append(dir, depth + 1);
      }
      for (const file of node.files) {
        flattened.push({ key: `file:${file.path}`, kind: "file", depth, value: file });
      }
    }
    append(tree, 0);
    return flattened;
  });

  function compress(node) {
    const dirs = new Map();
    for (let dir of node.dirs.values()) {
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        const child = [...dir.dirs.values()][0];
        dir = { name: `${dir.name}/${child.name}`, path: child.path, dirs: child.dirs, files: child.files };
      }
      compress(dir);
      dirs.set(dir.path, dir);
    }
    node.dirs = dirs;
  }

  function sumLines(node) {
    let additions = node.files.reduce((sum, file) => sum + file.additions, 0);
    let deletions = node.files.reduce((sum, file) => sum + file.deletions, 0);
    for (const dir of node.dirs.values()) {
      sumLines(dir);
      additions += dir.additions;
      deletions += dir.deletions;
    }
    node.additions = additions;
    node.deletions = deletions;
  }

  function fileTone(file) {
    if (file.isNew) return "new";
    if (file.isDeleted) return "del";
    return "mod";
  }

  function updateWindow() {
    if (!treeEl) return;
    const root = treeEl.parentElement;
    const treeTop = treeEl.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const top = Math.max(0, root.scrollTop - treeTop);
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + root.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    if (start !== windowStart) windowStart = start;
    if (end !== windowEnd) windowEnd = end;
  }

  function toggleDir(path) {
    const next = new Set(collapsedDirs);
    next.has(path) ? next.delete(path) : next.add(path);
    collapsedDirs = next;
  }

  $effect(() => {
    const element = treeEl;
    if (!element) return;
    const root = element.parentElement;
    let frame = null;
    const scheduleWindow = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        updateWindow();
      });
    };
    const resize = new ResizeObserver(scheduleWindow);
    root.addEventListener("scroll", scheduleWindow, { passive: true });
    resize.observe(root);
    untrack(scheduleWindow);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", scheduleWindow);
      resize.disconnect();
    };
  });

  $effect(() => {
    rows.length;
    void tick().then(updateWindow);
  });

  $effect(() => {
    const path = selectedPath;
    if (path === lastSelectedPath) return;
    lastSelectedPath = path;
    const index = rows.findIndex((row) => row.kind === "file" && row.value.path === path);
    if (index < 0) return;
    void tick().then(async () => {
      if (!treeEl) return;
      const root = treeEl.parentElement;
      const treeTop = treeEl.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      const top = treeTop + index * ROW_HEIGHT;
      if (top < root.scrollTop) root.scrollTop = top;
      else if (top + ROW_HEIGHT > root.scrollTop + root.clientHeight) root.scrollTop = top + ROW_HEIGHT - root.clientHeight;
      updateWindow();
      await tick();
      treeEl.querySelector(".file.selected")?.scrollIntoView({ block: "nearest" });
    });
  });
</script>

{#snippet rails(depth)}
  {#if depth}
    <span class="rails" style="--depth:{depth}" aria-hidden="true"></span>
  {/if}
{/snippet}

<div class="tree" bind:this={treeEl}>
  <div class="spacer" style="height:{windowStart * ROW_HEIGHT}px" aria-hidden="true"></div>
  {#each rows.slice(windowStart, windowEnd) as row (row.key)}
    {@const value = row.value}
    {#if row.kind === "dir"}
      <button class="row dir" style="padding-left: {row.depth * INDENT + 8}px" onclick={() => toggleDir(value.path)}>
        {@render rails(row.depth)}
        <Chevron direction={collapsedDirs.has(value.path) ? "right" : "down"} size={12} />
        <span class="folder-icon"></span>
        <span class="name">{value.name}</span>
        <span class="counts mono"><span class="add">+{value.additions}</span><span class="del">−{value.deletions}</span></span>
      </button>
    {:else}
      <button
        class="row file"
        class:selected={value.path === selectedPath}
        class:hovered={value.path === hoveredPath}
        style="padding-left: {row.depth * INDENT + 8}px"
        onclick={() => onSelect(value.path)}
      >
        {@render rails(row.depth)}
        <span class="dot {value.tone}"></span>
        <span class="name">{value.name}</span>
        {#if value.isRenamed}<span class="renamed">renamed</span>{/if}
        {#if !value.isUnchangedRename}
          <span class="counts mono"><span class="add">+{value.additions}</span><span class="del">−{value.deletions}</span></span>
        {/if}
      </button>
    {/if}
  {/each}
  <div class="spacer" style="height:{Math.max(0, rows.length - windowEnd) * ROW_HEIGHT}px" aria-hidden="true"></div>
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
  }
  .spacer {
    flex: none;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 400;
    line-height: 18px;
    padding: 0 8px;
    cursor: pointer;
    border-radius: 8px;
    white-space: nowrap;
  }
  .row:hover,
  .row.hovered {
    background: var(--ghost-hover);
  }
  .file.selected {
    background: var(--link-bg);
    color: var(--text);
  }
  .file.selected::before {
    content: "";
    position: absolute;
    left: 0;
    width: 2px;
    height: 16px;
    border-radius: 999px;
    background: var(--link);
  }
  .rails {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 13px;
    width: calc(var(--depth) * 16px);
    background: repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px 16px);
    pointer-events: none;
  }
  .folder-icon {
    flex: none;
    position: relative;
    width: 12px;
    height: 9px;
    background: var(--text-faint);
    border-radius: 0 2px 2px 2px;
  }
  .folder-icon::before {
    content: "";
    position: absolute;
    top: -2px;
    left: 0;
    width: 6px;
    height: 2px;
    background: var(--text-faint);
    border-radius: 2px 2px 0 0;
  }
  .dir .name {
    color: var(--text-dim);
    font-weight: 500;
    flex: 1;
    min-width: 0;
    direction: rtl;
    text-align: left;
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 2px;
  }
  .dot.new {
    background: var(--ready);
  }
  .dot.del {
    background: var(--fail);
  }
  .dot.mod {
    background: var(--review);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file .name {
    flex: 1;
    min-width: 0;
  }
  .renamed {
    flex: none;
    color: var(--text-faint);
    font-size: 11px;
  }
  .counts {
    flex: none;
    font-size: 11px;
    display: flex;
    gap: 5px;
  }
  .counts .add {
    color: var(--ready);
  }
  .counts .del {
    color: var(--fail);
  }

  .row {
    min-height: 32px;
    border: 0;
    border-radius: 8px;
  }
  @media (hover: hover) and (pointer: fine) {
    .row:hover {
      background: var(--ghost-hover);
    }
  }
  .file.selected {
    background: var(--link-bg);
    box-shadow: none;
  }
</style>
