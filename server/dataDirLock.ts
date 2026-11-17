import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });
// The open exclusive transaction is the lock: the OS releases it when this process dies, however it exits.
// Exported because an unreferenced module-local connection is garbage-collected and closed, dropping the lock.
export const dataDirLock = new Database(join(dataDir, "server.lock"));
try {
  dataDirLock.exec("BEGIN EXCLUSIVE");
} catch (error) {
  if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
  console.error(`pr-cockpit: another server is using ${dataDir}; give this one its own COCKPIT_DATA_DIR`);
  process.exit(1);
}
