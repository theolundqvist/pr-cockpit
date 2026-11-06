const { spawnSync } = require("node:child_process");
const { mkdirSync, renameSync } = require("node:fs");
const path = require("node:path");

if (process.platform === "darwin") {
  const output = path.join(__dirname, "native", "build");
  mkdirSync(output, { recursive: true });
  const temporary = path.join(output, `selected-text-${process.pid}.node`);
  const include = path.join(path.dirname(require.resolve("node-api-headers/package.json")), "include");
  const result = spawnSync("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-shared", "-undefined", "dynamic_lookup",
    "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "Carbon", "-DNAPI_VERSION=8",
    "-I", include, path.join(__dirname, "native", "selectedText.mm"), "-o", temporary], { encoding: "utf8" });
  if (result.status === 0) {
    renameSync(temporary, path.join(output, "selected-text.node"));
  } else {
    console.warn("pr-cockpit: native selected-text capture unavailable; Quick Generate still supports manual entry.");
  }
}
