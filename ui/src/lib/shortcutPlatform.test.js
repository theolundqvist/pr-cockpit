import { describe, expect, test } from "bun:test";
import { capturedShortcut, desktopShortcutDefaults, shortcutsClash } from "./shortcutPlatform.js";

describe("desktopShortcutDefaults", () => {
  test("uses native modifier names on Darwin and Linux", () => {
    expect(desktopShortcutDefaults("darwin")).toEqual({
      openApp: "Command+Control+G",
      openPalette: "Command+Option+K",
    });
    expect(desktopShortcutDefaults("linux")).toEqual({
      openApp: "Super+Control+G",
      openPalette: "Super+Alt+K",
    });
  });
});

describe("capturedShortcut", () => {
  const event = {
    key: "k",
    metaKey: true,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
  };

  test("captures Command and Option on Darwin", () => {
    expect(capturedShortcut(event, "darwin")).toBe("Command+Control+Option+K");
  });

  test("captures Super and Alt on Linux", () => {
    expect(capturedShortcut(event, "linux")).toBe("Super+Control+Alt+K");
  });
});

describe("shortcutsClash", () => {
  test("resolves empty sentinels before checking duplicates", () => {
    const defaults = desktopShortcutDefaults("linux");
    expect(shortcutsClash("", "Super+Control+G", defaults)).toBe(true);
    expect(shortcutsClash("", "", defaults)).toBe(false);
  });

  test("compares explicit custom values without normalizing them", () => {
    const defaults = desktopShortcutDefaults("darwin");
    expect(shortcutsClash("Custom+Chord", "Custom+Chord", defaults)).toBe(true);
    expect(shortcutsClash("Custom+Chord", "custom+chord", defaults)).toBe(false);
  });
});
