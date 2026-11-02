import { tokenizeCodeBlock } from "./offThreadHighlight.js";
import { langForName } from "./highlight.js";

// Rendered markdown reads revision, so blocks that were pending re-render once their tokens land.
export const codeHl = $state({ revision: 0 });

// Fenced code is tokenized off the main thread. Until a block's tokens arrive it renders as
// plain text, and the caller must not cache that rendering.
export const HIGHLIGHT_PENDING = Symbol("highlight pending");

const BLOCK_CACHE_MAX = 500;
const blocks = new Map();
let revisionQueued = false;

function publishBlock(key, tokens) {
  blocks.set(key, tokens);
  if (blocks.size > BLOCK_CACHE_MAX) blocks.delete(blocks.keys().next().value);
  if (revisionQueued) return;
  revisionQueued = true;
  // Blocks from one conversation land together; re-render markdown once for the batch.
  requestAnimationFrame(() => {
    revisionQueued = false;
    codeHl.revision++;
  });
}

// Returns tokens per line, null when the block cannot be highlighted, or HIGHLIGHT_PENDING.
export function highlightFencedCode(code, fenceLang, themeName) {
  const lang = langForName(fenceLang);
  if (!lang) return null;
  const key = `${themeName}\n${lang}\n${code}`;
  if (blocks.has(key)) return blocks.get(key);
  blocks.set(key, HIGHLIGHT_PENDING);
  tokenizeCodeBlock(code, lang, themeName).then(
    (tokens) => publishBlock(key, tokens),
    () => publishBlock(key, null),
  );
  return HIGHLIGHT_PENDING;
}
