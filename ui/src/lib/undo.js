import { showFlash } from "./flash.svelte.js";

const history = [];
let busy = false;

export function recordUndo(owner, run) {
  const action = { owner, run };
  history.push(action);
  return () => {
    const index = history.indexOf(action);
    if (index !== -1) history.splice(index, 1);
  };
}

export function clearUndo(owner) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].owner === owner) history.splice(i, 1);
  }
}

export function undoLastAction() {
  const action = history.at(-1);
  if (!action) return false;
  if (busy) return true;
  busy = true;
  Promise.resolve().then(action.run).then((result) => {
    if (result === false) return;
    const index = history.indexOf(action);
    if (index !== -1) history.splice(index, 1);
  }).catch((error) => {
    showFlash(`Couldn't undo: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => { busy = false; });
  return true;
}
