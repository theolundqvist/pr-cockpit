const { describe, expect, test } = require("bun:test");
const { windowBoundsForPersistence, windowBoundsForRestore } = require("./windowBounds");

const current = { x: 10, y: 20, width: 1000, height: 700 };
const saved = { x: 100, y: 200, width: 1400, height: 900 };

describe("per-view window bounds", () => {
  test.each([
    [false, false, {}, current],
    [true, false, { width: 1000, height: 700 }, { x: -190, y: -80, width: 1400, height: 900 }],
    [false, true, { x: 10, y: 20 }, { ...current, x: 100, y: 200 }],
    [true, true, current, saved],
  ])("size=%s position=%s persist and restore independently", (rememberSize, rememberPosition, persisted, restored) => {
    expect(windowBoundsForPersistence(current, rememberSize, rememberPosition)).toEqual(persisted);
    expect(windowBoundsForRestore(current, saved, rememberSize, rememberPosition)).toEqual(restored);
  });

  test("size-only restore shrinks around the current center", () => {
    expect(windowBoundsForRestore(current, { width: 600, height: 300 }, true, false)).toEqual({ x: 210, y: 220, width: 600, height: 300 });
  });

  test("odd deltas round to integer coordinates", () => {
    expect(windowBoundsForRestore(current, { width: 1001, height: 705 }, true, false)).toEqual({ x: 10, y: 18, width: 1001, height: 705 });
  });

  test("ignores invalid saved coordinates and dimensions", () => {
    expect(windowBoundsForRestore(current, { x: "left", y: null, width: -Infinity, height: NaN }, true, true)).toEqual(current);
  });
});
