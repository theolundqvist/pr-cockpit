import { expect, test } from "bun:test";
import { historyBackAction } from "./historyAction.js";

test("Back preserves a forward entry and uses the inbox only as a true fallback", () => {
  expect(historyBackAction(true, "#/")).toBe("back");
  expect(historyBackAction(false, "#/")).toBe("fallback");
  expect(historyBackAction(false, null)).toBe("none");
});
