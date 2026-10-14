import { describe, expect, test } from "bun:test";
import { resolveQuickActions } from "./quickActions.js";

const file = (quickActions) => JSON.stringify({ quickActions });

describe("resolveQuickActions", () => {
  test("reads comment and label actions, keeping only free shortcut keys", () => {
    const committed = file([
      { label: " Preview ", comment: " @preview ", key: "P" },
      { label: "Order", addLabel: "order", key: "O" },
      { label: "Both", comment: "@x", addLabel: "x" },
      { label: "Neither", key: "N" },
      { comment: "@review", key: "P" },
      { label: "Merge", comment: "@merge", key: "m" },
      { label: "Fix", comment: "@fix", key: "f" },
    ]);
    expect(resolveQuickActions({ committed, personal: "", repo: "o/r", takenKeys: new Set(["f"]) }).actions).toEqual([
      { id: "0", label: "Preview", kind: "comment", value: "@preview", keybind: "P" },
      { id: "1", label: "Order", kind: "label", value: "order", keybind: "O" },
      { id: "4", label: "@review", kind: "comment", value: "@review", keybind: null },
      { id: "5", label: "Merge", kind: "comment", value: "@merge", keybind: null },
      { id: "6", label: "Fix", kind: "comment", value: "@fix", keybind: null },
    ]);
  });

  test("personal entries change, hide, or add actions, optionally only in listed repos", () => {
    const committed = file([
      { label: "Preview", comment: "@preview", key: "P" },
      { label: "Order", addLabel: "order", key: "O" },
      { label: "Review", comment: "@review", key: "R" },
    ]);
    const personal = file([
      { label: "preview", key: "V" },
      { label: "Order", hidden: true },
      { label: "Review", addLabel: "needs-review" },
      { label: "Ship", comment: "@ship", key: "S", repos: ["o/r"] },
      { label: "Elsewhere", comment: "@x", repos: ["o/other"] },
    ]);
    expect(resolveQuickActions({ committed, personal, repo: "o/r" }).actions).toEqual([
      { id: "0", label: "preview", kind: "comment", value: "@preview", keybind: "V" },
      { id: "1", label: "Review", kind: "label", value: "needs-review", keybind: "R" },
      { id: "2", label: "Ship", kind: "comment", value: "@ship", keybind: "S" },
    ]);
  });

  test("a broken source is reported while the other still applies", () => {
    expect(resolveQuickActions({ committed: "{", personal: file([{ label: "Mine", comment: "@me" }]), repo: "o/r" })).toEqual({
      actions: [{ id: "0", label: "Mine", kind: "comment", value: "@me", keybind: null }],
      errors: ["committed"],
    });
  });
});
