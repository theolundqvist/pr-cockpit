import { describe, expect, test } from "bun:test";
import { normalizeSettingsSection, settingsSectionHref } from "./settingsSections.js";

describe("settings sections", () => {
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
