import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS, normalizeSettingsSection, settingsSectionHref } from "./settingsSections.js";

describe("settings sections", () => {
  test("keeps the sidebar destinations stable and ordered", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(["general", "appearance", "keybinds", "automerge", "tests", "usage", "advanced", "analytics"]);
  });

  test("normalizes stale sections to General", () => {
    expect(normalizeSettingsSection("tests")).toBe("tests");
    expect(normalizeSettingsSection("appearance")).toBe("appearance");
    expect(normalizeSettingsSection("usage")).toBe("usage");
    expect(normalizeSettingsSection("advanced")).toBe("advanced");
    expect(normalizeSettingsSection("analytics")).toBe("analytics");
    expect(normalizeSettingsSection("missing")).toBe("general");
    expect(normalizeSettingsSection(null)).toBe("general");
  });

  test("builds canonical section routes", () => {
    expect(settingsSectionHref("keybinds")).toBe("#/settings/keybinds");
    expect(settingsSectionHref("analytics")).toBe("#/settings/analytics");
    expect(settingsSectionHref("missing")).toBe("#/settings/general");
  });
});
