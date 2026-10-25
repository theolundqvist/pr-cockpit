import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COCKPIT_GITHUB_APP_CONFIG = join(tmpdir(), `pr-cockpit-test-${crypto.randomUUID()}`, "github-app.json");
