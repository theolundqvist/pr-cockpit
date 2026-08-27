<script>
  import Chevron from "./Chevron.svelte";

  let { files, selectedPath, onSelect } = $props();

  const INDENT = 16;
  const RAIL_OFFSET = 13;

  let collapsedDirs = $state(new Set());

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
      node.files.push({ name, path: file.path, additions: file.additions, deletions: file.deletions, tone: fileTone(file) });
    });
    compress(root);
    sumLines(root);
    return root;
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

  function toggleDir(path) {
    const next = new Set(collapsedDirs);
    next.has(path) ? next.delete(path) : next.add(path);
    collapsedDirs = next;
  }

  let treeEl;

  $effect(() => {
    if (!selectedPath) return;
    const row = treeEl?.querySelector(".file.selected");
    const pane = treeEl?.parentElement;
    if (!row || !pane) return;
    const rowRect = row.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    if (rowRect.top < paneRect.top) pane.scrollTop -= paneRect.top - rowRect.top;
    else if (rowRect.bottom > paneRect.bottom) pane.scrollTop += rowRect.bottom - paneRect.bottom;
  });
</script>

{#snippet rails(depth)}
  {#if depth}
    <span class="rails" aria-hidden="true">
      {#each Array.from({ length: depth }) as _, i (i)}
        <span class="rail" style="left: {i * INDENT + RAIL_OFFSET}px"></span>
      {/each}
    </span>
  {/if}
{/snippet}

{#snippet branch(node, depth)}
  {#each [...node.dirs.values()] as dir (dir.path)}
    <button class="row dir" style="padding-left: {depth * INDENT + 8}px" onclick={() => toggleDir(dir.path)}>
      {@render rails(depth)}
      <Chevron direction={collapsedDirs.has(dir.path) ? "right" : "down"} size={12} />
      <span class="folder-icon"></span>
      <span class="name">{dir.name}</span>
      <span class="counts mono"><span class="add">+{dir.additions}</span><span class="del">−{dir.deletions}</span></span>
    </button>
    {#if !collapsedDirs.has(dir.path)}
      {@render branch(dir, depth + 1)}
    {/if}
  {/each}
  {#each node.files as file (file.path)}
    <button
      class="row file"
      class:selected={file.path === selectedPath}
      style="padding-left: {depth * INDENT + 8}px"
      onclick={() => onSelect(file.path)}
    >
      {@render rails(depth)}
      <span class="dot {file.tone}"></span>
      <span class="name">{file.name}</span>
      <span class="counts mono"><span class="add">+{file.additions}</span><span class="del">−{file.deletions}</span></span>
    </button>
  {/each}
{/snippet}

<div class="tree" bind:this={treeEl}>
  {@render branch(tree, 0)}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
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
  .row:hover {
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
    inset: 0;
    pointer-events: none;
  }
  .rail {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
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
