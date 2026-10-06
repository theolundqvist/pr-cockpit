/**
 * @param {string} path
 * @param {RegExp} testPattern
 * @param {ReadonlySet<string>} generatedPaths
 * @returns {boolean}
 */
export function excludedPath(path, testPattern, generatedPaths) {
  return testPattern.test(path) || path.includes(".generated.") || generatedPaths.has(path);
}
