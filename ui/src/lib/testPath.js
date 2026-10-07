export const BUILTIN_TEST_PATH = /\.test\.[jt]sx?$|\.spec\.[jt]sx?$|\/__tests__\//;

function customMatcher(customSource) {
  const raw = (customSource ?? "").trim();
  if (!raw) return BUILTIN_TEST_PATH;
  try {
    return new RegExp(raw);
  } catch {
    return BUILTIN_TEST_PATH;
  }
}

/**
 * Test files plus the repository's hidden paths: each a file path or a folder as `dir/**`, from the root.
 * @param {string | null | undefined} customSource
 * @param {readonly string[]} [hiddenPaths]
 */
export function testMatcher(customSource, hiddenPaths = []) {
  const tests = customMatcher(customSource);
  if (hiddenPaths.length === 0) return tests;
  const hidden = hiddenPaths.map((pattern) => {
    const folder = pattern.endsWith("/**");
    const literal = (folder ? pattern.slice(0, -2) : pattern).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return folder ? literal : `${literal}$`;
  });
  return new RegExp(`${tests.source}|^(?:${hidden.join("|")})`);
}
