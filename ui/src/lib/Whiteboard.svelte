<script>
  import { onMount, untrack, tick } from "svelte";
  import Avatar from "./Avatar.svelte";
  import ActionStatusIcon from "./ActionStatusIcon.svelte";
  import { classify } from "./whoseMove.js";
  import { isTypingTarget } from "./dom.js";
  import { board, loadBoard, reconcile, queueSave, beginInteraction, endInteraction, commit, undoBoard, saveBoard, resolveConflict, exportBoard } from "./whiteboard.svelte.js";
  import { GRID, snap, bounds, contains, intersects, movingIds, moveNodes, personalState, removeNodes } from "../../../shared/whiteboard.js";

  let { prs, groups, viewerLogin, active = true, refreshRevision = 0 } = $props();
  let host = $state();
  let tool = $state("select");
  let color = $state("blue");
  let space = $state(false);
  let gesture = $state.raw(null);
  let marquee = $state(null);
  let query = $state("");
  let searchInput = $state();
  let editor = $state(null);
  let help = $state(false);
  let announcement = $state("");
  let ready = $state(false);
  let refreshToken = 0;
  const tools = [
    { id: "select", label: "Select", key: "V", path: "m5 3 12 8-6 1-3 6Z" },
    { id: "hand", label: "Pan", key: "H", path: "M7 10V6a1 1 0 0 1 2 0V4a1 1 0 0 1 2 0v2a1 1 0 0 1 2 0v1a1 1 0 0 1 2 0v6c0 4-2 5-5 5-2 0-3-1-4-3l-2-4a1 1 0 0 1 2-1l1 1" },
    { id: "section", label: "Section", key: "F", path: "M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M3 7h14" },
    { id: "pen", label: "Pen", key: "P", path: "m4 13 9-9 3 3-9 9-4 1ZM11 6l3 3" },
    { id: "text", label: "Note", key: "T", path: "M4 5V3h12v2M10 3v14M7 17h6" },
    { id: "connector", label: "Connector", key: "C", path: "M3 16 16 3M9 3h7v7" },
  ];
  const colors = ["blue", "orange", "green", "purple", "gray"];
  let doc = $derived(board.document);
  let hasDocument = $derived(!!doc);
  let nodes = $derived(doc?.nodes ?? []);
  let view = $derived(doc?.viewport ?? { x: 32, y: 32, zoom: 1 });
  let selection = $derived(new Set(doc?.selection ?? []));
  let selectedNodes = $derived(nodes.filter((n) => selection.has(n.id)));
  let matches = $derived(query.trim() ? nodes.filter((n) => {
    const pr = doc.snapshots[n.key];
    return `${pr?.title ?? ""} ${pr?.repo ?? ""} #${pr?.number ?? ""} ${pr?.author ?? ""} ${n.text ?? ""} ${n.note ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  }) : []);
  let completed = $derived(nodes.filter((n) => n.type === "pr" && ["MERGED", "CLOSED"].includes(doc.snapshots[n.key]?.state)));

  onMount(() => {
    let alive = true;
    loadBoard().then(() => { if (alive) ready = true; });
    return () => { alive = false; cancelGesture(); endEdit(); void saveBoard(); };
  });
  $effect(() => {
    if (!ready || !active || !hasDocument || gesture || editor) return;
    const rows = prs;
    const initialGroups = groups;
    untrack(() => reconcile(rows, initialGroups));
  });
  $effect(() => {
    if (!ready || !active) return;
    refreshRevision;
    const token = ++refreshToken;
    untrack(async () => { await loadBoard(); if (token === refreshToken && active && !gesture && !editor) reconcile(prs, groups); });
  });
  $effect(() => { if (!active) untrack(() => { cancelGesture(); endEdit(); space = false; void saveBoard(); }); });

  function local(event) {
    const rect = host.getBoundingClientRect();
    const scale = rect.width / host.offsetWidth;
    return { x: (event.clientX - rect.left) / scale - host.clientLeft, y: (event.clientY - rect.top) / scale - host.clientTop };
  }
  const world = (p) => ({ x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom });
  function select(ids) { board.document = { ...doc, selection: [...ids] }; }
  function setNodes(next) { board.document = { ...doc, nodes: next }; }
  function setView(next) { board.document = { ...doc, viewport: next }; }
  let lastDragAt = 0;
  function doubleClick(event) {
    if (tool !== "select" || space || Date.now() - lastDragAt < 350) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element?.closest("button,input,textarea,a")) return;
    const node = nodes.find((n) => n.id === element?.closest("[data-node]")?.dataset.node);
    if (node?.type === "pr") openPr(node);
    else if (node && ["text", "section"].includes(node.type)) beginEdit(node.id, "text");
  }
  function chooseTool(next) { cancelGesture(); endEdit(); tool = next; host?.focus(); }
  function centerBounds(box, zoom = view.zoom) {
    setView({ zoom, x: host.clientWidth / 2 - (box.x + box.w / 2) * zoom, y: host.clientHeight / 2 - (box.y + box.h / 2) * zoom });
    queueSave();
  }
  function fit() {
    const box = bounds(nodes);
    centerBounds(box, Math.max(.15, Math.min(1, (host.clientWidth - 96) / Math.max(box.w, 1), (host.clientHeight - 96) / Math.max(box.h, 1))));
  }
  function zoomAt(factor, p = { x: host.clientWidth / 2, y: host.clientHeight / 2 }) {
    const point = world(p);
    const zoom = Math.max(.15, Math.min(3, view.zoom * factor));
    setView({ zoom, x: p.x - point.x * zoom, y: p.y - point.y * zoom });
    queueSave();
  }
  function wheel(event) {
    if (!doc || editor || gesture) return;
    event.preventDefault();
    zoomAt(Math.exp(-event.deltaY * .008), local(event));
  }
  function targetNode(event) { return nodes.find((n) => n.id === event.target.closest?.("[data-node]")?.dataset.node); }
  function pointerDown(event) {
    if (!doc || event.button > 1 || event.target.closest(".help-panel")) return;
    const pan = space || tool === "hand" || event.button === 1;
    if (!pan && event.target.closest("input,textarea,button,a")) return;
    event.preventDefault();
    endEdit();
    host.focus();
    const p = local(event), start = world(p), target = targetNode(event);
    const before = personalState(doc), previousSelection = [...doc.selection];
    let kind = pan ? "pan" : tool;
    let ids = new Set();
    let created = null;
    if (!pan && event.target.closest("[data-resize]")) kind = "resize";
    if (kind === "select" && target) {
      if (event.shiftKey) { const next = new Set(selection); if (next.has(target.id)) next.delete(target.id); else next.add(target.id); select(next); }
      else if (!selection.has(target.id)) select([target.id]);
      ids = movingIds(nodes, doc.selection);
      kind = "move";
    } else if (kind === "select") {
      if (!event.shiftKey) select([]);
      kind = "marquee";
    } else if (["section", "pen", "connector", "text"].includes(kind)) {
      const id = crypto.randomUUID();
      created = { id, type: kind, x: snap(start.x), y: snap(start.y), w: 0, h: 0, color };
      if (kind === "section") Object.assign(created, { text: "New section", w: 352, h: 288 });
      if (kind === "text") Object.assign(created, { text: "", w: 256, h: 160 });
      if (kind === "pen" || kind === "connector") Object.assign(created, { x: start.x, y: start.y, points: [[0, 0], [0, 0]], from: kind === "connector" && target && target.type !== "section" ? target.id : null, to: null });
      setNodes([...nodes, created]); select([id]);
    }
    gesture = { pointer: event.pointerId, kind, p, start, before, previousSelection, originalNodes: before.nodes, ids, target: target?.id, created: created?.id, viewport: { ...view }, moved: false };
    beginInteraction();
    // Capture only once a card actually moves: capturing a plain click retargets it to the
    // canvas and prevents native double-clicks on labels/cards.
    if (kind !== "move") host.setPointerCapture(event.pointerId);
  }
  function pointerMove(event) {
    const g = gesture;
    if (!g || g.pointer !== event.pointerId) return;
    const p = local(event), point = world(p);
    const sx = p.x - g.p.x, sy = p.y - g.p.y;
    if (!g.moved && Math.hypot(sx, sy) < 3) return;
    if (!host.hasPointerCapture(event.pointerId)) host.setPointerCapture(event.pointerId);
    g.moved = true;
    const dx = snap(sx / view.zoom), dy = snap(sy / view.zoom);
    if (g.kind === "pan") setView({ ...view, x: g.viewport.x + sx, y: g.viewport.y + sy });
    else if (g.kind === "move") setNodes(moveNodes(g.originalNodes, g.ids, dx, dy));
    else if (g.kind === "resize") {
      const original = g.originalNodes.find((n) => n.id === g.target);
      setNodes(nodes.map((n) => n.id === g.target ? { ...n, w: Math.max(160, original.w + dx), h: Math.max(96, original.h + dy) } : n));
    } else if (g.kind === "marquee") {
      marquee = { x: Math.min(g.start.x, point.x), y: Math.min(g.start.y, point.y), w: Math.abs(point.x - g.start.x), h: Math.abs(point.y - g.start.y) };
      select(new Set([...(event.shiftKey ? g.previousSelection : []), ...nodes.filter((n) => n.type !== "section" && intersects(marquee, n)).map((n) => n.id)]));
    } else if (g.kind === "section") {
      setNodes(nodes.map((n) => n.id === g.created ? { ...n, x: snap(Math.min(g.start.x, point.x)), y: snap(Math.min(g.start.y, point.y)), w: Math.max(160, snap(Math.abs(point.x - g.start.x))), h: Math.max(96, snap(Math.abs(point.y - g.start.y))) } : n));
    } else if (g.kind === "pen" || g.kind === "connector") {
      const node = nodes.find((n) => n.id === g.created);
      const relative = [point.x - node.x, point.y - node.y];
      const last = node.points.at(-1);
      if (g.kind === "pen" && Math.hypot(relative[0] - last[0], relative[1] - last[1]) * view.zoom < 2) return;
      const points = g.kind === "pen" ? [...node.points.slice(0, 19999), relative] : [node.points[0], relative];
      setNodes(nodes.map((n) => n.id === g.created ? { ...n, points } : n));
    }
  }
  function pointerUp(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointer) return;
    if (g.moved) lastDragAt = Date.now();
    gesture = null; marquee = null;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (g.kind === "pen" || g.kind === "connector") {
      if (!g.moved) { setNodes(g.originalNodes); select(g.previousSelection); endInteraction(); return; }
      setNodes(nodes.map((n) => {
        if (n.id !== g.created) return n;
        const minX = Math.min(...n.points.map((p) => p[0])), minY = Math.min(...n.points.map((p) => p[1]));
        const maxX = Math.max(...n.points.map((p) => p[0])), maxY = Math.max(...n.points.map((p) => p[1]));
        const end = world(local(event));
        const target = [...nodes].reverse().find((other) => !["section", "connector", "pen"].includes(other.type) && contains(other, { ...end, w: 0, h: 0 }));
        return { ...n, x: n.x + minX, y: n.y + minY, w: maxX - minX, h: maxY - minY, points: n.points.map((p) => [p[0] - minX, p[1] - minY]), to: g.kind === "connector" ? target?.id ?? null : null };
      }));
    }
    if (["pan", "marquee"].includes(g.kind)) queueSave();
    else commit(g.before);
    endInteraction();
    if (g.kind === "text" || g.kind === "section") { tool = "select"; beginEdit(g.created, "text"); }
  }
  function cancelGesture() {
    const g = gesture;
    if (!g) return;
    gesture = null; marquee = null;
    setNodes(g.originalNodes); select(g.previousSelection); setView(g.viewport);
    if (host?.hasPointerCapture(g.pointer)) host.releasePointerCapture(g.pointer);
    endInteraction();
  }
  async function beginEdit(id, field) {
    endEdit();
    select([id]);
    editor = { id, field, before: personalState(doc) };
    beginInteraction();
    await tick();
    [...(host?.querySelectorAll("[data-edit]") ?? [])].find((element) => element.dataset.edit === id)?.focus();
  }
  function updateText(id, field, value) { setNodes(nodes.map((n) => n.id === id ? { ...n, [field]: value } : n)); queueSave(); }
  function endEdit() {
    if (!editor) return;
    const before = editor.before;
    editor = null;
    commit(before);
    endInteraction();
  }
  function deleteSelection() {
    if (!selection.size) return;
    const before = personalState(doc);
    // Deleting a frame removes only its frame; moving a frame carries its contents.
    board.document = removeNodes(doc, selection);
    commit(before);
    announcement = "Removed from whiteboard only. Undo to restore.";
  }
  function clearCompleted() {
    const before = personalState(doc);
    board.document = removeNodes(doc, new Set(completed.map((n) => n.id)));
    commit(before); announcement = "Completed cards removed from this board. Undo to restore.";
  }
  function remember() {
    const before = personalState(doc);
    setNodes(nodes.map((n) => selection.has(n.id) && n.type === "pr" ? { ...n, seenHead: doc.snapshots[n.key]?.headSha ?? n.seenHead } : n));
    commit(before);
  }
  function openPr(node) {
    endEdit(); select([node.id]); queueSave(); void saveBoard();
    const pr = doc.snapshots[node.key];
    location.hash = `#/pr/${pr.repo}/${pr.number}`;
  }
  function locate(node) { select([node.id]); centerBounds(node, Math.max(.7, view.zoom)); announcement = `Located ${doc.snapshots[node.key]?.title ?? node.text ?? node.type}`; }
  function linePoints(node) {
    if (node.type !== "connector") return node.points;
    const anchors = [node.from, node.to].map((id) => nodes.find((n) => n.id === id));
    const centers = node.points.map((point, i) => anchors[i] ? [anchors[i].x + anchors[i].w / 2 - node.x, anchors[i].y + anchors[i].h / 2 - node.y] : point);
    return centers.map((center, i) => {
      const anchor = anchors[i];
      if (!anchor) return center;
      const other = centers[1 - i], dx = other[0] - center[0], dy = other[1] - center[1];
      if (!dx && !dy) return center;
      const t = Math.min(anchor.w / (2 * Math.abs(dx || .001)), anchor.h / (2 * Math.abs(dy || .001)));
      return [center[0] + dx * t, center[1] + dy * t];
    });
  }
  const pathFor = (node) => linePoints(node).map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  function keydown(event) {
    if (!active || !doc || event.defaultPrevented) return;
    if (gesture && event.key !== "Escape") { event.preventDefault(); return; }
    if (isTypingTarget(event.target)) {
      if (event.key === "Escape") { event.preventDefault(); event.target.blur(); host.focus(); }
      return;
    }
    if (event.target.closest?.("button,a,select") && ["Enter", " "].includes(event.key)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === " ") { space = true; event.preventDefault(); return; }
    if (event.key === "Escape") { cancelGesture(); endEdit(); select([]); tool = "select"; query = ""; queueSave(); }
    else if (mod && event.key.toLowerCase() === "z") { endEdit(); undoBoard(event.shiftKey); }
    else if (mod && event.key.toLowerCase() === "y") undoBoard(true);
    else if (mod && event.key.toLowerCase() === "a") { select(nodes.map((n) => n.id)); queueSave(); }
    else if (event.key === "Delete" || event.key === "Backspace") deleteSelection();
    else if (event.key.startsWith("Arrow")) {
      const before = personalState(doc), step = GRID * (event.shiftKey ? 5 : 1);
      setNodes(moveNodes(nodes, movingIds(nodes, doc.selection), event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0)); commit(before);
    } else if (event.key === "Enter" && selectedNodes.length === 1) {
      const node = selectedNodes[0]; if (node.type === "pr") openPr(node); else if (["section", "text"].includes(node.type)) beginEdit(node.id, "text");
    } else if (event.key === "/" || (mod && event.key === "f")) searchInput?.focus();
    else if (event.key === "1" && !mod) fit();
    else if (event.key === "0" && !mod) zoomAt(1 / view.zoom);
    else if (["+", "="].includes(event.key)) zoomAt(1.2);
    else if (event.key === "-") zoomAt(1 / 1.2);
    else if (event.key === "?") help = !help;
    else if (!mod && tools.some((t) => t.key.toLowerCase() === event.key.toLowerCase())) chooseTool(tools.find((t) => t.key.toLowerCase() === event.key.toLowerCase()).id);
    else return;
    event.preventDefault();
  }
</script>

<svelte:window onkeydown={keydown} onkeyup={(event) => { if (event.key === " ") space = false; }} onblur={() => { space = false; cancelGesture(); }} />

<div class="whiteboard">
  <div class="board-heading">
    <div class="board-identity"><strong>Whiteboard</strong><span class="experimental">Experimental</span></div>
    <div class="save-state" role="status" class:unsaved={board.dirty}>{board.error ? "Not saved" : board.saving ? "Saving…" : board.dirty ? "Unsaved changes" : "Saved to this Cockpit"}</div>
  </div>
  {#if board.error}
    <div class="board-error" role="alert"><strong>{board.conflict ? "Another window saved this board." : "Whiteboard needs attention."}</strong> {board.error}
      {#if doc}<button onclick={exportBoard}>Export my work</button>{/if}
      {#if board.conflict}
        <button disabled={board.resolving} onclick={() => resolveConflict(true)}>Save my version</button><button disabled={board.resolving} onclick={() => { if (confirm("Replace your unsaved board with the saved version? Export your work first if you want to keep both.")) resolveConflict(false); }}>Load saved version</button>
      {:else if doc}<button onclick={saveBoard}>Retry saving</button>
      {:else}<button onclick={loadBoard}>Retry loading</button><a href="/api/whiteboard?raw=1" download>Export original data</a>{/if}
    </div>
  {/if}
  {#if board.liveError}<div class="board-error" role="status">PR updates unavailable. Showing last known metadata. <button onclick={loadBoard}>Retry</button></div>{/if}
  {#if doc}
    <div class="board-toolbar" role="toolbar" aria-label="Whiteboard tools">
      <div class="tool-group">
        {#each tools as item}<button class="tool-button" class:chosen={tool === item.id} aria-label={`${item.label} (${item.key})`} aria-pressed={tool === item.id} title={`${item.label} (${item.key})`} onclick={() => chooseTool(item.id)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d={item.path} /></svg><span>{item.label}</span></button>{/each}
      </div>
      <div class="tool-group colors" aria-label="Annotation color">{#each colors as c}<button class="swatch" class:chosen={color === c} style={`--ink:var(--native-${c})`} aria-label={`${c} annotation color`} aria-pressed={color === c} onclick={() => { color = c; if (selectedNodes.some((n) => n.type !== "pr")) { const before = personalState(doc); setNodes(nodes.map((n) => selection.has(n.id) && n.type !== "pr" ? { ...n, color: c } : n)); commit(before); } }}></button>{/each}</div>
      <div class="tool-group"><button aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!board.undo.length} onclick={() => undoBoard()}>↶</button><button aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!board.redo.length} onclick={() => undoBoard(true)}>↷</button></div>
      <div class="board-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.75" cy="8.75" r="4.75" /><path d="m12.25 12.25 3.5 3.5" /></svg><input bind:this={searchInput} aria-label="Find on whiteboard" placeholder="Find on board…" bind:value={query} onkeydown={(event) => { if (event.key === "Enter" && matches.length) { event.preventDefault(); locate(matches[0]); } }} />{#if query}<button aria-label="Clear search" onclick={() => query = ""}>×</button>{/if}
        {#if query}<div class="search-results">{#each matches.slice(0, 20) as node}<button onclick={() => locate(node)}>{doc.snapshots[node.key] ? `#${doc.snapshots[node.key].number} ${doc.snapshots[node.key].title}` : node.text || node.type}</button>{/each}{#if !matches.length}<span>No matching objects</span>{/if}</div>{/if}
      </div>
      <button disabled={!completed.length} onclick={clearCompleted} title="Remove closed and merged cards from this board only. Undo restores them.">Clear completed{completed.length ? ` (${completed.length})` : ""}</button>
      <button aria-label="Whiteboard shortcuts" title="Shortcuts (?)" onclick={() => help = !help}>?</button>
    </div>
    <div class="canvas" class:panning={space || tool === "hand"} class:drawing={["pen", "connector", "section", "text"].includes(tool)} bind:this={host} role="application" aria-label="Personal PR whiteboard canvas" tabindex="-1" onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={cancelGesture} onlostpointercapture={() => { if (gesture) cancelGesture(); }} ondblclick={doubleClick} onwheel={wheel} oncontextmenu={(event) => event.preventDefault()} style={`--grid:${GRID * view.zoom}px;--grid-x:${view.x}px;--grid-y:${view.y}px`}>
      <div class="world" style={`transform:translate(${view.x}px,${view.y}px) scale(${view.zoom})`}>
        {#each nodes.filter((n) => n.type === "section") as node (node.id)}
          <div class="section" class:selected={selection.has(node.id)} class:match={matches.includes(node)} style={`left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;--ink:var(--native-${node.color ?? "blue"})`}>
            <div class="section-label" data-node={node.id} role="button" tabindex="0" aria-label={`Section ${node.text}`} onfocus={() => { if (!selection.has(node.id)) select([node.id]); }} onkeydown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) { event.preventDefault(); beginEdit(node.id, "text"); } }}>
              {#if editor?.id === node.id}<input data-edit={node.id} aria-label="Section label" maxlength="200" value={node.text} oninput={(event) => updateText(node.id, "text", event.currentTarget.value)} onblur={endEdit} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); host.focus(); } }} />{:else}<span>{node.text}</span><small>{nodes.filter((n) => n.type === "pr" && contains(node, n)).length} PRs</small>{/if}
            </div>
            {#if selection.has(node.id)}<div class="resize-handle" data-node={node.id} data-resize aria-hidden="true"></div>{/if}
          </div>
        {/each}
        <svg class="drawing-layer" aria-label="Personal annotations"><defs><marker id="board-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="context-stroke" stroke-width="1.5" /></marker></defs>
          {#each nodes.filter((n) => n.type === "pen" || n.type === "connector") as node (node.id)}<g data-node={node.id} transform={`translate(${node.x},${node.y})`} style={`--ink:var(--native-${node.color ?? "blue"})`}><path class="line-hit" d={pathFor(node)} /><path class="drawn-line" class:line-selected={selection.has(node.id)} d={pathFor(node)} marker-end={node.type === "connector" ? "url(#board-arrow)" : undefined} /></g>{/each}
        </svg>
        {#each nodes.filter((n) => n.type === "pr" || n.type === "text") as node (node.id)}
          {#if node.type === "pr"}
            {@const pr = doc.snapshots[node.key]}
            {#if pr}
              {@const status = classify(pr, viewerLogin)}
              {@const changed = !!node.seenHead && !!pr.headSha && node.seenHead !== pr.headSha}
              <div class="pr-card" role="group" class:selected={selection.has(node.id)} class:match={matches.includes(node)} class:changed data-node={node.id} data-pr={node.key} style={`left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px`} tabindex="-1" aria-label={`PR #${pr.number}: ${pr.title}`} onfocusin={() => { if (!selection.has(node.id)) select([node.id]); }}>
                <div class="card-top"><span class="pr-ref mono">{pr.repo.split("/").at(-1)} <strong>#{pr.number}</strong></span><span class="badge {status.tone}">{pr.isDraft && pr.state === "OPEN" ? "draft" : status.label}</span></div>
                <div class="card-title">{pr.title}</div>
                <div class="card-meta"><Avatar login={pr.author} url={`https://github.com/${pr.author}.png?size=40`} size={20} /><span>{pr.author}</span><span class="diff-stat"><span class="add">+{pr.additions ?? "–"}</span> <span class="del">−{pr.deletions ?? "–"}</span></span><ActionStatusIcon status={pr.ciStatus === "PENDING" ? "in_progress" : "completed"} conclusion={pr.ciStatus === "SUCCESS" ? "success" : ["FAILURE", "ERROR"].includes(pr.ciStatus) ? "failure" : null} /></div>
                {#if changed || pr.available === false}<div class="card-memory" class:invalid={changed} title={changed ? "The PR head changed since placement or your personal checkpoint. This is not a GitHub review." : "This PR is no longer in the current cache. Its last known state is retained, not inferred."}>{pr.available === false ? (changed ? "Last known · new commits to revisit" : "Last known · not in current cache") : "New commits · revisit your review"}</div>{/if}
                <div class="card-bottom">{#if editor?.id === node.id}<textarea data-edit={node.id} aria-label={`Personal note for PR ${pr.number}`} maxlength="20000" value={node.note} oninput={(event) => updateText(node.id, "note", event.currentTarget.value)} onblur={endEdit}></textarea>{:else}<button class="card-note" class:has-note={!!node.note} onclick={() => beginEdit(node.id, "note")}>{node.note || "Add a personal note…"}</button>{/if}<button class="open-pr" aria-label={`Open PR ${pr.number}`} title="Open PR (Enter or double-click card)" onclick={() => openPr(node)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></button></div>
              </div>
            {/if}
          {:else}
            <div class="text-note" class:selected={selection.has(node.id)} class:match={matches.includes(node)} data-node={node.id} style={`left:${node.x}px;top:${node.y}px;width:${node.w}px;height:${node.h}px;--ink:var(--native-${node.color ?? "orange"})`} role="button" tabindex="0" aria-label={`Note: ${node.text || "Empty note"}`} onfocus={() => { if (!selection.has(node.id)) select([node.id]); }}>
              <span class="note-caption">PERSONAL NOTE</span>{#if editor?.id === node.id}<textarea data-edit={node.id} aria-label="Personal note text" maxlength="20000" value={node.text} oninput={(event) => updateText(node.id, "text", event.currentTarget.value)} onblur={endEdit}></textarea>{:else}<div class="note-content">{node.text || "Double-click to write…"}</div>{/if}
              {#if selection.has(node.id)}<div class="resize-handle" data-node={node.id} data-resize aria-hidden="true"></div>{/if}
            </div>
          {/if}
        {/each}
        {#if marquee}<div class="marquee" style={`left:${marquee.x}px;top:${marquee.y}px;width:${marquee.w}px;height:${marquee.h}px`}></div>{/if}
      </div>
      {#if !nodes.length}<div class="empty-board"><strong>Your review space</strong><p>PRs from your queue will appear here. Draw a section or add a note to get started.</p></div>{/if}
      {#if help}<div class="help-panel"><strong>Make room for your review</strong><button aria-label="Close shortcuts" onclick={() => help = false}>×</button><p>Drag to move · Shift-click or drag empty space to select</p><p>Space-drag to pan · Scroll to zoom at cursor</p><p>V select · H pan · F section · P pen · T note · C connector</p><p>Drag a connector between cards to keep it attached.</p><p>Double-click labels and notes to edit. Enter opens a selected PR.</p><p>Arrows nudge 16 px · Shift-arrows 80 px · Delete removes</p><p>⌘/Ctrl Z undo · Shift ⌘/Ctrl Z redo · 1 fit all · 0 actual size</p><p>Move a section to carry its contents. Deleting a section keeps them.</p><p>Everything here is personal. No approvals, merges or queue changes.</p></div>{/if}
    </div>
    <div class="board-footer"><span class="selection-info">{selection.size ? `${selection.size} selected` : `${nodes.filter((n) => n.type === "pr").length} PRs`} <span class="footer-sep">·</span> {tool === "select" ? "Drag to arrange · Space to pan" : `${tools.find((t) => t.id === tool)?.label} tool · Esc to select`}</span>
      {#if selectedNodes.some((n) => n.type === "pr")}<button onclick={remember} title="Remember this head locally. Does not submit a GitHub approval.">Mark current head seen</button>{/if}
      {#if selection.size}<button onclick={deleteSelection}>Remove selected</button>{/if}
      <span class="footer-spacer"></span><span class="grid-label">16 px grid</span><button aria-label="Zoom out" onclick={() => zoomAt(1 / 1.2)}>−</button><button class="zoom-label" title="Reset to 100%" onclick={() => zoomAt(1 / view.zoom)}>{Math.round(view.zoom * 100)}%</button><button aria-label="Zoom in" onclick={() => zoomAt(1.2)}>+</button><button onclick={fit}>Fit all</button><button onclick={exportBoard} title="Download a personal board backup">Export</button>
    </div>
  {:else if !board.error}<div class="board-loading" role="status">Loading your whiteboard…</div>{/if}
  <span class="sr-only" aria-live="polite">{announcement}</span>
</div>

<style>
  .whiteboard { display:flex; flex-direction:column; min-height:0; flex:1; color:var(--text); font-family:var(--sans); }
  .board-heading { display:flex; justify-content:space-between; align-items:center; padding:12px 2px 14px; gap:12px; }
  .board-identity { display:flex; align-items:center; gap:10px; } .board-identity strong { font-size:17px; font-weight:600; letter-spacing:-.3px; }
  .experimental { font-size:10px; border:1px solid var(--border); border-radius:4px; color:var(--text-dim); padding:2px 5px; }
  .save-state { font-size:11px; color:var(--text-faint); } .save-state.unsaved { color:var(--review); }
  .board-toolbar { display:flex; align-items:center; gap:8px; padding:9px 10px; background:var(--panel); border:1px solid var(--border); border-bottom:0; border-radius:10px 10px 0 0; position:relative; z-index:5; flex-wrap:wrap; }
  button { border:1px solid transparent; background:transparent; border-radius:5px; padding:5px 8px; color:var(--text-dim); font:inherit; font-size:11px; cursor:pointer; line-height:20px; white-space:nowrap; }
  button:hover { background:var(--surface-hover); color:var(--text); } button:disabled { opacity:.35; cursor:default; } button:focus-visible,input:focus-visible,textarea:focus-visible { outline:2px solid var(--native-accent); outline-offset:2px; }
  .tool-group { display:flex; align-items:center; gap:2px; padding-right:8px; border-right:1px solid var(--border); }
  .tool-button { display:flex; align-items:center; gap:5px; padding:6px; } .chosen { background:var(--link-bg); color:var(--link); }
  svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; flex:none; }
  .colors { gap:4px; } .swatch { width:18px; height:18px; padding:0; border:4px solid var(--panel); border-radius:50%; background:var(--ink); } .swatch:hover { background:var(--ink); } .swatch.chosen { outline:1px solid var(--ink); }
  .board-search { position:relative; display:flex; align-items:center; flex:1; min-width:145px; max-width:280px; margin-left:auto; gap:6px; color:var(--text-faint); }
  .board-search input { background:transparent; border:0; min-width:0; width:100%; font:inherit; font-size:12px; color:var(--text); padding:6px 0; }
  .search-results { position:absolute; top:36px; right:0; width:360px; max-height:280px; overflow:auto; border:1px solid var(--border); border-radius:8px; background:var(--panel); box-shadow:var(--shadow-dialog); padding:6px; }
  .search-results button { display:block; width:100%; text-align:left; overflow:hidden; text-overflow:ellipsis; } .search-results span { padding:10px; display:block; }
  .canvas { position:relative; flex:1; min-height:300px; overflow:clip; outline:none; border:1px solid var(--border); background-color:var(--surface); background-image:radial-gradient(circle,var(--border-hover) .7px,transparent .9px); background-size:var(--grid) var(--grid); background-position:var(--grid-x) var(--grid-y); touch-action:none; user-select:none; }
  .canvas:focus-visible { border-color:var(--native-accent); } .panning { cursor:grab; } .panning:active { cursor:grabbing; } .drawing { cursor:crosshair; }
  .world { transform-origin:0 0; position:absolute; width:0; height:0; }
  .section { position:absolute; border:1px solid color-mix(in srgb,var(--ink) 25%,var(--border)); border-radius:9px; background:color-mix(in srgb,var(--ink) 3%,var(--panel)); pointer-events:none; }
  .section-label { pointer-events:auto; height:38px; display:flex; align-items:center; gap:10px; padding:0 14px; cursor:move; color:var(--text-dim); font-size:12px; font-weight:600; }
  .section-label:before { content:""; width:6px; height:6px; border-radius:2px; background:var(--ink); } .section-label small { font-size:10px; opacity:.6; font-weight:400; margin-left:auto; }
  .section-label input { color:var(--text); background:var(--panel); width:100%; border:0; font:inherit; padding:3px; }
  .selected { outline:2px solid var(--native-accent); outline-offset:2px; } .match { box-shadow:0 0 0 4px color-mix(in srgb,var(--native-yellow) 65%,transparent) !important; }
  .pr-card.selected, .text-note.selected { z-index: 2; }
  .resize-handle { position:absolute; right:-5px; bottom:-5px; width:10px; height:10px; background:var(--panel); border:2px solid var(--native-accent); border-radius:2px; pointer-events:auto; cursor:nwse-resize; }
  .drawing-layer { position:absolute; left:0; top:0; width:1px; height:1px; overflow:visible; pointer-events:none; }
  .drawn-line { stroke:var(--ink); stroke-width:2.5; pointer-events:none; } .line-hit { stroke:transparent; stroke-width:16; pointer-events:stroke; cursor:move; } .line-selected { filter:drop-shadow(0 0 3px var(--native-accent)); stroke-width:4; }
  .pr-card { position:absolute; background:var(--panel); border:1px solid var(--border-hover); border-radius:8px; box-shadow:0 2px 4px rgb(0 0 0 / .025); padding:13px 14px 0; box-sizing:border-box; cursor:move; display:flex; flex-direction:column; }
  .card-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:9px; } .pr-ref { font-size:10px; color:var(--text-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .pr-ref strong { color:var(--text-dim); font-weight:500; }
  .card-top .badge { font-size:10px; padding:2px 6px; line-height:16px; border-radius:4px; white-space:nowrap; }
  .card-title { font-size:14px; font-weight:550; line-height:20px; height:40px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; color:var(--text); }
  .card-meta { display:flex; gap:6px; align-items:center; height:35px; font-size:11px; color:var(--text-dim); } .diff-stat { margin-left:auto; font-family:var(--mono); font-size:10px; } .add { color:var(--ready); } .del { color:var(--fail); }
  .card-memory { font-size:10px; line-height:20px; color:var(--text-faint); white-space:nowrap; } .card-memory.invalid { color:var(--review); } .pr-card.changed { border-color:color-mix(in srgb,var(--review) 45%,var(--border)); }
  .card-bottom { margin-top:auto; min-height:44px; display:flex; align-items:stretch; border-top:1px solid var(--border); gap:4px; }
  .card-note { flex:1; text-align:left; padding:5px 0; font-size:11px; color:var(--text-faint); overflow:hidden; white-space:pre-wrap; max-height:44px; line-height:16px; } .card-note.has-note { color:var(--text-dim); } .card-note:hover { background:transparent; color:var(--text); } .open-pr { padding:6px 0 6px 6px; align-self:center; }
  textarea { resize:none; color:var(--text); font:inherit; font-size:12px; line-height:18px; border:0; border-radius:3px; padding:3px; background:var(--panel); user-select:text; }
  .card-bottom textarea { flex:1; min-width:0; height:42px; }
  .text-note { position:absolute; box-sizing:border-box; padding:16px; border:1px solid color-mix(in srgb,var(--ink) 35%,var(--border)); border-radius:5px; background:color-mix(in srgb,var(--ink) 9%,var(--panel)); box-shadow:var(--shadow-xs); cursor:move; display:flex; flex-direction:column; }
  .note-caption { font-size:9px; letter-spacing:.11em; color:var(--text-faint); margin-bottom:10px; } .note-content { white-space:pre-wrap; overflow:auto; font-size:15px; line-height:23px; } .text-note textarea { width:100%; flex:1; min-height:0; font-size:15px; line-height:23px; background:transparent; }
  .marquee { position:absolute; border:1px solid var(--native-accent); background:color-mix(in srgb,var(--native-accent) 10%,transparent); pointer-events:none; }
  .board-footer { display:flex; align-items:center; gap:5px; min-height:44px; padding:0 10px; border:1px solid var(--border); border-top:0; border-radius:0 0 10px 10px; background:var(--panel); }
  .selection-info { color:var(--text-dim); font-size:11px; } .footer-sep { margin:0 7px; color:var(--text-faint); } .footer-spacer { flex:1; } .grid-label { color:var(--text-faint); font-size:10px; margin-right:10px; } .zoom-label { min-width:48px; font-family:var(--mono); }
  .board-error { padding:10px 12px; border:1px solid var(--review); color:var(--review); background:var(--review-bg); font-size:12px; margin-bottom:8px; border-radius:6px; } .board-error button { text-decoration:underline; color:inherit; } .board-error a { color:inherit; }
  .empty-board { position:absolute; left:50%; top:45%; transform:translate(-50%,-50%); color:var(--text-dim); text-align:center; max-width:340px; pointer-events:none; } .empty-board strong { font-size:20px; } .empty-board p { font-size:13px; line-height:1.6; }
  .help-panel { position:absolute; right:16px; top:16px; width:380px; padding:18px; background:var(--panel); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow-dialog); font-size:12px; color:var(--text-dim); cursor:default; user-select:text; } .help-panel strong { color:var(--text); } .help-panel button { float:right; } .help-panel p { margin:12px 0 0; line-height:1.5; }
  .board-loading { padding:80px; text-align:center; color:var(--text-dim); }
  @media (max-width:1100px) { .tool-button span,.grid-label { display:none; } }
</style>
