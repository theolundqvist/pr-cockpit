import { describe, expect, test } from "bun:test";
import { moveRangeCursor } from "./rangePicker.js";

describe("moveRangeCursor", () => {
  test("starts and extends a commit range with shift-arrow", () => {
    const first = moveRangeCursor(4, 1, 2, 10, null, true);
    expect(first).toEqual({ activeIdx: 5, dragStart: 2, dragEnd: 3 });

    expect(moveRangeCursor(first.activeIdx, 1, 2, 10, first.dragStart, true)).toEqual({
      activeIdx: 6,
      dragStart: 2,
      dragEnd: 4,
    });
  });

  test("extends a commit range upward", () => {
    expect(moveRangeCursor(5, -1, 2, 10, null, true)).toEqual({
      activeIdx: 4,
      dragStart: 3,
      dragEnd: 2,
    });
  });

  test("keeps an active range inside commit rows", () => {
    expect(moveRangeCursor(2, -1, 2, 10, 0, true)).toEqual({
      activeIdx: 2,
      dragStart: 0,
      dragEnd: 0,
    });
  });
});
