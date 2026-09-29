// Personal geometry is deliberately separate from cached GitHub metadata and undo history.
/**
 * @typedef {{id:string,type:string,x:number,y:number,w:number,h:number,key?:string,note?:string,seenHead?:string,text?:string,color?:string,points?:number[][],from?:string,to?:string}} BoardNode
 * @typedef {{repo:string,number:number,title:string,author:string,state:string,updatedAt?:string,available?:boolean,cachedAt?:string} & Record<string,unknown>} BoardPr
 * @typedef {{version:number,initialized:boolean,nodes:BoardNode[],excluded:string[],snapshots:Record<string,BoardPr>,viewport:{x:number,y:number,zoom:number},selection:string[]}} BoardDocument
 */
export const GRID = 16;
export const CARD_W = 320;
export const CARD_H = 192;
export const snap = (n) => Math.round(n / GRID) * GRID;
export const boardKey = (pr) => `${pr.repo}#${pr.number}`;
// The live cache represents drafts as lowercase "draft"; keep that detail at ingestion.
export const normalizeBoardPr = (pr) => pr.state === "draft" ? { ...pr, state: "OPEN", isDraft: true } : pr;
export const clone = (value) => JSON.parse(JSON.stringify(value));
/** @returns {BoardDocument} */
export const emptyBoard = () => ({ version: 1, initialized: false, nodes: [], excluded: [], snapshots: {}, viewport: { x: 32, y: 32, zoom: 1 }, selection: [] });
const finite = (n) => Number.isFinite(n) && Math.abs(n) <= 1e7;
const text = (s, max = 20000) => typeof s === "string" && s.length <= max;
const keyPattern = /^[^/#\s]+\/[^/#\s]+#[1-9]\d*$/;

export function validateBoard(doc) {
  if (!doc || doc.version !== 1 || typeof doc.initialized !== "boolean" || !Array.isArray(doc.nodes) || doc.nodes.length > 10000
    || !Array.isArray(doc.excluded) || !doc.excluded.every((key) => text(key, 300) && keyPattern.test(key))
    || !Array.isArray(doc.selection) || !doc.selection.every((id) => text(id, 350))
    || !doc.snapshots || typeof doc.snapshots !== "object" || Array.isArray(doc.snapshots)
    || !doc.viewport || !finite(doc.viewport.x) || !finite(doc.viewport.y) || !finite(doc.viewport.zoom) || doc.viewport.zoom < 0.15 || doc.viewport.zoom > 3) throw new Error("Unsupported or malformed whiteboard. Saved data has not been changed.");
  const ids = new Set();
  const keys = new Set();
  for (const n of doc.nodes) {
    if (!n || !text(n.id, 350) || ids.has(n.id) || !["pr", "section", "text", "pen", "connector"].includes(n.type)
      || !finite(n.x) || !finite(n.y) || !finite(n.w) || !finite(n.h) || n.w < 0 || n.h < 0) throw new Error("Invalid whiteboard object. Saved data has not been changed.");
    ids.add(n.id);
    if (n.type === "pr") {
      if (!text(n.key, 300) || !keyPattern.test(n.key) || keys.has(n.key) || !doc.snapshots[n.key] || !text(n.note) || !text(n.seenHead, 100)) throw new Error("Invalid PR card");
      keys.add(n.key);
    }
    if (["section", "text"].includes(n.type) && !text(n.text)) throw new Error("Invalid whiteboard text");
    if (["pr", "section", "text"].includes(n.type) && (!n.w || !n.h)) throw new Error("Invalid object dimensions");
    if (["pen", "connector"].includes(n.type) && (!Array.isArray(n.points) || n.points.length < 2 || n.points.length > 20000 || !n.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite)))) throw new Error("Invalid drawing");
    if (n.color !== undefined && !["blue", "orange", "green", "purple", "gray"].includes(n.color)) throw new Error("Invalid drawing color");
  }
  for (const [key, pr] of Object.entries(doc.snapshots)) {
    if (!keyPattern.test(key) || !pr || !text(pr.repo, 300) || !Number.isSafeInteger(pr.number) || pr.number < 1 || boardKey(pr) !== key || !text(pr.title) || !text(pr.author, 200) || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) throw new Error("Invalid remembered PR metadata");
  }
  return doc;
}

