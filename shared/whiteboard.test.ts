import { describe, test, expect } from "bun:test";
import { emptyBoard, reconcileBoard, boardKey, personalState, historyChange, applyHistory, removeNodes, movingIds, moveNodes, intersects, validateBoard, clone, arrangeNodes } from "./whiteboard.js";

const pr = (number: number, extra = {}) => ({ repo: "example/cockpit", number, title: `PR ${number}`, author: "octocat", state: "OPEN", headSha: "a".repeat(40), ...extra });

describe("personal whiteboard reconciliation", () => {
  test("arrange removes empty section trees, keeps annotations, and can be undone", () => {
    const frame = (id, x, y, w = 352, h = 256) => ({ id, type: "section", text: id, x, y, w, h });
    const doc = emptyBoard();
    doc.nodes = [
      frame("empty", 0, 0),
      frame("empty-child", 16, 48, 160, 128),
      frame("notes", 400, 0),
      { id: "note", type: "text", text: "Review", x: 416, y: 48, w: 160, h: 128 },
      frame("drawing", 800, 0),
      { id: "stroke", type: "pen", x: 816, y: 48, w: 160, h: 128, points: [[0, 0], [160, 128]] },
    ];
    const arranged = { ...doc, nodes: arrangeNodes(doc.nodes, 1440, 800) };
    expect(arranged.nodes.map((n) => n.id)).toEqual(["notes", "note", "drawing", "stroke"]);
    const restored = applyHistory(arranged, historyChange(personalState(doc), personalState(arranged)));
    expect(new Map(restored.nodes.map((n) => [n.id, n]))).toEqual(new Map(doc.nodes.map((n) => [n.id, n])));
    expect(arrangeNodes(doc.nodes.slice(0, 2), 1440, 800)).toEqual([]);
  });
  test("new heads and missing PRs retain geometry, notes and remembered head", () => {
    const doc = reconcileBoard(emptyBoard(), [pr(1)]);
    const card = doc.nodes.find((n) => n.type === "pr")!;
    card.x = 1024; card.note = "Check migration order";
    const next = reconcileBoard(doc, [pr(1, { title: "New title", headSha: "b".repeat(40) }), pr(2)]);
    expect(next.nodes.find((n) => n.id === card.id)).toEqual(card);
    expect(next.snapshots[boardKey(pr(1))].title).toBe("New title");
    expect(next.nodes.filter((n) => n.type === "pr")).toHaveLength(2);
    expect(next.nodes.find((n) => n.key === boardKey(pr(2)))!.y).toBeGreaterThan(Math.max(...doc.nodes.map((n) => n.y + n.h)));
    expect(reconcileBoard(next, []).nodes).toEqual(next.nodes);
  });
  test("clear completed exclusions survive reload and refresh; undo keeps new live state", () => {
    const doc = reconcileBoard(emptyBoard(), [pr(1)]);
    const card = doc.nodes.find((n) => n.type === "pr")!;
    const removed = removeNodes(doc, new Set([card.id]));
    const history = historyChange(personalState(doc), personalState(removed));
    const reloaded = reconcileBoard(clone(removed), [pr(1, { state: "CLOSED", title: "Completed" })]);
    expect(reloaded.nodes.some((n) => n.id === card.id)).toBe(false);
    expect(reconcileBoard(reloaded, [pr(1)]).nodes.some((n) => n.id === card.id)).toBe(false);
    const undone = applyHistory(reloaded, history);
    expect(undone.nodes.find((n) => n.id === card.id)).toEqual(card);
    expect(undone.snapshots[card.key].state).toBe("CLOSED");
    expect(undone.excluded).toEqual([]);
    expect(applyHistory(undone, history, true).excluded).toContain(card.key);
  });
  test("undoing a gesture does not erase arrivals received after the gesture", () => {
    const before = reconcileBoard(emptyBoard(), [pr(1)]);
    const card = before.nodes.find((n) => n.type === "pr")!;
    const after = { ...before, nodes: moveNodes(before.nodes, new Set([card.id]), 32, 16) };
    const history = historyChange(personalState(before), personalState(after));
    const arrived = reconcileBoard(after, [pr(1), pr(2)]);
    const undone = applyHistory(arrived, history);
    expect(undone.nodes.find((n) => n.id === card.id)?.x).toBe(card.x);
    expect(undone.nodes.find((n) => n.key === boardKey(pr(2)))).toEqual(arrived.nodes.find((n) => n.key === boardKey(pr(2))));
  });
  test("section move carries contained notes and cards exactly once", () => {
    const doc = reconcileBoard(emptyBoard(), [pr(1)]);
    const section = doc.nodes[0];
    const card = doc.nodes[1];
    const note = { id: "note", type: "text", text: "Review", x: 20, y: 20, w: 40, h: 20 };
    const outside = { ...note, id: "outside", x: 2000 };
    const nodes = [...doc.nodes, note, outside];
    const moved = moveNodes(nodes, movingIds(nodes, [section.id, card.id]), 48, 32);
    for (const original of [section, card, note]) expect(moved.find((n) => n.id === original.id)?.x).toBe(original.x + 48);
    expect(moved.find((n) => n.id === outside.id)).toEqual(outside);
    expect(intersects(section, outside)).toBe(false);
  });
  test("first PR arrivals do not overlap notes created before the queue was available", () => {
    const doc = emptyBoard();
    doc.nodes.push({ id: "note-first", type: "text", text: "Review plan", x: 0, y: 0, w: 320, h: 240 });
    const next = reconcileBoard(doc, [pr(1), pr(1)]);
    const cards = next.nodes.filter((n) => n.type === "pr");
    expect(cards).toHaveLength(1);
    expect(intersects(doc.nodes[0], cards[0])).toBe(false);
    expect(next.nodes[0]).toEqual(doc.nodes[0]);
  });
  test("raw cache drafts arrive and save without changing completed or missing PR semantics", () => {
    const doc = reconcileBoard(emptyBoard(), [pr(1, { state: "draft", isDraft: false }), pr(2, { state: "CLOSED" }), pr(3, { state: "MERGED" })]);
    expect(doc.nodes.filter((n) => n.type === "pr").map((n) => n.key)).toEqual(["example/cockpit#1"]);
    expect(doc.snapshots["example/cockpit#1"]).toMatchObject({ state: "OPEN", isDraft: true });
    expect(doc.snapshots["example/cockpit#2"].state).toBe("CLOSED");
    expect(doc.snapshots["example/cockpit#3"].state).toBe("MERGED");
    expect(reconcileBoard(doc, []).snapshots["example/cockpit#1"].state).toBe("OPEN");
  });
  test("malformed documents are rejected rather than defaulted or partially reset", () => {
    const doc = reconcileBoard(emptyBoard(), [pr(1)]);
    expect(() => validateBoard({ ...doc, version: 99 })).toThrow();
    expect(() => validateBoard({ ...doc, nodes: [...doc.nodes, doc.nodes[1]] })).toThrow();
    expect(() => validateBoard({ ...doc, viewport: { x: 0, y: NaN, zoom: 1 } })).toThrow();
    expect(() => validateBoard({ ...doc, snapshots: {} })).toThrow();
  });
});
