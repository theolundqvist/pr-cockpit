/**
 * @param {string} path
 * @param {RegExp} testPattern
 * @param {ReadonlySet<string>} generatedPaths
 * @returns {boolean}
 */
export function excludedPath(path, testPattern, generatedPaths) {
  return testPattern.test(path) || path.includes(".generated.") || generatedPaths.has(path);
}

/**
 * A changed file's path, or a folder as `dir/**`, relative to the repository root.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isReviewPathPattern(value) {
  if (typeof value !== "string") return false;
  const path = value.endsWith("/**") ? value.slice(0, -3) : value;
  return path.length > 0
    && !path.startsWith("/")
    && !/[\0\r\n]/.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
