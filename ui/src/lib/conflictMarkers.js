import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

const MARKER_LINE_RE = /^(?:<{7,}|>{7,})(?: |$)/m;

/** A file is resolved once no conflict start or end marker line remains. */
export function hasConflictMarkers(text) {
  return MARKER_LINE_RE.test(text);
}

function markerLine(text, character, size) {
  return text.startsWith(character.repeat(size)) && (text.length === size || text[size] === " ");
}

/**
 * Complete conflict blocks as 1-based line numbers: `start` (<<<<<<<), `base` (|||||||, diff3 only),
 * `separator` (=======) and `end` (>>>>>>>). Markers longer than seven characters must match in length.
 */
export function findConflicts(lines) {
  const conflicts = [];
  let open = null;
  lines.forEach((text, index) => {
    const line = index + 1;
    const start = /^(<{7,})(?: |$)/.exec(text);
    if (start) {
      open = { start: line, size: start[1].length, base: null, separator: null };
    } else if (!open) {
      return;
    } else if (open.separator === null && open.base === null && markerLine(text, "|", open.size)) {
      open.base = line;
    } else if (open.separator === null && text === "=".repeat(open.size)) {
      open.separator = line;
    } else if (open.separator !== null && markerLine(text, ">", open.size)) {
      conflicts.push({ start: open.start, base: open.base, separator: open.separator, end: line });
      open = null;
    }
  });
  return conflicts;
}

function resolveConflict(view, conflict, choice) {
  const { doc } = view.state;
  const section = (first, last) => (first <= last ? doc.sliceString(doc.line(first).from, doc.line(last).to) : null);
  const current = section(conflict.start + 1, (conflict.base ?? conflict.separator) - 1);
  const incoming = section(conflict.separator + 1, conflict.end - 1);
  const kept = (choice === "current" ? [current] : choice === "incoming" ? [incoming] : [current, incoming]).filter((part) => part !== null);
  const lastLine = conflict.end === doc.lines;
  let from = doc.line(conflict.start).from;
  const to = lastLine ? doc.line(conflict.end).to : doc.line(conflict.end + 1).from;
  let insert = kept.join("\n");
  if (insert && !lastLine) insert += "\n";
  // Dropping a conflict that ends the file also drops the newline that led into it.
  if (!insert && lastLine && from > 0) from -= 1;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, scrollIntoView: true, userEvent: "input.resolve" });
  view.focus();
}

class ConflictActions extends WidgetType {
  constructor(start, labels) {
    super();
    this.start = start;
    this.labels = labels;
  }

  eq(other) {
    return other.start === this.start;
  }

  toDOM(view) {
    const bar = document.createElement("div");
    bar.className = "cm-conflict-actions";
    const choices = [
      ["current", `Accept current (${this.labels.current})`],
      ["incoming", `Accept incoming (${this.labels.incoming})`],
      ["both", "Accept both"],
    ];
    for (const [choice, label] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.choice = choice;
      // Keeps the editor's selection and focus where the click happened.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const conflict = findConflicts(view.state.doc.toJSON()).find((candidate) => candidate.start === this.start);
        if (conflict) resolveConflict(view, conflict, choice);
      });
      bar.append(button);
    }
    return bar;
  }
}

function conflictDecorations(state, labels) {
  const ranges = [];
  for (const conflict of findConflicts(state.doc.toJSON())) {
    const { from } = state.doc.line(conflict.start);
    ranges.push(Decoration.widget({ widget: new ConflictActions(conflict.start, labels), block: true, side: -1 }).range(from));
    const currentEnd = conflict.base ?? conflict.separator;
    for (let line = conflict.start; line <= conflict.end; line++) {
      const marker = line === conflict.start || line === conflict.base || line === conflict.separator || line === conflict.end;
      const className = marker
        ? "cm-conflict-marker"
        : line < currentEnd ? "cm-conflict-current" : line > conflict.separator ? "cm-conflict-incoming" : "cm-conflict-base";
      ranges.push(Decoration.line({ class: className }).range(state.doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}

/** Highlights each conflict's sides and offers accept actions above it; `labels` name the two branches. */
export function conflictEditing(labels) {
  return StateField.define({
    create: (state) => conflictDecorations(state, labels),
    update: (decorations, transaction) => (transaction.docChanged ? conflictDecorations(transaction.state, labels) : decorations),
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Moves the cursor to the next (1) or previous (-1) conflict, wrapping around the file. */
export function jumpToConflict(view, direction) {
  const conflicts = findConflicts(view.state.doc.toJSON());
  if (!conflicts.length) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const target = direction > 0
    ? conflicts.find((conflict) => conflict.start > line) ?? conflicts[0]
    : conflicts.findLast((conflict) => conflict.end < line) ?? conflicts.at(-1);
  const anchor = view.state.doc.line(target.start).from;
  view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
  view.focus();
}
