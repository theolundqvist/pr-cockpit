// CodeMirror edits with "\n" only, so a file is editable when its line endings are uniform; null when mixed.
export function normalizeFileEndings(content) {
  if (!content.includes("\r")) return { content, eol: "\n" };
  if (/\r(?!\n)/.test(content) || content.replace(/\r\n/g, "").includes("\n")) return null;
  return { content: content.replace(/\r\n/g, "\n"), eol: "\r\n" };
}
