import { describe, expect, test } from "bun:test";
import { parseActionLog } from "./actionLog.js";

describe("parseActionLog", () => {
  test("turns runner actions and groups into concluded steps", () => {
    const log = [
      "Current runner version: '2.328.0'",
      "",
      "##[group]Run actions/checkout@v5",
      "##[command]/usr/bin/git fetch --depth=1",
      "Checked out the repository",
      "##[endgroup]",
      "##[start-action display=Install dependencies;id=install]",
      "##[group]Run pnpm install",
      "Packages: +1420",
      "##[endgroup]",
      "##[end-action id=install;outcome=success;conclusion=success;duration_ms=1250]",
      "##[group]Run pnpm format:check",
      "Formatting files...",
      "##[error]Process completed with exit code 1.",
      "##[endgroup]",
      "Post job cleanup.",
      "##[start-action display=Run actions/checkout@v5;id=cleanup]",
      "Cleaning up",
      "##[end-action id=cleanup;outcome=success;conclusion=success;duration_ms=80]",
    ].join("\n");

    const parsed = parseActionLog(log, "failure");

    expect(parsed.steps.map(({ title, conclusion }) => ({ title, conclusion }))).toEqual([
      { title: "Set up job", conclusion: "success" },
      { title: "Run actions/checkout@v5", conclusion: "success" },
      { title: "Install dependencies", conclusion: "success" },
      { title: "Run pnpm format:check", conclusion: "failure" },
      { title: "Post actions/checkout@v5", conclusion: "success" },
    ]);
    expect(parsed.steps[1].lines[0]).toEqual({
      line: 4,
      text: "/usr/bin/git fetch --depth=1",
      tone: "command",
    });
    expect(parsed.steps[2].durationMs).toBe(1250);
    expect(parsed.annotations).toEqual([
      { line: 14, tone: "failure", text: "Process completed with exit code 1." },
    ]);
  });

  test("surfaces workflow annotations and marks an unannotated failed job", () => {
    const annotated = parseActionLog("::warning file=app.ts,line=4::Deprecated call%0AUse the replacement");
    expect(annotated.annotations[0].text).toBe("Deprecated call\nUse the replacement");
    expect(annotated.steps[0].conclusion).toBe("warning");

    const failed = parseActionLog("command output\nprocess stopped", "timed_out");
    expect(failed.steps[0].conclusion).toBe("failure");

    const failedAction = parseActionLog([
      "##[start-action display=Run checks;id=check]",
      "##[error]Assertion failed",
      "##[end-action id=check;outcome=success;conclusion=success;duration_ms=20]",
    ].join("\n"));
    expect(failedAction.steps[0].conclusion).toBe("failure");
  });

  test("keeps plain and truncated logs readable", () => {
    const parsed = parseActionLog("line one\n\nline three");
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0].title).toBe("Set up job");

    const command = parseActionLog("[command]/usr/bin/git version");
    expect(command.steps[0].lines[0]).toEqual({ line: 1, text: "/usr/bin/git version", tone: "command" });
    expect(parsed.steps[0].lines.map((line) => line.text)).toEqual(["line one", "", "line three"]);
  });

  test("preserves nested runner group boundaries and outcome", () => {
    const parsed = parseActionLog([
      "##[start-action display=Number, sign, archive, and upload;id=archive]",
      "##[group]Run set -euo pipefail",
      "set -euo pipefail",
      "keychain=/tmp/release.keychain-db",
      "##[error]APPLE_CERTIFICATE did not provide a valid code-signing identity",
      "##[endgroup]",
      "##[end-action id=archive;outcome=failure;conclusion=failure;duration_ms=130]",
    ].join("\n"));

    expect(parsed.steps[0].lines[0]).toEqual({
      line: 2,
      text: "Run set -euo pipefail",
      tone: "group",
      groupId: "step-1-group-1",
      conclusion: "failure",
    });
    expect(parsed.steps[0].lines.slice(1).map((line) => line.groups)).toEqual([
      ["step-1-group-1"],
      ["step-1-group-1"],
      ["step-1-group-1"],
    ]);
  });

  test("keeps runtime output visible below a collapsed shell echo", () => {
    const parsed = parseActionLog([
      "##[group]Run set -euo pipefail",
      "set -euo pipefail",
      "##[endgroup]",
      'keychain: "/tmp/release.keychain-db"',
      "##[error]APPLE_CERTIFICATE did not provide a valid code-signing identity",
    ].join("\n"), "failure", "Number, sign, archive, and upload");

    expect(parsed.steps[0].title).toBe("Number, sign, archive, and upload");
    expect(parsed.steps[0].lines[0]).toEqual({
      line: 1,
      text: "Run set -euo pipefail",
      tone: "group",
      groupId: "step-1-shell",
      conclusion: "success",
    });
    expect(parsed.steps[0].lines[1].groups).toEqual(["step-1-shell"]);
    expect(parsed.steps[0].lines[2].groups).toBeUndefined();
    expect(parsed.steps[0].lines[3].groups).toBeUndefined();
  });
});
