import { describe, expect, test } from "bun:test";
import { parseQuickActions } from "./quickActions.js";

describe("parseQuickActions", () => {
  test("reads comment and label actions, keeping only free shortcut keys", () => {
    const config = JSON.stringify({
      quickActions: [
        { label: " Preview ", comment: " @preview ", key: "P" },
        { label: "Order", addLabel: "order", key: "O" },
        { label: "Both", comment: "@x", addLabel: "x" },
        { label: "Neither", key: "N" },
        { comment: "@review", key: "P" },
        { label: "Merge", comment: "@merge", key: "m" },
        { label: "Fix", comment: "@fix", key: "f" },
      ],
    });
    expect(parseQuickActions(config, new Set(["f"]))).toEqual([
      { id: "0", label: "Preview", kind: "comment", value: "@preview", keybind: "P" },
      { id: "1", label: "Order", kind: "label", value: "order", keybind: "O" },
      { id: "4", label: "@review", kind: "comment", value: "@review", keybind: null },
      { id: "5", label: "Merge", kind: "comment", value: "@merge", keybind: null },
      { id: "6", label: "Fix", kind: "comment", value: "@fix", keybind: null },
    ]);
  });

  test("a file without quickActions yields none; broken JSON throws", () => {
    expect(parseQuickActions("{}")).toEqual([]);
    expect(() => parseQuickActions("{")).toThrow();
  });
});
