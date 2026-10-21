import { marked } from "marked";

/** @typedef {{ offset: number, checked: boolean, key: string }} TaskMarker */
/** @typedef {{ key: string, checked: boolean }} TaskIntent */

/** @param {string} source @returns {Array<{ checked: boolean, line: string }>} */
function taskTokens(source) {
  /** @type {Array<{ checked: boolean, line: string }>} */
  const tasks = [];
  let item = "";
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === "list_item") item = token.raw;
    else if (token.type === "checkbox") tasks.push({ checked: token.checked, line: item.split("\n", 1)[0].trimStart() });
  });
  return tasks;
}

/** @param {string} source @param {number} offset @param {boolean} checked */
function withMarker(source, offset, checked) {
  return source.slice(0, offset) + (checked ? "x" : " ") + source.slice(offset + 1);
}

// `#41-x` is not a PR reference.
const PR_ROW_RE = /^(?:\*\*\[[^\]\n]*\]\*\*\s+)?#(\d+)(?=[\s,]|$)/;

/** @param {string} source @param {number} offset */
function taskKey(source, offset) {
  const lineEnd = source.slice(offset).search(/\r|\n|$/) + offset;
  const text = source.slice(offset + 2, lineEnd).replace(/\s+/g, " ").trim();
  const pr = text.match(PR_ROW_RE);
  return pr ? `pr:${pr[1]}` : `text:${text}`;
}

const MAX_PASSES = 8;

/** @param {string} source @returns {Array<TaskMarker | null>} */
export function taskMarkers(source) {
  const tasks = taskTokens(source);
  // Each task's item line is searched in document order, then one re-parse with every candidate flipped checks
  // them all at once; a candidate in code, a comment or raw HTML flips nothing and is retried past that hit.
  const starts = tasks.map(() => 0);
  /** @type {number[]} */
  let offsets = [];
  /** @type {boolean[]} */
  let flipped = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let cursor = 0;
    offsets = tasks.map(({ line }, i) => {
      const at = source.indexOf(line, Math.max(cursor, starts[i]));
      if (at < 0) return -1;
      cursor = at + line.length;
      return at + line.indexOf("[") + 1;
    });
    /** @type {string[]} */
    const parts = [];
    let from = 0;
    offsets.forEach((offset, i) => {
      if (offset < 0) return;
      parts.push(source.slice(from, offset), tasks[i].checked ? " " : "x");
      from = offset + 1;
    });
    const after = taskTokens(parts.join("") + source.slice(from));
    if (after.length !== tasks.length) return tasks.map(() => null);
    flipped = tasks.map(({ checked }, i) => offsets[i] >= 0 && after[i].checked !== checked);
    const retry = tasks.flatMap((_, i) => (offsets[i] >= 0 && !flipped[i] ? [i] : []));
    if (!retry.length) break;
    for (const i of retry) starts[i] = offsets[i];
  }
  return tasks.map(({ checked }, i) => (flipped[i] ? { offset: offsets[i], checked, key: taskKey(source, offsets[i]) } : null));
}

/** @param {string} source @param {TaskIntent[]} tasks @returns {{ body: string, missing: TaskIntent[] }} */
export function setTasksByKey(source, tasks) {
  /** @type {Map<string, TaskMarker | null>} */
  const byKey = new Map();
  for (const marker of taskMarkers(source)) if (marker) byKey.set(marker.key, byKey.has(marker.key) ? null : marker);
  let body = source;
  /** @type {TaskIntent[]} */
  const missing = [];
  for (const task of tasks) {
    const marker = byKey.get(task.key);
    if (!marker) missing.push(task);
    else if ((body[marker.offset] !== " ") !== task.checked) body = withMarker(body, marker.offset, task.checked);
  }
  return { body, missing };
}

