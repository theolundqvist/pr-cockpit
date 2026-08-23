const SYSTEM_COLORS = ["blue", "gray", "green", "orange", "purple", "red", "yellow"];

function cssHex(value) {
  const hex = typeof value === "string" ? value.trim() : "";
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) return hex;
  if (/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(hex)) return `#${hex}`;
  return null;
}

function readColor(read) {
  try {
    return cssHex(read());
  } catch {
    return null;
  }
}

function getNativePalette(systemPreferences, platform = process.platform) {
  if (platform !== "darwin" || !systemPreferences) return null;

  const palette = Object.fromEntries(
    SYSTEM_COLORS.map((name) => [name, readColor(() => systemPreferences.getSystemColor(name))]),
  );
  palette.accent = readColor(() => systemPreferences.getAccentColor());
  palette.onAccent = readColor(() => systemPreferences.getColor("selected-menu-item-text"));
  palette.focus = readColor(() => systemPreferences.getColor("keyboard-focus-indicator"));

  return Object.values(palette).some(Boolean) ? palette : null;
}

module.exports = { cssHex, getNativePalette };
