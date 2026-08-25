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
    expect(parsed.steps[0].lines.map((line) => line.text)).toEqual(["line one", "", "line three"]);
  });
});
