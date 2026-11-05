import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VIRTUAL = "virtual:usage-words";
/** aria-label="Close" or title="Close", nothing interpolated. */
const STATIC_LABEL = /\b(?:aria-label|title)="([^"{]*)"/g;
/** The start of aria-label={...} or title={...}, whose plain string literals are labels. */
const EXPRESSION_LABEL = /\b(?:aria-label|title)=\{/g;
/** The static words a control ends in, <button ...>Close</button>, or the span or key hint after them, <span>Merge</span>, update branch <Kbd keys="u" />. */
const CLOSING_TEXT = />([^<>{}]+)(?:<\/(?:button|a|summary|option|label|span)>|<Kbd\b)/g;
/** A string label or title in a table, { label: "Merge" }. */
const TABLE_LABEL = /\b(?:label|title):\s*(?:"([^"\\]*)"|'([^'\\]*)')/g;
/** A static id, which may name a place or control. */
const STATIC_ID = /\sid="([a-z][a-z-]*)"/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The plain string literals of the expression that starts at `start`, just past its `{`; template literals are skipped, being built from data. */
function expressionLiterals(source, start) {
  const literals = [];
  let depth = 1;
  for (let i = start; i < source.length && depth > 0; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === '"' || char === "'" || char === "`") {
      let end = i + 1;
      while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1;
      if (char !== "`") literals.push(source.slice(i + 1, end));
      i = end;
    }
  }
  return literals;
}

/**
 * The app's own words, which usage stats may name a control by (controlName in src/lib/usage.js): labels and words its source writes, never one
 * interpolated from data. Static aria-label and title values and the plain string literals in aria-label={...} and title={...}; static text a button,
 * link, summary, option, label or span ends in, or that a key hint follows; label and title strings in .js tables; and static ids. Tests are skipped.
 */
export function appWords(srcDir) {
  const words = new Set();
  const add = (text) => {
    const word = text.replace(/&(\w+);/g, (entity, name) => ENTITIES[name] ?? entity).replace(/\s+/g, " ").trim();
    if (word.length >= 1 && word.length <= 40 && !word.includes("\\")) words.add(word);
  };
  for (const file of readdirSync(srcDir, { recursive: true })) {
    if (!/\.(svelte|js)$/.test(file) || /\.test\.js$/.test(file)) continue;
    const source = readFileSync(join(srcDir, file), "utf8");
    if (file.endsWith(".js")) {
      for (const [, double, single] of source.matchAll(TABLE_LABEL)) add(double ?? single);
      continue;
    }
    for (const [, label] of source.matchAll(STATIC_LABEL)) add(label);
    for (const match of source.matchAll(EXPRESSION_LABEL)) for (const literal of expressionLiterals(source, match.index + match[0].length)) add(literal);
    for (const [, text] of source.matchAll(CLOSING_TEXT)) add(text);
    for (const [, id] of source.matchAll(STATIC_ID)) add(id);
  }
  return [...words].sort();
}

/** Serves `virtual:usage-words`, the app's words as an array, read from the source at build time. */
export function usageWords(srcDir = fileURLToPath(new URL("./src", import.meta.url))) {
  return {
    name: "usage-words",
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    load: (id) => (id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(appWords(srcDir))};` : null),
  };
}
