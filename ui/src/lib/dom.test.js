import { describe, expect, test } from "bun:test";
import { prKeyOwner, shouldCopyPrCockpitUrl, shouldCopyPrUrl } from "./dom.js";

const target = { tagName: "DIV", isContentEditable: false };
const shortcut = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: "ç", code: "KeyC", target };

describe("shouldCopyPrUrl", () => {
  test("handles Command-Option-C when normal page text is not selected", () => {
    expect(shouldCopyPrUrl(shortcut)).toBe(true);
  });

  test("uses the physical key code because Option changes the typed character on macOS", () => {
    expect(shouldCopyPrUrl({ ...shortcut, key: "c", code: "KeyX" })).toBe(false);
  });

  test("preserves native Command-C", () => {
    expect(shouldCopyPrUrl({ ...shortcut, altKey: false })).toBe(false);
  });

  test("works in editable controls because it is not the native copy shortcut", () => {
    expect(shouldCopyPrUrl({ ...shortcut, target: { tagName: "TEXTAREA", isContentEditable: false } })).toBe(true);
  });

  test("does not claim modified copy shortcuts", () => {
    expect(shouldCopyPrUrl({ ...shortcut, shiftKey: true })).toBe(false);
  });
});

describe("shouldCopyPrCockpitUrl", () => {
  test("handles Command-Shift-C", () => {
    expect(shouldCopyPrCockpitUrl({ ...shortcut, altKey: false, shiftKey: true, key: "C" })).toBe(true);
  });

  test("does not claim Command-Option-C", () => {
    expect(shouldCopyPrCockpitUrl(shortcut)).toBe(false);
  });
});

describe("prKeyOwner", () => {
  const editorTarget = { tagName: "DIV", isContentEditable: true };
  const editorKey = {
    key: "Enter",
    code: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: editorTarget,
  };

  test("leaves ordinary CodeMirror keys with the editor", () => {
    expect(prKeyOwner(editorKey)).toBe("typing");
  });

  test("routes Escape to editor blur", () => {
    expect(prKeyOwner({ ...editorKey, key: "Escape", code: "Escape" })).toBe("blur");
  });

  test("preserves supported PR copy shortcuts inside the editor", () => {
    expect(prKeyOwner({ ...shortcut, target: editorTarget })).toBe("pr");
  });

  test("preserves established app navigation shortcuts inside the editor", () => {
    expect(prKeyOwner({ ...editorKey, key: ",", code: "Comma", metaKey: true })).toBe("pr");
    expect(prKeyOwner({ ...editorKey, key: "2", code: "Digit2", metaKey: true })).toBe("pr");
  });

  test("leaves modified navigation keys with the editor", () => {
    expect(prKeyOwner({ ...editorKey, key: "ArrowDown", code: "ArrowDown", metaKey: true })).toBe("typing");
  });
});
