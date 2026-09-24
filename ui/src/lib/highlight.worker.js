import { ensureTheme, getHighlighter } from "./highlight.js";

const colourOnly = (tokens) => tokens.map(({ content, color }) => ({ content, color }));

self.onmessage = async ({ data }) => {
  const { id, lang, theme, lines, code } = data;
  try {
    const highlighter = await getHighlighter();
    await ensureTheme(highlighter, theme);
    if (!highlighter.getLoadedLanguages().includes(lang)) {
      self.postMessage({ id, tokens: null });
      return;
    }
    const tokens = code !== undefined
      ? highlighter.codeToTokensBase(code, { lang, theme }).map(colourOnly)
      : lines.map((line) => colourOnly(highlighter.codeToTokensBase(line, { lang, theme })[0] ?? []));
    self.postMessage({ id, tokens });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
