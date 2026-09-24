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
        icon: fileIcon(name),
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

  const iconByExtension = Object.fromEntries([
    [["ts", "tsx", "js", "jsx", "mjs", "cjs", "svelte", "vue", "html", "py", "rs", "go", "swift", "java", "sh"], "code"],
    [["json", "jsonc", "yaml", "yml", "toml", "xml"], "data"],
    [["css", "scss", "sass", "less"], "style"],
    [["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"], "image"],
    [["md", "mdx", "txt", "rst"], "text"],
    [["sql", "sqlite", "db"], "database"],
  ].flatMap(([extensions, icon]) => extensions.map((extension) => [extension, icon])));
  function fileIcon(name) {
    return iconByExtension[name.split(".").pop().toLowerCase()] ?? "file";
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
      const row = treeEl.querySelector(".file.selected");
      if (!row) return;
      const rowRect = row.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (rowRect.top < rootRect.top) root.scrollTop -= rootRect.top - rowRect.top;
      else if (rowRect.bottom > rootRect.bottom) root.scrollTop += rowRect.bottom - rootRect.bottom;
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
        <svg class="folder-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 4.5V3a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
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
        {#if value.isRenamed}
          <svg class="moved-icon" viewBox="0 0 12 12" aria-label="Moved file">
            <path d="M1 3h7V1l3 3-3 3V5H1zm10 6H4v2L1 8l3-3v2h7z"></path>
          </svg>
        {:else}
          <span class="dot {value.tone}"></span>
        {/if}
        <svg class="file-icon {value.icon}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 1.5h6l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 1.5v4h4" />
          {#if value.icon === "code"}
            <path d="m6.5 8-2 1.5 2 1.5m3-3 2 1.5-2 1.5" />
          {:else if value.icon === "data"}
            <path d="M6.5 7c-1 0-1 .7-1 1.4s-.4 1.1-1 1.1c.6 0 1 .4 1 1.1S5.5 12 6.5 12m3-5c1 0 1 .7 1 1.4s.4 1.1 1 1.1c-.6 0-1 .4-1 1.1S10.5 12 9.5 12" />
          {:else if value.icon === "style"}
            <circle cx="8" cy="9.5" r="2.2" />
            <path d="M8 6.5v.8m0 4.4v.8m-3-3h.8m4.4 0h.8" />
          {:else if value.icon === "image"}
            <circle cx="6" cy="7.5" r=".8" />
            <path d="m4.5 12 2.4-2.5 1.5 1.4 1.3-1.3 2 2.4" />
          {:else if value.icon === "database"}
            <ellipse cx="8" cy="8" rx="3.2" ry="1.3" />
            <path d="M4.8 8v3c0 .7 1.4 1.3 3.2 1.3s3.2-.6 3.2-1.3V8" />
          {:else if value.icon === "text"}
            <path d="M5 8h6m-6 2h6m-6 2h4" />
          {/if}
        </svg>
        <span class="name">{value.name}</span>
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
  .folder-icon, .file-icon {
    flex: none;
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .folder-icon { color: #c98632; }
  .file-icon { color: var(--text-faint); }
  .file-icon.code { color: #5892df; }
  .file-icon.data { color: #c49230; }
  .file-icon.style { color: #aa74d4; }
  .file-icon.image { color: #6caa75; }
  .file-icon.database { color: #b77d4c; }
  .dir .name {
    color: var(--text-dim);
    font-weight: 500;
    flex: 1;
    min-width: 0;
    direction: rtl;
    text-align: left;
  }
  .moved-icon {
    flex: none;
    width: 10px;
    height: 10px;
    color: var(--review);
    fill: currentColor;
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

  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .row {
      min-height: 44px;
    }
  }
</style>
