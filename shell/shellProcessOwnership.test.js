const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createShellProcessOwnership } = require("./shellProcessOwnership");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-shell-process-"));
  roots.push(dataDir);
  const identity = {
    pid: 42,
    start: "123456",
    executable: "/runtime/shell/node_modules/electron/dist/electron",
    release: "/runtime",
  };
  return { dataDir, identity, processFile: path.join(dataDir, "shell-process") };
}

describe("managed Linux shell ownership", () => {
  test("keeps the pre-tray stop record and atomically marks a constructed tray ready", () => {
    const { dataDir, identity, processFile } = fixture();
    const ownership = createShellProcessOwnership(fs, dataDir, identity);
    expect(fs.readFileSync(processFile, "utf8")).toBe(
      "pid=42\nstart=123456\nexecutable=/runtime/shell/node_modules/electron/dist/electron\nrelease=/runtime\n",
    );

    ownership.markTrayReady();
    expect(fs.readFileSync(processFile, "utf8")).toBe(
      "pid=42\nstart=123456\nexecutable=/runtime/shell/node_modules/electron/dist/electron\nrelease=/runtime\ntray=ready\n",
    );
    expect(fs.readdirSync(dataDir)).toEqual(["shell-process"]);

    ownership.removeOwned();
    expect(fs.existsSync(processFile)).toBe(false);
  });

  test("will-quit cleanup preserves a record replaced by another owner", () => {
    const { dataDir, identity, processFile } = fixture();
    const ownership = createShellProcessOwnership(fs, dataDir, identity);
    ownership.markTrayReady();
    fs.writeFileSync(processFile, "pid=99\n");

    ownership.removeOwned();
    expect(fs.readFileSync(processFile, "utf8")).toBe("pid=99\n");
  });

  test("refuses malformed foreign ownership without replacing it", () => {
    const { dataDir, identity, processFile } = fixture();
    fs.writeFileSync(processFile, "pid=99\n");

    expect(() => createShellProcessOwnership(fs, dataDir, identity)).toThrow("ownership record is invalid");
    expect(fs.readFileSync(processFile, "utf8")).toBe("pid=99\n");
  });

  test("replaces a structurally valid stale process record", () => {
    const { dataDir, identity, processFile } = fixture();
    fs.writeFileSync(
      processFile,
      "pid=999999999\nstart=123\nexecutable=/old/shell/node_modules/electron/dist/electron\nrelease=/old\n",
    );

    createShellProcessOwnership(fs, dataDir, identity);
    expect(fs.readFileSync(processFile, "utf8")).toContain("pid=42\n");
    expect(fs.readdirSync(dataDir)).toEqual(["shell-process"]);
  });
});
