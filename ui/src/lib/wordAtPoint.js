const WORD_CHAR = /[A-Za-z0-9_$]/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const DEFINITION_HIGHLIGHT = "definition-link";
let highlightOwner = null;

function clearDefinitionHighlight(owner) {
  owner.container?.classList.remove("definition-link-hover");
  owner.container = null;
  if (highlightOwner !== owner) return;
  CSS.highlights?.delete(DEFINITION_HIGHLIGHT);
  highlightOwner = null;
}

function showDefinitionHighlight(owner, container, token) {
  if (!CSS.highlights || typeof Highlight === "undefined" || !container.contains(token.node)) return false;
  highlightOwner?.container?.classList.remove("definition-link-hover");
  const range = document.createRange();
  range.setStart(token.node, token.start);
  range.setEnd(token.node, token.start + token.word.length);
  CSS.highlights.set(DEFINITION_HIGHLIGHT, new Highlight(range));
  container.classList.add("definition-link-hover");
  owner.container = container;
  highlightOwner = owner;
  return true;
}

// Identifier under the pointer, plus enough context to compute its column.
export function tokenAtPoint(x, y) {
  let node;
  let offset;
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) {
    node = range.startContainer;
    offset = range.startOffset;
  } else {
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    node = pos.offsetNode;
    offset = pos.offset;
  }
  if (node?.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent;
  if (!WORD_CHAR.test(text[offset] ?? "") && !WORD_CHAR.test(text[offset - 1] ?? "")) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  const word = text.slice(start, end);
  return IDENT.test(word) ? { word, node, start } : null;
}

export function wordAtPoint(x, y) {
  return tokenAtPoint(x, y)?.word ?? null;
}

// 0-based character offset of the token within its rendered line container.
export function columnWithin(container, token) {
  if (!container?.contains(token.node)) return null;
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(token.node, token.start);
  return range.toString().length;
}

export function createDefinitionHover(enabled = () => true) {
  let pointer = null;
  const owner = { container: null };

  function clear() {
    clearDefinitionHighlight(owner);
  }

  function update(modifierHeld) {
    clear();
    if (!modifierHeld || !pointer || !enabled()) return;
    const token = tokenAtPoint(pointer.x, pointer.y);
    if (!token) return;
    showDefinitionHighlight(owner, pointer.container, token);
  }

  function onMouseMove(event, container) {
    pointer = { x: event.clientX, y: event.clientY, container };
    update(event.ctrlKey || event.metaKey);
  }

  function onMouseLeave() {
    pointer = null;
    clear();
  }

  function onModifier(event) {
    if (event.key !== "Control" && event.key !== "Meta") return;
    update(event.ctrlKey || event.metaKey);
  }

  function destroy() {
    window.removeEventListener("keydown", onModifier);
    window.removeEventListener("keyup", onModifier);
    window.removeEventListener("blur", onMouseLeave);
    clear();
  }

  window.addEventListener("keydown", onModifier);
  window.addEventListener("keyup", onModifier);
  window.addEventListener("blur", onMouseLeave);

  return { onMouseMove, onMouseLeave, destroy };
}
