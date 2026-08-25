const HUNK_HEADER = /^(@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@)(.*)$/;

export function parseDiff(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const files = [];
  let file = null;
  let oldNum = 0;
  let newNum = 0;

  const pushFile = (path) => {
    file = {
      path,
      previousPath: null,
      similarity: null,
      isNew: false,
      isDeleted: false,
      isBinary: false,
      index: null,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    files.push(file);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      pushFile(match ? match[2] : line.slice("diff --git ".length));
      continue;
    }
    if (!file) continue;

    const hunkHeader = line.match(HUNK_HEADER);
    if (hunkHeader) {
      oldNum = Number(hunkHeader[2]);
      newNum = Number(hunkHeader[3]);
      file.hunks.push({
        range: hunkHeader[1],
        context: hunkHeader[4].trim(),
        rows: [],
        oldNoNewline: false,
        newNoNewline: false,
      });
    } else if (file.hunks.length > 0) {
      const hunk = file.hunks[file.hunks.length - 1];
      const kind = line[0];
      if (kind === "+") {
        hunk.rows.push({ type: "add", oldNum: null, newNum, text: line.slice(1) });
        file.additions++;
        newNum++;
      } else if (kind === "-") {
        hunk.rows.push({ type: "del", oldNum, newNum: null, text: line.slice(1) });
        file.deletions++;
        oldNum++;
      } else if (kind === "\\") {
        const previous = hunk.rows.at(-1);
        if (previous?.type === "del") hunk.oldNoNewline = true;
        else if (previous?.type === "add") hunk.newNoNewline = true;
        else if (previous?.type === "context") {
          hunk.oldNoNewline = true;
          hunk.newNoNewline = true;
        }
      } else {
        hunk.rows.push({ type: "context", oldNum, newNum, text: line.slice(1) });
        oldNum++;
        newNum++;
      }
    } else if (line.startsWith("index ")) {
      file.index = line.slice("index ".length).trim();
    } else if (line.startsWith("similarity index ")) {
      file.similarity = Number.parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("new file mode")) file.isNew = true;
    else if (line.startsWith("deleted file mode")) file.isDeleted = true;
    else if (line.startsWith("Binary files")) file.isBinary = true;
    else if (line.startsWith("rename from ")) file.previousPath = line.slice("rename from ".length);
    else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
  }
  for (const file of files) {
    file.isUnchangedRename = file.previousPath !== null && file.similarity === 100 && file.hunks.length === 0;
    for (const hunk of file.hunks) alignWhitespaceOnly(file, hunk);
  }
  return files;
}

export function splitDiffRows(rows) {
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "context") {
      pairs.push({ left: rows[i], right: rows[i] });
      i++;
      continue;
    }
    const deleted = [];
    const added = [];
    while (i < rows.length && rows[i].type !== "context") {
      if (rows[i].type === "del") deleted.push(rows[i]);
      else if (rows[i].type === "add") added.push(rows[i]);
      i++;
    }
    const count = Math.max(deleted.length, added.length);
    for (let j = 0; j < count; j++) {
      pairs.push({ left: deleted[j] ?? null, right: added[j] ?? null });
    }
  }
  return pairs;
}

function isWhitespaceOnlyChange(delText, addText) {
  return delText !== addText && delText.trim() === addText.trim();
}

const MAX_CHANGED_RATIO = 0.5;

// prefix/suffix delta of a paired del/add line; skips near-total rewrites so only mostly-similar lines get inner marks
function markIntraline(del, add) {
  const a = del.text;
  const b = add.text;
  const min = Math.min(a.length, b.length);
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  let s = 0;
  while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen - p - s > maxLen * MAX_CHANGED_RATIO) return;
  if (a.length - p - s > 0) del.intra = { start: p, end: a.length - s };
  if (b.length - p - s > 0) add.intra = { start: p, end: b.length - s };
}

