const { spawnSync } = require("node:child_process");
const { mkdirSync, renameSync } = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") {
  const output = path.join(__dirname, "native", "build");
  mkdirSync(output, { recursive: true });
  const temporary = path.join(output, `trackpad-${process.pid}.node`);
  const include = path.join(path.dirname(require.resolve("node-api-headers/package.json")), "include");
  const result = spawnSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-shared", "-undefined", "dynamic_lookup",
    "-framework", "AppKit", "-DNAPI_VERSION=8", ...(process.argv.includes("--test") ? ["-DTRACKPAD_TESTING"] : []),
    "-I", include, path.join(__dirname, "native", "trackpad.mm"), "-o", temporary], { encoding: "utf8" });
  if (result.status === 0) {
    renameSync(temporary, path.join(output, "trackpad.node"));
  } else {
    console.warn("pr-cockpit: native trackpad monitor unavailable; using Electron gesture events.");
    if (process.argv.includes("--test")) {
      console.error(result.stderr || result.error);
      process.exit(1);
    }
  }
}
