import desktopShortcuts from "../../../shared/desktopShortcuts.json";

const SPECIAL_KEYS = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  " ": "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
};

export function desktopShortcutDefaults(platform) {
  return platform === "linux" ? desktopShortcuts.linux : desktopShortcuts.darwin;
}

export function capturedShortcut(event, platform) {
  const combo = [];
  if (event.metaKey) combo.push(platform === "linux" ? "Super" : "Command");
  if (event.ctrlKey) combo.push("Control");
  if (event.altKey) combo.push(platform === "linux" ? "Alt" : "Option");
  if (event.shiftKey) combo.push("Shift");
  combo.push(event.key.length === 1 ? event.key.toUpperCase() : SPECIAL_KEYS[event.key] ?? event.key);
  return combo.join("+");
}

export function shortcutsClash(openApp, openPalette, defaults) {
  return (openApp || defaults.openApp) === (openPalette || defaults.openPalette);
}
