import { clone, validateBoard, reconcileBoard, normalizeBoardPr, personalState, historyChange, applyHistory } from "../../../shared/whiteboard.js";
import { showFlash } from "./flash.svelte.js";
import { prefs, whiteboardSession } from "./prefs.svelte.js";

export const board = $state({ document: null, revision: 0, loading: false, saving: false, dirty: false, interacting: false, resolving: false, error: null, conflict: false, liveError: null, undo: [], redo: [] });
let loading = null;
let timer;
let generation = 0;
let savedDocument = "";
let enabled = prefs.whiteboardEnabled;
let lifecycle = new AbortController();
let needsRefresh = false;
let uncertainSave = false;
// Metadata is a cache, not a personal edit. It can ride along with the next real save.
const serializePersonal = ({ snapshots, ...personal }) => JSON.stringify(personal);
function guardUnsaved(event) {
  if (board.dirty || board.interacting || board.saving) { event.preventDefault(); event.returnValue = ""; }
}
function updateDirty() {
  board.dirty = !!board.document && (uncertainSave || serializePersonal(board.document) !== savedDocument);
  if (board.dirty || board.interacting || board.saving) window.addEventListener("beforeunload", guardUnsaved);
  else window.removeEventListener("beforeunload", guardUnsaved);
  if (!board.dirty && !board.conflict) board.error = null;
}
function scheduleSave() {
  clearTimeout(timer);
  if (!board.interacting) updateDirty();
  if (enabled && !needsRefresh && board.dirty && !board.error && !board.conflict && !board.interacting) timer = setTimeout(() => void saveBoard(), 300);
}
function setEnabled(next) {
  if (enabled === next) return;
  enabled = next;
  uncertainSave ||= board.saving;
  lifecycle.abort();
  lifecycle = new AbortController();
  clearTimeout(timer);
  loading = null;
  board.loading = false; board.saving = false; board.resolving = false;
  needsRefresh = true;
  updateDirty();
  // An aborted PUT may already have committed. Re-read before any resumed save.
  if (enabled && board.document) void loadBoard();
}
whiteboardSession.current = { board, setEnabled, exportBoard };

async function readBoard(signal) {
  const res = await fetch("/api/whiteboard", { cache: "no-store", signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Whiteboard ${res.status}`);
  validateBoard(body.document);
  return body;
}
export function mergeMetadata(prs) {
  if (!enabled || !board.document) return;
  const snapshots = { ...board.document.snapshots };
  for (const key of Object.keys(snapshots)) snapshots[key] = { ...snapshots[key], available: false };
  for (const row of prs) {
    const pr = normalizeBoardPr(row);
    const key = `${pr.repo}#${pr.number}`, previous = snapshots[key];
    if (previous?.updatedAt && pr.updatedAt && previous.updatedAt > pr.updatedAt) continue;
    snapshots[key] = { ...previous, ...pr };
  }
  board.document = { ...board.document, snapshots };
}
function adopt(body) {
  board.document = body.document;
  board.revision = body.revision;
  savedDocument = serializePersonal(body.document);
  uncertainSave = false;
  board.undo = []; board.redo = [];
  board.conflict = false; board.error = null;
  updateDirty();
}
export async function loadBoard() {
  if (!enabled) return;
  if (loading) return loading;
  const signal = lifecycle.signal, started = generation;
  board.loading = !board.document;
  loading = (async () => {
    try {
      const body = await readBoard(signal);
      if (signal.aborted) return;
      const matchesUncertainSave = uncertainSave && board.document && serializePersonal(board.document) === serializePersonal(body.document);
      if (!board.document || ((!board.dirty || matchesUncertainSave) && !board.interacting && !board.saving && generation === started && (body.revision !== board.revision || uncertainSave))) adopt(body);
      else if (body.revision !== board.revision && !board.saving) {
        board.conflict = true;
        board.error = "This board changed in another window. Your edits are kept here; choose which version to save.";
      }
      mergeMetadata(body.prs);
      needsRefresh = false;
      board.liveError = null;
      scheduleSave();
    } catch (error) {
      if (signal.aborted) return;
      if (board.document) board.liveError = error.message;
      else board.error = error.message;
    } finally { if (!signal.aborted) { board.loading = false; loading = null; } }
  })();
  return loading;
}
export function reconcile(prs, groups) {
  if (!enabled || !board.document) return;
  const previous = board.document;
  const next = reconcileBoard(previous, prs, groups);
  board.document = next;
  if (next.nodes !== previous.nodes || next.initialized !== previous.initialized) queueSave();
}
export function queueSave() {
  generation++;
  board.dirty = true;
  window.addEventListener("beforeunload", guardUnsaved);
  scheduleSave();
}
export function beginInteraction() {
  generation++;
  board.interacting = true;
  window.addEventListener("beforeunload", guardUnsaved);
}
export function endInteraction() {
  board.interacting = false;
  scheduleSave();
}
export function commit(before) {
  const change = historyChange(before, personalState(board.document));
  if (change.ids.length || change.addedExclusions.length || change.removedExclusions.length) {
    board.undo = [...board.undo.slice(-79), change];
    board.redo = [];
  }
  queueSave();
}
export function undoBoard(redo = false) {
  const source = redo ? board.redo : board.undo;
  if (!source.length) return;
  const change = source.at(-1);
  if (redo) { board.redo = source.slice(0, -1); board.undo = [...board.undo, change]; }
  else { board.undo = source.slice(0, -1); board.redo = [...board.redo, change]; }
  board.document = applyHistory(board.document, change, redo);
  queueSave();
}
export async function saveBoard() {
  clearTimeout(timer);
  if (!enabled || needsRefresh || !board.document || board.saving || board.interacting || board.resolving || board.conflict) return;
  updateDirty();
  if (!board.dirty) return;
  const serialized = serializePersonal(board.document), signal = lifecycle.signal;
  board.saving = true;
  try {
    const res = await fetch("/api/whiteboard", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: board.revision, document: board.document }), signal });
    const body = await res.json();
    if (signal.aborted) return;
    if (!res.ok) { board.conflict = res.status === 409; throw new Error(body.error || `Whiteboard ${res.status}`); }
    board.revision = body.revision;
    savedDocument = serialized;
    uncertainSave = false;
    board.error = null;
    updateDirty();
  } catch (error) {
    if (signal.aborted) return;
    board.error = error.message;
    updateDirty();
    if (board.dirty) showFlash("Whiteboard not saved. Your edits are kept in this window — open Whiteboard to retry or export.");
  } finally { if (!signal.aborted) board.saving = false; }
  if (!signal.aborted) scheduleSave();
}
export async function resolveConflict(keepMine) {
  if (!enabled || board.resolving || board.interacting || board.saving) return;
  const started = generation, signal = lifecycle.signal;
  board.resolving = true;
  try {
    const body = await readBoard(signal);
    if (signal.aborted) return;
    if (generation !== started || board.interacting) {
      board.error = "Your board changed while the saved version was loading. Your newer edits are kept; choose a version again.";
      return;
    }
    if (!keepMine) adopt(body);
    else {
      board.revision = body.revision;
      savedDocument = serializePersonal(body.document);
      uncertainSave = false;
      board.conflict = false; board.error = null;
      updateDirty();
    }
    mergeMetadata(body.prs);
    needsRefresh = false;
  } catch (error) { if (!signal.aborted) board.error = error.message; }
  finally { if (!signal.aborted) board.resolving = false; }
  if (!signal.aborted && !board.conflict) await saveBoard();
}
export function exportBoard() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(clone(board.document), null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "cockpit-whiteboard.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
