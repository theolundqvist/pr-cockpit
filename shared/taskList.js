import { marked } from "marked";

/** @typedef {{ offset: number, checked: boolean, key: string }} TaskMarker */

/** @param {string} source @returns {boolean[]} */
function taskStates(source) {
  /** @type {boolean[]} */
  const states = [];
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === "checkbox") states.push(token.checked);
  });
  return states;
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

/** @param {string} source @returns {Array<TaskMarker | null>} */
export function taskMarkers(source) {
  const states = taskStates(source);
  // Only markers that change one parsed checkbox count as tasks.
  /** @type {Array<TaskMarker | null>} */
  const markers = states.map(() => null);
  for (const match of source.matchAll(/\[([ xX])\]/g)) {
    const offset = match.index + 1;
    const after = taskStates(withMarker(source, offset, match[1] === " "));
    if (after.length !== states.length) continue;
    const changed = states.flatMap((state, i) => (after[i] === state ? [] : [i]));
    if (changed.length !== 1 || markers[changed[0]]) continue;
    markers[changed[0]] = { offset, checked: states[changed[0]], key: taskKey(source, offset) };
  }
  return markers;
}

/** @param {string} source @param {string} key @param {boolean} checked @returns {string | null} */
export function setTaskByKey(source, key, checked) {
  const matches = taskMarkers(source).filter((marker) => marker?.key === key);
  if (matches.length !== 1 || !matches[0]) return null;
  return matches[0].checked === checked ? source : withMarker(source, matches[0].offset, checked);
}