export function bounds(nodes) {
  if (!nodes.length) return { x: 0, y: 0, w: 960, h: 640 };
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  return { x, y, w: Math.max(...nodes.map((n) => n.x + n.w)) - x, h: Math.max(...nodes.map((n) => n.y + n.h)) - y };
}
export const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
export const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
export function movingIds(nodes, selection) {
  const ids = new Set(selection);
  for (const frame of nodes.filter((n) => n.type === "section" && ids.has(n.id))) {
    for (const node of nodes) if (contains(frame, node)) ids.add(node.id);
  }
  return ids;
}
export function moveNodes(nodes, ids, dx, dy) {
  return nodes.map((n) => ids.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n);
}

export function arrangeNodes(nodes, width, height) {
  const contents = nodes.filter((n) => n.type !== "section");
  nodes = nodes.filter((n) => n.type !== "section" || contents.some((item) => contains(n, item)));
  if (!nodes.length) return nodes;
  const sections = nodes.filter((n) => n.type === "section");
  const frames = sections.filter((n) => !sections.some((other) => other !== n && contains(other, n) && (other.w * other.h > n.w * n.h || other.id < n.id)));
  const children = new Map(frames.map((n) => [n.id, []]));
  const loose = [];
  for (const node of nodes) {
    if (children.has(node.id)) continue;
    const parent = frames.find((frame) => contains(frame, node));
    if (parent) children.get(parent.id).push(node);
    else loose.push(node);
  }
  const groups = [...frames.map((frame) => ({ frame, items: children.get(frame.id) })), ...loose.map((node) => ({ frame: null, items: [node] }))];
  const aspect = width / height;
  const largest = Math.max(1, ...groups.map((g) => g.items.length));
  const ideal = Math.max(1, Math.ceil(Math.sqrt(largest * CARD_H / CARD_W * aspect)));
  const columnChoices = new Set([1, Math.max(1, ideal - 1), ideal, ideal + 1]);
  let best = null, bestScale = -1;
  for (const columns of columnChoices) {
    const blocks = groups.map(({ frame, items }) => {
      if (frame && items.length && items.every((n) => n.type === "pr")) {
        const count = Math.min(columns, items.length);
        const cellWidth = Math.ceil(Math.max(...items.map((n) => n.w)) / GRID) * GRID + GRID;
        const cellHeight = Math.ceil(Math.max(...items.map((n) => n.h)) / GRID) * GRID + GRID;
        const placed = items.map((n, i) => ({ ...n, x: GRID + i % count * cellWidth, y: 48 + Math.floor(i / count) * cellHeight }));
        return { nodes: [{ ...frame, x: 0, y: 0, w: count * cellWidth + GRID, h: Math.ceil(items.length / count) * cellHeight + 48 }, ...placed] };
      }
      const all = frame ? [frame, ...items] : items;
      const box = bounds(all);
      return { nodes: all.map((n) => ({ ...n, x: n.x - box.x, y: n.y - box.y })) };
    }).map((block) => ({ ...block, ...bounds(block.nodes) })).sort((a, b) => b.h - a.h);
    const minimum = Math.max(...blocks.map((b) => b.w));
    const idealWidth = Math.sqrt(blocks.reduce((sum, b) => sum + (b.w + 48) * (b.h + 48), 0) * aspect);
    for (let sample = 0; sample <= 12; sample++) {
      const rowWidth = Math.max(minimum, snap(idealWidth * (.5 + sample / 12)));
      let x = 0, y = 0, rowHeight = 0, packedWidth = 0;
      const placed = [];
      for (const block of blocks) {
        if (x && x + block.w > rowWidth) { x = 0; y += rowHeight + 48; rowHeight = 0; }
        placed.push({ block, x, y });
        packedWidth = Math.max(packedWidth, x + block.w);
        x += block.w + 48;
        rowHeight = Math.max(rowHeight, block.h);
      }
      const scale = Math.min(width / packedWidth, height / (y + rowHeight));
      if (scale > bestScale) { best = placed; bestScale = scale; }
    }
  }
  const byId = new Map(best.flatMap(({ block, x, y }) => block.nodes.map((n) => [n.id, { ...n, x: n.x + x, y: n.y + y }])));
  return nodes.map((n) => byId.get(n.id));
}
export const personalState = (doc) => clone({ nodes: doc.nodes, excluded: doc.excluded });
export function historyChange(before, after) {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const ids = [...new Set([...old.keys(), ...next.keys()])].filter((id) => JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id)));
  return { before: ids.flatMap((id) => old.has(id) ? [old.get(id)] : []), after: ids.flatMap((id) => next.has(id) ? [next.get(id)] : []),
    ids, addedExclusions: after.excluded.filter((key) => !before.excluded.includes(key)), removedExclusions: before.excluded.filter((key) => !after.excluded.includes(key)) };
}
export function applyHistory(doc, change, redo = false) {
  const replacements = new Map((redo ? change.after : change.before).map((n) => [n.id, clone(n)]));
  const affected = new Set(change.ids);
  const nodes = doc.nodes.flatMap((n) => {
    if (!affected.has(n.id)) return [n];
    const replacement = replacements.get(n.id);
    replacements.delete(n.id);
    return replacement ? [replacement] : [];
  });
  nodes.push(...replacements.values());
  const excluded = new Set(doc.excluded);
  for (const key of redo ? change.addedExclusions : change.removedExclusions) excluded.add(key);
  for (const key of redo ? change.removedExclusions : change.addedExclusions) excluded.delete(key);
  return { ...doc, nodes, excluded: [...excluded], selection: doc.selection.filter((id) => nodes.some((n) => n.id === id)) };
}
export function removeNodes(doc, ids) {
  const removed = doc.nodes.filter((n) => ids.has(n.id));
  return { ...doc, nodes: doc.nodes.filter((n) => !ids.has(n.id)), selection: [], excluded: [...new Set([...doc.excluded, ...removed.filter((n) => n.type === "pr").map((n) => n.key)])] };
}
const prNode = (pr, x, y) => ({ id: `pr:${boardKey(pr)}`, type: "pr", key: boardKey(pr), x, y, w: CARD_W, h: CARD_H, note: "", seenHead: pr.headSha ?? "" });

