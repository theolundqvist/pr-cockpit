import { describe, expect, test } from "bun:test";
import { anchorThreads, buildGapRows, buildWholeFile, fileDiffFingerprint, fileUsesSplitLayout, hunkOldOffset, indexDiff, parseDiff, revertChange, revertFile, revertHunk, splitDiffRows } from "./diff.js";
import { createDiffDocument } from "./diffDocument.js";

function makeDiff(hunkBody) {
  return `diff --git a/foo.ts b/foo.ts\nindex abc..def 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n${hunkBody}\n`;
}

describe("parseDiff whitespace-tolerant alignment", () => {
  test("an indent-only change renders as an unchanged, marked line", () => {
    const files = parseDiff(makeDiff("-  const x = 1;\n+    const x = 1;"));
    const rows = files[0].hunks[0].rows;
    expect(rows).toEqual([{ type: "context", oldNum: 1, newNum: 1, text: "    const x = 1;", oldText: "  const x = 1;", wsOnly: true }]);
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
  });

  test("a genuinely changed line still renders as changed", () => {
    const files = parseDiff(makeDiff("-const x = 1;\n+const x = 2;"));
    const rows = files[0].hunks[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["del", "add"]);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
  });

  test("mixed block: whitespace-only pairs collapse, real changes stay, unmatched dels/adds are untouched", () => {
    const files = parseDiff(
      makeDiff("-  const a = 1;\n-const b = 1;\n-const c = 1;\n+    const a = 1;\n+const b = 2;"),
    );
    const rows = files[0].hunks[0].rows;
    expect(rows).toEqual([
      { type: "context", oldNum: 1, newNum: 1, text: "    const a = 1;", oldText: "  const a = 1;", wsOnly: true },
      { type: "del", oldNum: 2, newNum: null, text: "const b = 1;", intra: { start: 10, end: 11 } },
      { type: "add", oldNum: null, newNum: 2, text: "const b = 2;", intra: { start: 10, end: 11 } },
      { type: "del", oldNum: 3, newNum: null, text: "const c = 1;" },
    ]);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(2);
  });

  test("intra-line marks span only the changed segment of a mostly-similar pair", () => {
    const files = parseDiff(makeDiff("-export const foo = 1;\n+const foo = 1;"));
    const [del, add] = files[0].hunks[0].rows;
    expect(del.intra).toEqual({ start: 0, end: 7 });
    expect(add.intra).toBeUndefined();
  });

  test("a near-total rewrite gets no intra marks", () => {
    const files = parseDiff(makeDiff("-const alpha = 1;\n+return beta();"));
    const [del, add] = files[0].hunks[0].rows;
    expect(del.intra).toBeUndefined();
    expect(add.intra).toBeUndefined();
  });

  test("a multi-line block rewrite renders as all dels then all adds, not zipped", () => {
    const files = parseDiff(
      makeDiff("-const a = 1;\n-const b = 2;\n-const c = 3;\n+const a = 10;\n+const b = 20;\n+const c = 30;"),
    );
    const rows = files[0].hunks[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["del", "del", "del", "add", "add", "add"]);
  });

  test("context lines around a change block are left untouched", () => {
    const files = parseDiff(makeDiff(" const before = 1;\n-  const x = 1;\n+    const x = 1;\n const after = 1;"));
    const rows = files[0].hunks[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["context", "context", "context"]);
  });
});

describe("parseDiff renames", () => {
  test("identifies a file renamed without content changes", () => {
    const [file] = parseDiff(
      "diff --git a/docs/old.md b/docs/new.md\nsimilarity index 100%\nrename from docs/old.md\nrename to docs/new.md\n",
    );

    expect(file.previousPath).toBe("docs/old.md");
    expect(file.path).toBe("docs/new.md");
    expect(file.similarity).toBe(100);
    expect(file.isUnchangedRename).toBe(true);
    expect(file.hunks).toEqual([]);
  });

  test("does not hide a renamed binary file with content changes", () => {
    const [file] = parseDiff(
      "diff --git a/assets/old.bin b/assets/new.bin\nsimilarity index 90%\nrename from assets/old.bin\nrename to assets/new.bin\nBinary files a/assets/old.bin and b/assets/new.bin differ\n",
    );

    expect(file.isUnchangedRename).toBe(false);
    expect(file.isBinary).toBe(true);
  });
});

describe("splitDiffRows", () => {
  test("pairs changed lines and preserves surrounding context", () => {
    const rows = parseDiff(makeDiff(" const before = 1;\n-old one\n-old two\n+new one\n const after = 1;"))[0].hunks[0].rows;

    const pairs = splitDiffRows(rows);

    expect(pairs.map(({ left, right }) => [left?.type ?? null, right?.type ?? null])).toEqual([
      ["context", "context"],
      ["del", "add"],
      ["del", null],
      ["context", "context"],
    ]);
    expect(pairs[0].left).toBe(pairs[0].right);
  });

  test("leaves an empty left cell for added-only blocks", () => {
    const rows = parseDiff(makeDiff("+first\n+second"))[0].hunks[0].rows;

    expect(splitDiffRows(rows).map(({ left, right }) => [left, right?.text])).toEqual([
      [null, "first"],
      [null, "second"],
    ]);
  });
});