// pairs dels with adds positionally within a change block, collapsing whitespace-only pairs into one unchanged line
function alignWhitespaceOnly(file, hunk) {
  const rows = hunk.rows;
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "del") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < rows.length && rows[delEnd].type === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd].type === "add") addEnd++;
    const pairCount = Math.min(delEnd - i, addEnd - delEnd);
    let pendingDels = [];
    let pendingAdds = [];
    const flushPending = () => {
      out.push(...pendingDels, ...pendingAdds);
      pendingDels = [];
      pendingAdds = [];
    };
    for (let k = 0; k < pairCount; k++) {
      const del = rows[i + k];
      const add = rows[delEnd + k];
      if (isWhitespaceOnlyChange(del.text, add.text)) {
        flushPending();
        out.push({ type: "context", oldNum: del.oldNum, newNum: add.newNum, text: add.text, oldText: del.text, wsOnly: true });
        file.additions--;
        file.deletions--;
      } else {
        markIntraline(del, add);
        pendingDels.push(del);
        pendingAdds.push(add);
      }
    }
    flushPending();
    for (let k = i + pairCount; k < delEnd; k++) out.push(rows[k]);
    for (let k = delEnd + pairCount; k < addEnd; k++) out.push(rows[k]);
    i = addEnd;
  }
  hunk.rows = out;
}

export function fileUsesSplitLayout(file, layout) {
  return layout === "split" && file.additions > 0 && file.deletions > 0;
}

