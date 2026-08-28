import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubAuthStatus, startGithubSetup } from "./githubAuth.ts";

const originalGhBin = process.env.COCKPIT_GH_BIN;
const originalBrowserBin = process.env.COCKPIT_BROWSER_BIN;
const originalMode = process.env.GH_TEST_MODE;
const originalState = process.env.GH_TEST_STATE;

afterAll(() => {
  if (originalGhBin === undefined) delete process.env.COCKPIT_GH_BIN;
  else process.env.COCKPIT_GH_BIN = originalGhBin;
  if (originalBrowserBin === undefined) delete process.env.COCKPIT_BROWSER_BIN;
  else process.env.COCKPIT_BROWSER_BIN = originalBrowserBin;
  if (originalMode === undefined) delete process.env.GH_TEST_MODE;
  else process.env.GH_TEST_MODE = originalMode;
  if (originalState === undefined) delete process.env.GH_TEST_STATE;
  else process.env.GH_TEST_STATE = originalState;
});

describe("guided GitHub authentication", () => {
  test("reports every prerequisite and completes scope authorization in the browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-cockpit-github-auth-"));
    const gh = join(root, "gh");
    const browser = join(root, "browser");
    const state = join(root, "authorized");
    const browserLog = join(root, "browser.log");

    try {
      process.env.COCKPIT_BROWSER_BIN = browser;
      process.env.GH_TEST_STATE = state;
      await writeFile(browser, `#!/bin/sh\nprintf '%s' "$1" > "${browserLog}"\n`);
      await chmod(browser, 0o755);

      process.env.COCKPIT_GH_BIN = join(root, "missing-gh");
      expect(await githubAuthStatus(["repo"])).toMatchObject({ state: "missing-cli", missingScopes: ["repo"] });
      await startGithubSetup(["repo"]);
      expect(await readFile(browserLog, "utf8")).toBe("https://cli.github.com/");

      await writeFile(gh, `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ "$GH_TEST_MODE" = "missing-auth" ]; then
    printf '{"hosts":{"github.com":[]}}'
  elif [ -f "$GH_TEST_STATE" ]; then
    printf '{"hosts":{"github.com":[{"active":true,"state":"success","login":"octocat","scopes":"repo, workflow"}]}}'
  else
    printf '{"hosts":{"github.com":[{"active":true,"state":"success","login":"octocat","scopes":"repo"}]}}'
  fi
elif [ "$1 $2" = "auth token" ]; then
  [ "$GH_TEST_MODE" != "missing-auth" ] || exit 1
  printf 'test-token'
elif [ "$1 $2" = "auth refresh" ]; then
  printf 'First copy your one-time code: ABCD-EFGH\\n'
  printf 'Press Enter to open https://github.com/login/device\\n'
  read ignored
  touch "$GH_TEST_STATE"
else
  exit 2
fi
`);
      await chmod(gh, 0o755);
      process.env.COCKPIT_GH_BIN = gh;
      process.env.GH_TEST_MODE = "missing-auth";
      expect(await githubAuthStatus(["repo"])).toMatchObject({ state: "missing-auth", missingScopes: ["repo"] });

      process.env.GH_TEST_MODE = "ready";
      expect(await githubAuthStatus(["repo", "workflow"])).toMatchObject({
        state: "missing-scopes",
        login: "octocat",
        missingScopes: ["workflow"],
      });

      const started = await startGithubSetup(["repo", "workflow"]);
      expect(started).toMatchObject({ state: "authorizing", missingScopes: ["workflow"] });

      let complete = await githubAuthStatus(["repo", "workflow"]);
      for (let attempt = 0; attempt < 60 && !complete.ok; attempt += 1) {
        complete = await githubAuthStatus(["repo", "workflow"]);
      }
      expect(complete).toMatchObject({ ok: true, state: "ready", login: "octocat", missingScopes: [] });
      expect(await readFile(browserLog, "utf8")).toBe("https://github.com/login/device");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
