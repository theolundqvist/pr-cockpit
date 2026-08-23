const CSS_TOKENS = {
  accent: "--native-accent",
  blue: "--native-blue",
  gray: "--native-gray",
  green: "--native-green",
  orange: "--native-orange",
  purple: "--native-purple",
  red: "--native-red",
  yellow: "--native-yellow",
  onAccent: "--native-on-accent",
  focus: "--native-focus",
};

function isCssHex(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
}

export function applyNativePalette(palette, root = document.documentElement) {
  if (!palette || !root) return;
  for (const [key, token] of Object.entries(CSS_TOKENS)) {
    if (isCssHex(palette[key])) root.style.setProperty(token, palette[key]);
  }
}

export function initNativePalette() {
  const shell = window.cockpitShell;
  if (!shell?.getNativePalette) return;

  const refresh = () => shell.getNativePalette().then((palette) => applyNativePalette(palette)).catch(() => {});
  refresh();
  shell.onNativePaletteChanged?.((palette) => applyNativePalette(palette));
}
