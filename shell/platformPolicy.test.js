const { describe, expect, test } = require("bun:test");
const { configuredShortcuts, platformPolicy } = require("./platformPolicy");

describe("desktop platform policy", () => {
  test("preserves the Darwin window, tray, menu, and shortcut policy", () => {
    expect(platformPolicy("darwin")).toEqual({
      desktopName: null,
      mainWindow: { titleBarStyle: "hiddenInset" },
      paletteWindow: { type: "panel" },
      trayIcon: "tray-iconTemplate.png",
      shortcuts: { openApp: "Command+Control+G", openPalette: "Command+Option+K" },
      menu: {
        hideRole: true,
        hideLabel: "Hide from Dock",
        hideAccelerator: "Command+Q",
        showLabel: "Show Cockpit",
        updateLabel: "Update & Restart",
        stopServerLabel: "Kill Server & Quit",
        canStopServer: true,
        canUpdate: true,
      },
    });
  });

  test("declares Linux desktop identity and integrated chrome", () => {
    expect(platformPolicy("linux")).toEqual({
      desktopName: "app.pr-cockpit.desktop",
      mainWindow: { titleBarStyle: "hidden", titleBarOverlay: true },
      paletteWindow: {},
      trayIcon: "icon.png",
      shortcuts: { openApp: "Super+Control+G", openPalette: "Super+Alt+K" },
      menu: {
        hideRole: false,
        hideLabel: "Hide PR Cockpit",
        hideAccelerator: null,
        showLabel: "Show PR Cockpit",
        updateLabel: "Update and Restart",
        stopServerLabel: null,
        canStopServer: false,
        canUpdate: true,
      },
    });
  });

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