export function fileDiffFingerprint(file) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const add = (value) => {
    const text = String(value ?? "");
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    first = Math.imul(first ^ 0, 0x01000193);
    second = Math.imul(second ^ 0, 0x85ebca6b);
  };
  add(file.isNew);
  add(file.previousPath);
  add(file.similarity);
  add(file.isDeleted);
  add(file.isBinary);
  add(file.index);
  for (const hunk of file.hunks) {
    add(hunk.range);
    add(hunk.oldNoNewline);
    add(hunk.newNoNewline);
    for (const row of hunk.rows) {
      add(row.type);
      add(row.oldNum);
      add(row.newNum);
      add(row.text);
      add(row.oldText);
    }
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

const HUNK_RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkRange(range) {
  const match = HUNK_RANGE.exec(range);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

export function hunkOldOffset(range) {
  const hunk = parseHunkRange(range);
  return hunk ? hunk.oldStart - hunk.newStart : 0;
}

function revertRows(content, hunk, first, last) {
  const range = parseHunkRange(hunk.range);
  if (!range) throw new Error("Couldn't read this hunk.");

  const endsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (endsWithNewline) lines.pop();

  const before = hunk.rows.slice(0, first);
  const rows = hunk.rows.slice(first, last);
  const start = Math.max(0, range.newStart - 1 + before.filter((row) => row.type !== "del").length);
  const current = rows.filter((row) => row.type !== "del").map((row) => row.text);
  const original = rows.filter((row) => row.type !== "add").map((row) => row.oldText ?? row.text);
  const actual = lines.slice(start, start + current.length);
  const beforeContext = before.filter((row) => row.type !== "del").at(-1);
  const afterContext = hunk.rows.slice(last).find((row) => row.type !== "del");
  const mismatched =
    actual.length !== current.length ||
    actual.some((line, index) => line !== current[index]) ||
    (beforeContext && lines[start - 1] !== beforeContext.text) ||
    (afterContext && lines[start + current.length] !== afterContext.text);
  if (mismatched) {
    throw new Error("The file no longer matches this hunk. Refresh the pull request and try again.");
  }

  const touchesEnd = last === hunk.rows.length && start + current.length === lines.length;
  lines.splice(start, current.length, ...original);
  const revertedEndsWithNewline =
    touchesEnd && (hunk.oldNoNewline || hunk.newNoNewline) ? !hunk.oldNoNewline : endsWithNewline;
  return `${lines.join("\n")}${revertedEndsWithNewline ? "\n" : ""}`;
}

function isChangedRow(row) {
  return row.type !== "context" || row.wsOnly;
}

export function revertChange(content, hunk, selectedRow) {
  const index = hunk.rows.indexOf(selectedRow);
  if (index < 0 || !isChangedRow(selectedRow)) throw new Error("Choose a changed line to revert.");
  let first = index;
  let last = index + 1;
  while (first > 0 && isChangedRow(hunk.rows[first - 1])) first--;
  while (last < hunk.rows.length && isChangedRow(hunk.rows[last])) last++;
  return revertRows(content, hunk, first, last);
}

export function revertHunk(content, hunk) {
  return revertRows(content, hunk, 0, hunk.rows.length);
}

export function revertFile(content, file) {
  let reverted = content;
  for (const hunk of [...file.hunks].reverse()) reverted = revertHunk(reverted, hunk);
  return reverted;
}

export function buildWholeFile(file, content) {
  const fileLines = content.split("\n");
  if (fileLines[fileLines.length - 1] === "") fileLines.pop();

  const hunkRowByNewNum = new Map();
  const deletesAfter = new Map();
  const ranges = file.hunks.map((hunk) => parseHunkRange(hunk.range)).filter(Boolean);
  for (const hunk of file.hunks) {
    let lastNewNum = Number(/\+(\d+)/.exec(hunk.range)?.[1] ?? 1) - 1;
    for (const row of hunk.rows) {
      if (row.type === "del") {
        if (!deletesAfter.has(lastNewNum)) deletesAfter.set(lastNewNum, []);
        deletesAfter.get(lastNewNum).push(row);
      } else {
        hunkRowByNewNum.set(row.newNum, row);
        lastNewNum = row.newNum;
      }
    }
  }

  const rows = [];
  let nextRange = 0;
  const finalRange = ranges.at(-1);
  const finalOffset = finalRange
    ? finalRange.oldStart + finalRange.oldCount - finalRange.newStart - finalRange.newCount
    : 0;
  for (const del of deletesAfter.get(0) ?? []) rows.push(del);
  for (let ln = 1; ln <= fileLines.length; ln++) {
    while (nextRange < ranges.length && ranges[nextRange].newStart <= ln) nextRange++;
    const offset = nextRange < ranges.length
      ? ranges[nextRange].oldStart - ranges[nextRange].newStart
      : finalOffset;
    rows.push(hunkRowByNewNum.get(ln) ?? {
      type: "context",
      oldNum: file.isNew ? null : ln + offset,
      newNum: ln,
      text: fileLines[ln - 1],
    });
    for (const del of deletesAfter.get(ln) ?? []) rows.push(del);
  }
  return rows;
}

export function buildGapRows(content, fromNewNum, toNewNum, oldOffset) {
  const fileLines = content.split("\n");
  if (fileLines[fileLines.length - 1] === "") fileLines.pop();
  const rows = [];
  for (let ln = fromNewNum + 1; ln < toNewNum; ln++) {
    rows.push({ type: "context", oldNum: ln + oldOffset, newNum: ln, text: fileLines[ln - 1] ?? "" });
  }
  return rows;
}

export function anchorThreads(files, threads) {
  const newLinesByPath = new Map();
  for (const file of files) {
    const lines = new Set();
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.newNum !== null) lines.add(row.newNum);
      }
    }
    newLinesByPath.set(file.path, lines);
  }

  const anchored = new Map();
  const unanchored = [];
  for (const thread of threads) {
    const lines = newLinesByPath.get(thread.path);
    if (thread.line !== null && thread.diffSide === "RIGHT" && lines?.has(thread.line)) {
      const key = `${thread.path}:${thread.line}`;
      if (!anchored.has(key)) anchored.set(key, []);
      anchored.get(key).push(thread);
    } else {
      unanchored.push(thread);
    }
  }
  return { anchored, unanchored };
}
