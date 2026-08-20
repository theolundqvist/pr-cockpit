const forbiddenMarkers = ["__palette_perf__"];
const sourcePatterns = ["server/**/*.ts", "ui/src/**/*.js", "ui/src/**/*.svelte"];
const sourcePaths = ["shell/main.js", "shell/windowBounds.js"];
const violations: string[] = [];

for (const pattern of sourcePatterns) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: ".", onlyFiles: true })) sourcePaths.push(path);
}
for (const path of sourcePaths) {
  const source = await Bun.file(path).text();
  for (const marker of forbiddenMarkers) {
    if (source.includes(marker)) violations.push(`${path}: remove temporary diagnostic marker ${marker}`);
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("release sources contain no temporary diagnostics");
