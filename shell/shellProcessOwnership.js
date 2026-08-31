const path = require("node:path");

function shellProcessRecord({ pid, start, executable, release }, trayReady = false) {
  return `pid=${pid}\nstart=${start}\nexecutable=${executable}\nrelease=${release}\n${trayReady ? "tray=ready\n" : ""}`;
}

function readOptional(fs, file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function recordedProcessIsActive(fs, record) {
  const values = new Map();
  for (const line of record.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0 || values.has(line.slice(0, separator))) throw new Error("Linux GUI ownership record is invalid");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const keys = [...values.keys()].sort().join(",");
  if (keys !== "executable,pid,release,start" && keys !== "executable,pid,release,start,tray") throw new Error("Linux GUI ownership record is invalid");
  if (values.has("tray") && values.get("tray") !== "ready") throw new Error("Linux GUI ownership record is invalid");
  const pid = values.get("pid");
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Linux GUI ownership record is invalid");
  if (values.get("executable") !== path.join(values.get("release"), "shell", "node_modules", "electron", "dist", "electron")) throw new Error("Linux GUI ownership record is invalid");
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    return fields[19] === values.get("start") && fs.realpathSync(`/proc/${pid}/exe`) === values.get("executable");
  } catch {
    return false;
  }
}

function createShellProcessOwnership(fs, dataDir, identity) {
  const processFile = path.join(dataDir, "shell-process");
  let ownedRecord = shellProcessRecord(identity);

  function writeRecord(record, expected) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryDirectory = fs.mkdtempSync(path.join(dataDir, ".shell-process-"));
    fs.chmodSync(temporaryDirectory, 0o700);
    const temporary = path.join(temporaryDirectory, "record");
    try {
      fs.writeFileSync(temporary, record, { mode: 0o600, flag: "wx" });
      const current = readOptional(fs, processFile);
      if (current !== expected) throw new Error("Linux GUI ownership changed during publication");
      if (expected === null) fs.linkSync(temporary, processFile);
      else fs.renameSync(temporary, processFile);
      ownedRecord = record;
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const existing = readOptional(fs, processFile);
  if (existing !== null && recordedProcessIsActive(fs, existing)) throw new Error("another managed Linux GUI owns the process record");
  writeRecord(ownedRecord, existing);

  return {
    markTrayReady() {
      const record = shellProcessRecord(identity, true);
      writeRecord(record, ownedRecord);
    },
    removeOwned() {
      try {
        if (fs.readFileSync(processFile, "utf8") === ownedRecord) fs.unlinkSync(processFile);
      } catch {
        // Missing or owned by a different authoritative instance.
      }
    },
  };
}

module.exports = { createShellProcessOwnership, shellProcessRecord };
