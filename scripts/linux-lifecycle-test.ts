#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessages, runLifecycle } from "./linux-lifecycle";

const [actorScript, ...args] = process.argv.slice(2);
if (!actorScript) throw new Error("test lifecycle actor is required");

try {
  runLifecycle(args, {
    platform: "linux",
    actorRoot: realpathSync(join(dirname(actorScript), "..")),
  });
} catch (error) {
  for (const message of errorMessages(error)) console.error(`pr-cockpit: ${message}`);
  process.exit(1);
}
