const desktopShortcuts = require("../shared/desktopShortcuts.json");

const PLATFORM_POLICIES = Object.freeze({
  darwin: Object.freeze({
    desktopName: null,
    mainWindow: Object.freeze({ titleBarStyle: "hiddenInset" }),
    paletteWindow: Object.freeze({ type: "panel" }),
    trayIcon: "tray-iconTemplate.png",
    shortcuts: desktopShortcuts.darwin,
    menu: Object.freeze({
      hideRole: true,
      hideLabel: "Hide from Dock",
      hideAccelerator: "Command+Q",
      showLabel: "Show Cockpit",
      updateLabel: "Update & Restart",
      stopServerLabel: "Kill Server & Quit",
      canStopServer: true,
      canUpdate: true,
    }),
  }),
  linux: Object.freeze({
    desktopName: "app.pr-cockpit.desktop",
    mainWindow: Object.freeze({ titleBarStyle: "hidden", titleBarOverlay: true }),
    paletteWindow: Object.freeze({}),
    trayIcon: "icon.png",
    shortcuts: desktopShortcuts.linux,
    menu: Object.freeze({
      hideRole: false,
      hideLabel: "Hide PR Cockpit",
      hideAccelerator: null,
      showLabel: "Show PR Cockpit",
      updateLabel: "Update and Restart",
      stopServerLabel: null,
      canStopServer: false,
      canUpdate: true,
    }),
  }),
});

function platformPolicy(platform = process.platform) {
  return PLATFORM_POLICIES[platform] || PLATFORM_POLICIES.darwin;
}

function configuredShortcuts(platform, settings) {
  const policy = platformPolicy(platform);
  const configuredApp = settings?.keybind_open_app;
  const configuredPalette = settings?.keybind_open_palette;
  return {
    openApp: typeof configuredApp === "string" && configuredApp.length > 0 ? configuredApp : policy.shortcuts.openApp,
    openPalette:
      typeof configuredPalette === "string" && configuredPalette.length > 0
        ? configuredPalette
        : policy.shortcuts.openPalette,
  };
}

module.exports = { PLATFORM_POLICIES, configuredShortcuts, platformPolicy };