describe("fileUsesSplitLayout", () => {
  test("keeps one-sided diffs full width", () => {
    expect(fileUsesSplitLayout({ additions: 3, deletions: 2 }, "split")).toBe(true);
    expect(fileUsesSplitLayout({ additions: 3, deletions: 0 }, "split")).toBe(false);
    expect(fileUsesSplitLayout({ additions: 0, deletions: 2 }, "split")).toBe(false);
    expect(fileUsesSplitLayout({ additions: 3, deletions: 2 }, "unified")).toBe(false);
  });
});

describe("fileDiffFingerprint", () => {
  test("changes only when the file diff changes", () => {
    const [file] = parseDiff(makeDiff(" before\n-old\n+new"));
    const [same] = parseDiff(makeDiff(" before\n-old\n+new"));
    const [changed] = parseDiff(makeDiff(" before\n-old\n+newer"));

    expect(fileDiffFingerprint(file)).toBe(fileDiffFingerprint(same));
    expect(fileDiffFingerprint(file)).not.toBe(fileDiffFingerprint(changed));
  });
  test("changes when a binary file's blobs change", () => {
    const binaryDiff = (index) => `diff --git a/logo.png b/logo.png\nindex ${index}\nBinary files a/logo.png and b/logo.png differ\n`;
    const [first] = parseDiff(binaryDiff("1111111..2222222 100644"));
    const [same] = parseDiff(binaryDiff("1111111..2222222 100644"));
    const [changed] = parseDiff(binaryDiff("1111111..3333333 100644"));

    expect(first.isBinary).toBe(true);
    expect(fileDiffFingerprint(first)).toBe(fileDiffFingerprint(same));
    expect(fileDiffFingerprint(first)).not.toBe(fileDiffFingerprint(changed));
  });
});


describe("hunkOldOffset", () => {
  test("derives the unchanged-line offset from compact and counted ranges", () => {
    expect(hunkOldOffset("@@ -1 +1 @@")).toBe(0);
    expect(hunkOldOffset("@@ -496,3 +517,3 @@")).toBe(-21);
  });
});

describe("revertHunk", () => {
  test("replaces only the selected hunk with its original lines", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -2,3 +2,4 @@\n before\n-old\n+new\n+extra\n after\n",
    );

    expect(revertHunk("top\nbefore\nnew\nextra\nafter\nbottom\n", file.hunks[0])).toBe(
      "top\nbefore\nold\nafter\nbottom\n",
    );
  });

  test("restores the old text of whitespace-only rows", () => {
    const [file] = parseDiff(makeDiff("-  const x = 1;\n+    const x = 1;"));

    expect(revertHunk("    const x = 1;\n", file.hunks[0])).toBe("  const x = 1;\n");
  });

  test("restores a trailing newline removed by the hunk", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n",
    );

    expect(revertHunk("new", file.hunks[0])).toBe("old\n");
  });

  test("removes a trailing newline added by the hunk", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n",
    );

    expect(revertHunk("new\n", file.hunks[0])).toBe("old");
  });

  test("rejects a hunk that no longer matches the head file", () => {
    const [file] = parseDiff(makeDiff("-const x = 1;\n+const x = 2;"));

    expect(() => revertHunk("const x = 3;\n", file.hunks[0])).toThrow("file no longer matches this hunk");
  });
});

describe("revertChange", () => {
  test("reverts only the selected change block inside a larger diff hunk", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,5 +1,5 @@\n before\n-old one\n+new one\n middle\n-old two\n+new two\n after\n",
    );
    const selected = file.hunks[0].rows.find((row) => row.text === "new one");

    expect(revertChange("before\nnew one\nmiddle\nnew two\nafter\n", file.hunks[0], selected)).toBe(
      "before\nold one\nmiddle\nnew two\nafter\n",
    );
  });

  test("restores a selected deletion without reverting a later change", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,5 +1,4 @@\n before\n-removed\n middle\n-old two\n+new two\n after\n",
    );
    const selected = file.hunks[0].rows.find((row) => row.text === "removed");

    expect(revertChange("before\nmiddle\nnew two\nafter\n", file.hunks[0], selected)).toBe(
      "before\nremoved\nmiddle\nnew two\nafter\n",
    );
  });

  test("restores a selected whitespace-only change", () => {
    const [file] = parseDiff(makeDiff("-  const x = 1;\n+    const x = 1;"));

    expect(revertChange("    const x = 1;\n", file.hunks[0], file.hunks[0].rows[0])).toBe("  const x = 1;\n");
  });

  test("rejects a selected change that no longer matches the head file", () => {
    const [file] = parseDiff(makeDiff("-const x = 1;\n+const x = 2;"));

    expect(() => revertChange("const x = 3;\n", file.hunks[0], file.hunks[0].rows[1])).toThrow(
      "file no longer matches this hunk",
    );
  });
});

