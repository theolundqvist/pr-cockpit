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
  range.setEnd(token.endNode, token.end);
  CSS.highlights.set(DEFINITION_HIGHLIGHT, new Highlight(range));
  container.classList.add("definition-link-hover");
  owner.container = container;
  highlightOwner = owner;
  return true;
}

// Nearest ancestor that lays out as a block: syntax and word-diff spans inside it are one run of text.
function textBlock(node) {
  let element = node.parentElement;
  while (element?.parentElement && getComputedStyle(element).display.startsWith("inline")) element = element.parentElement;
  return element;
}

// Identifier under the pointer, plus enough context to compute its column. Syntax highlighting and
// word-diff marks split one identifier across text nodes, so the word extends through adjacent nodes.
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
  const block = textBlock(node);
  if (!block) return null;
  // Text nodes of this block in order; nodes nested in another block (a gutter cell) break words.
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    // Empty nodes (framework anchors) separate nothing.
    if (current.textContent || current === node) nodes.push(textBlock(current) === block ? current : null);
  }
  const index = nodes.indexOf(node);
  if (index < 0) return null;
  const charAt = (at, position) => nodes[at]?.textContent[position] ?? "";
  let startIndex = index;
  let start = offset;
  for (;;) {
    if (start > 0 && WORD_CHAR.test(charAt(startIndex, start - 1))) start -= 1;
    else if (start === 0 && nodes[startIndex - 1] && WORD_CHAR.test(charAt(startIndex - 1, nodes[startIndex - 1].textContent.length - 1))) {
      startIndex -= 1;
      start = nodes[startIndex].textContent.length;
    } else break;
  }
  let endIndex = index;
  let end = offset;
  for (;;) {
    const length = nodes[endIndex].textContent.length;
    if (end < length && WORD_CHAR.test(charAt(endIndex, end))) end += 1;
    else if (end === length && nodes[endIndex + 1] && WORD_CHAR.test(charAt(endIndex + 1, 0))) {
      endIndex += 1;
      end = 0;
    } else break;
  }
  let word = "";
  for (let at = startIndex; at <= endIndex; at += 1) {
    const text = nodes[at].textContent;
    word += text.slice(at === startIndex ? start : 0, at === endIndex ? end : text.length);
  }
  return IDENT.test(word) ? { word, node: nodes[startIndex], start, endNode: nodes[endIndex], end } : null;
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
