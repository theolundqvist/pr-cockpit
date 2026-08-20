export const BUILTIN_TEST_PATH = /\.test\.[jt]sx?$|\.spec\.[jt]sx?$|\/__tests__\//;

export function testMatcher(customSource) {
  const raw = (customSource ?? "").trim();
  if (!raw) return BUILTIN_TEST_PATH;
  try {
    return new RegExp(raw);
  } catch {
    return BUILTIN_TEST_PATH;
  }
}
