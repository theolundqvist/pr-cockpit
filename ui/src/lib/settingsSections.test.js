import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS, normalizeSettingsSection, settingsSectionHref } from "./settingsSections.js";

describe("settings sections", () => {
  test("keeps the sidebar destinations stable and ordered", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(["general", "keybinds", "automerge", "tests"]);
  });

  test("normalizes stale sections to General", () => {
    expect(normalizeSettingsSection("tests")).toBe("tests");
    expect(normalizeSettingsSection("missing")).toBe("general");
    expect(normalizeSettingsSection(null)).toBe("general");
  });

  test("builds canonical section routes", () => {
    expect(settingsSectionHref("keybinds")).toBe("#/settings/keybinds");
    expect(settingsSectionHref("missing")).toBe("#/settings/general");
  });
});
