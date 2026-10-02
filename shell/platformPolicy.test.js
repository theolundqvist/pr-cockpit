const { describe, expect, test } = require("bun:test");
const { configuredShortcuts } = require("./platformPolicy");

describe("desktop platform policy", () => {
  test.each([
    undefined,
    null,
    {},
    { keybind_open_app: null, keybind_open_palette: undefined },
    { keybind_open_app: "", keybind_open_palette: "" },
  ])("uses Linux defaults for null, missing, or empty settings", (settings) => {
    expect(configuredShortcuts("linux", settings)).toEqual({
      openApp: "Super+Control+G",
      openPalette: "Super+Alt+K",
    });
  });

  test("passes every nonempty configured chord through byte-for-byte", () => {
    expect(
      configuredShortcuts("linux", {
        keybind_open_app: "Command+Control+G",
        keybind_open_palette: "Command+Option+K",
      }),
    ).toEqual({ openApp: "Command+Control+G", openPalette: "Command+Option+K" });
    expect(
      configuredShortcuts("linux", {
        keybind_open_app: " Control+Shift+G ",
        keybind_open_palette: "\tAlt+Space",
      }),
    ).toEqual({ openApp: " Control+Shift+G ", openPalette: "\tAlt+Space" });
  });
});
