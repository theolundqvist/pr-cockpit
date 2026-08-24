const { describe, expect, test } = require("bun:test");
const { cssHex, getNativePalette } = require("./nativePalette");

describe("native macOS palette", () => {
  test("normalizes Electron RGBA values for CSS", () => {
    expect(cssHex("007affff")).toBe("#007affff");
    expect(cssHex("#32d74b")).toBe("#32d74b");
    expect(cssHex("not-a-color")).toBeNull();
  });

  test("reads adaptive system and control colors", () => {
    const systemPreferences = {
      getSystemColor: (name) => ({ blue: "#0a84ffff", green: "32d74bff" })[name] ?? "#8e8e93ff",
      getAccentColor: () => "bf5af2ff",
      getColor: (name) => (name === "selected-menu-item-text" ? "#ffffffff" : "#0a84ffff"),
    };

    expect(getNativePalette(systemPreferences, "darwin")).toMatchObject({
      accent: "#bf5af2ff",
      blue: "#0a84ffff",
      green: "#32d74bff",
      onAccent: "#ffffffff",
      focus: "#0a84ffff",
    });
  });

  test("does not invent native colors outside macOS", () => {
    expect(getNativePalette({}, "linux")).toBeNull();
  });
});
