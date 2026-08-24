import { fetchSettings } from "./api.js";

const SHIKI_THEMES = {
  github: {
    light: "github-light-default",
    dark: "github-dark-default",
  },
  catppuccin: {
    light: "catppuccin-latte",
    dark: "catppuccin-mocha",
  },
};

function systemTheme() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function normalizePreference(value) {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function normalizeCodeTheme(value) {
  return value === "catppuccin" ? "catppuccin" : "github";
}

function normalizeFont(value) {
  return value === "alacritty" ? "alacritty" : "default";
}

function normalizeScale(value) {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) return 100;
  const scale = Number(value);
  return Number.isFinite(scale) ? Math.min(200, Math.max(75, Math.round(scale))) : 100;
}

const initialTheme = systemTheme();

export const theme = $state({
  preference: "system",
  name: initialTheme,
  codeTheme: "github",
  shiki: SHIKI_THEMES.github[initialTheme],
  generalScale: 100,
  diffScale: 100,
});

function applyTheme(preference) {
  const next = preference === "system" ? systemTheme() : preference;
  theme.preference = preference;
  theme.name = next;
  theme.shiki = SHIKI_THEMES[theme.codeTheme][next];
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "light" ? "#ffffff" : "#171716");
  }
}

export function setTheme(value) {
  applyTheme(normalizePreference(value));
}

export function setCodeTheme(value) {
  theme.codeTheme = normalizeCodeTheme(value);
  theme.shiki = SHIKI_THEMES[theme.codeTheme][theme.name];
}

export function setFonts(interfaceFont, ui, code, comments) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-font-interface", normalizeFont(interfaceFont));
  root.setAttribute("data-font-ui", normalizeFont(ui));
  root.setAttribute("data-font-code", normalizeFont(code));
  root.setAttribute("data-font-comments", normalizeFont(comments));
}

export function setScales(generalValue, diffValue) {
  const generalScale = normalizeScale(generalValue);
  const diffScale = normalizeScale(diffValue);
  theme.generalScale = generalScale;
  theme.diffScale = diffScale;
  if (typeof document !== "undefined") {
    const generalFactor = generalScale / 100;
    const diffRelativeScale = diffScale / generalScale;
    const root = document.documentElement;
    root.style.setProperty("--general-scale", String(generalFactor));
    root.style.setProperty("--general-width", `${100 / generalFactor}vw`);
    root.style.setProperty("--viewport-height", `${100 / generalFactor}vh`);
    root.style.setProperty("--diff-font-size", `${12.5 * diffRelativeScale}px`);
  }
}

let observingSystemTheme = false;

export function initTheme() {
  setTheme("system");
  setCodeTheme("github");
  setFonts("default", "default", "default", "default");
  setScales(100, 100);
  if (!observingSystemTheme && typeof window !== "undefined") {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    query?.addEventListener?.("change", () => {
      if (theme.preference === "system") applyTheme("system");
    });
    observingSystemTheme = true;
  }
  fetchSettings()
    .then((settings) => {
      setCodeTheme(settings.code_theme);
      setFonts(settings.font_interface, settings.font_ui, settings.font_code, settings.font_comments);
      setScales(settings.general_scale, settings.diff_scale);
      setTheme(settings.theme);
    })
    .catch(() => {});
}