describe("revertFile", () => {
  test("reverts every hunk without shifting earlier ranges", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,2 @@\n-old top\n+new top\n+extra top\n@@ -4 +5 @@\n-old bottom\n+new bottom\n",
    );

    expect(revertFile("new top\nextra top\nkeep one\nkeep two\nnew bottom\n", file)).toBe(
      "old top\nkeep one\nkeep two\nold bottom\n",
    );
  });
});

describe("buildGapRows", () => {
  test("maps expanded new-file context to the matching old-file lines", () => {
    const content = Array.from({ length: 520 }, (_, index) => `line ${index + 1}`).join("\n");

    const rows = buildGapRows(content, 516, 520, -21);

    expect(rows).toEqual([
      { type: "context", oldNum: 496, newNum: 517, text: "line 517" },
      { type: "context", oldNum: 497, newNum: 518, text: "line 518" },
      { type: "context", oldNum: 498, newNum: 519, text: "line 519" },
    ]);
    expect(splitDiffRows(rows)).toEqual(rows.map((row) => ({ left: row, right: row })));
  });
});

describe("buildWholeFile", () => {
  test("numbers unchanged rows on both sides across additions", () => {
    const [file] = parseDiff(
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -2,2 +2,3 @@\n line 2\n+added\n line 3\n",
    );

    const rows = buildWholeFile(file, "line 1\nline 2\nadded\nline 3\nline 4\n");

    expect(rows.map(({ oldNum, newNum }) => [oldNum, newNum])).toEqual([
      [1, 1],
      [2, 2],
      [null, 3],
      [3, 4],
      [4, 5],
    ]);
    expect(splitDiffRows(rows)[4]).toEqual({ left: rows[4], right: rows[4] });
  });
});

describe("lazy diff document", () => {
  const text = [
    makeDiff(" context\n-old\n+new"),
    "diff --git a/bar.ts b/bar.ts\nnew file mode 100644\n--- /dev/null\n+++ b/bar.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n",
  ].join("");

  test("indexes compact file metadata without retaining rows", () => {
    const indexed = indexDiff(text);

    expect(indexed.map((file) => file.path)).toEqual(["foo.ts", "bar.ts"]);
    expect(indexed[0].hunks[0]).toMatchObject({
      rowCount: 3,
      splitRowCount: 2,
      newLineRanges: [[1, 2]],
      rows: null,
    });
    expect(fileDiffFingerprint(indexed[0])).toBe(indexed[0].fingerprint);
  });

  test("hydrates one file without changing its indexed identity", () => {
    const indexed = indexDiff(text);
    const document = createDiffDocument(text, indexed);
    const hydrated = document.hydrate("bar.ts");

    expect(hydrated.hydrated).toBe(true);
    expect(hydrated.hunks[0].rows.map((row) => row.text)).toEqual(["one", "two"]);
    expect(hydrated.fingerprint).toBe(indexed[1].fingerprint);
    expect(document.hydrate("bar.ts")).toBe(hydrated);
    expect(indexed[0].hunks[0].rows).toBeNull();
  });

  test("releases hydrated rows back to compact metadata", async () => {
    const indexed = indexDiff(text);
    const document = createDiffDocument(text, indexed);
    const hydrated = await document.prefetch("bar.ts");

    expect(hydrated.hydrated).toBe(true);
    expect(document.release("bar.ts")).toBe(indexed[1]);
    expect(document.hydrate("bar.ts")).not.toBe(hydrated);
  });

  test("discards obsolete worker results and accepts the next request", async () => {
    const indexed = indexDiff(text);
    const messages = [];
    const worker = { postMessage: (message) => messages.push(message), terminate() {} };
    const document = createDiffDocument(text, indexed, worker);

    const obsolete = document.prefetch("bar.ts");
    document.release("bar.ts");
    const current = document.prefetch("bar.ts");
    expect(messages).toHaveLength(2);

    worker.onmessage({ data: { type: "file", id: messages[0].id, file: parseDiff(text)[1] } });
    expect(await obsolete).toBeNull();
    expect(document.prefetch("bar.ts")).toBe(current);
    expect(messages).toHaveLength(2);
    worker.onmessage({ data: { type: "file", id: messages[1].id, file: parseDiff(text)[1] } });
    expect((await current).hunks[0].rows.map((row) => row.text)).toEqual(["one", "two"]);
  });

  test("anchors threads identically before and after hydration", () => {
    const indexed = indexDiff(text);
    const document = createDiffDocument(text, indexed);
    const thread = { path: "bar.ts", line: 2, diffSide: "RIGHT" };

    expect(anchorThreads(indexed, [thread]).anchored.get("bar.ts:2")).toEqual([thread]);
    const hydrated = indexed.map((file) => (file.path === "bar.ts" ? document.hydrate(file.path) : file));
    expect(anchorThreads(hydrated, [thread]).anchored.get("bar.ts:2")).toEqual([thread]);
  });
});