// Only first placement uses queue grouping. Later arrivals start below every existing object.
export function reconcileBoard(doc, incoming, groups = []) {
  incoming = incoming.map(normalizeBoardPr);
  const snapshots = { ...doc.snapshots };
  for (const pr of incoming) {
    const previous = snapshots[boardKey(pr)];
    if (previous?.updatedAt && pr.updatedAt && previous.updatedAt > pr.updatedAt) continue;
    snapshots[boardKey(pr)] = { ...previous, ...pr };
  }
  let nodes = doc.nodes;
  const present = new Set([...nodes.filter((n) => n.type === "pr").map((n) => n.key), ...doc.excluded]);
  const arrivals = [...new Map(incoming.map((pr) => [boardKey(pr), pr])).values()].filter((pr) => pr.state === "OPEN" && !present.has(boardKey(pr)) && pr.available !== false);
  if (!doc.initialized && !nodes.length && arrivals.length) {
    nodes = [...nodes];
    const assigned = new Set();
    const columns = groups.map((g) => ({ title: g.title, prs: g.prs.filter((pr) => arrivals.some((p) => boardKey(p) === boardKey(pr))) })).filter((g) => g.prs.length);
    const grouped = new Set(columns.flatMap((g) => g.prs.map(boardKey)));
    const other = arrivals.filter((pr) => !grouped.has(boardKey(pr)));
    if (other.length) columns.push({ title: "Your queue", prs: other });
    const bottoms = [0, 0, 0];
    for (const g of columns) {
      const col = bottoms.indexOf(Math.min(...bottoms));
      const x = col * 384, y = bottoms[col];
      const height = g.prs.length * (CARD_H + 16) + 64;
      nodes.push({ id: crypto.randomUUID(), type: "section", text: g.title, color: ["green", "orange", "gray"][col], x, y, w: 352, h: height });
      g.prs.forEach((pr, i) => { if (!assigned.has(boardKey(pr))) { nodes.push(prNode(pr, x + 16, y + 48 + i * (CARD_H + 16))); assigned.add(boardKey(pr)); } });
      bottoms[col] += height + 48;
    }
  } else if (arrivals.length) {
    const y = snap(Math.max(0, ...nodes.map((n) => n.y + n.h)) + 64);
    const section = { id: crypto.randomUUID(), type: "section", text: "New arrivals", color: "blue", x: 0, y, w: 1056, h: Math.ceil(arrivals.length / 3) * (CARD_H + 16) + 64 };
    nodes = [...nodes, section, ...arrivals.map((pr, i) => prNode(pr, 16 + (i % 3) * 336, y + 48 + Math.floor(i / 3) * (CARD_H + 16)))];
  }
  return { ...doc, initialized: doc.initialized || arrivals.length > 0, snapshots, nodes };
}
