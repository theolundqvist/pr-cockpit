<script>
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
    treeEl?.querySelector(".file.selected")?.scrollIntoView({ block: "nearest" });
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
      <span class="caret">{collapsedDirs.has(dir.path) ? "▸" : "▾"}</span>
      <span class="folder-icon"></span>
      <span class="name">{dir.name}</span>
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
    gap: 6px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 13px;
    padding: 5px 8px;
    cursor: pointer;
    border-radius: 5px;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--panel-raised);
  }
  .file.selected {
    background: var(--panel-raised);
    color: var(--text);
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
  .caret {
    flex: none;
    width: 10px;
    color: var(--text-faint);
    font-size: 9px;
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
    min-height: 30px;
    border: 1px solid transparent;
    border-radius: 7px;
  }
  @media (hover: hover) and (pointer: fine) {
    .row:hover {
      background: var(--panel);
      border-color: var(--border);
    }
  }
  .file.selected {
    background: var(--panel);
    border-color: var(--border);
    box-shadow: var(--shadow-xs);
  }
</style>
