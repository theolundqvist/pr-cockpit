const { expect, test } = require("bun:test");
const fs = require("fs");
const vm = require("vm");

function bridge(argv) {
  let exposed;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve("./preload.js"), "utf8"), {
    process: { argv, platform: "darwin" },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } },
    }),
  });
  return { exposed, calls };
}

test("updated preload does not invoke APIs absent from an older running shell", () => {
  const { exposed, calls } = bridge([]);
  expect(exposed.getNativePalette).toBeUndefined();
  expect(exposed.prepareEditor).toBeUndefined();
  expect(calls).toEqual([]);
});

test("current shell advertises optional IPC handlers to its preload", async () => {
  const { exposed, calls } = bridge(["--cockpit-native-palette", "--cockpit-prepare-editor"]);
  await exposed.getNativePalette();
  await exposed.prepareEditor("owner/repo", 1, "abc");
  expect(calls).toEqual([
    ["cockpit:native-palette"],
    ["cockpit:prepare-editor", { repo: "owner/repo", number: 1, headSha: "abc" }],
  ]);
});
