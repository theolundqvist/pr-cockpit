import { describe, expect, test } from "bun:test";
import { harnessFlags, normalizeHarness } from "./harness.ts";

describe("normalizeHarness", () => {
  test("accepts the supported harnesses and preserves the claude default", () => {
    expect(normalizeHarness("omp")).toBe("omp");
    expect(normalizeHarness("claude")).toBe("claude");
    expect(normalizeHarness("codex")).toBe("codex");
    expect(normalizeHarness(null)).toBe("claude");
  });
});

describe("harnessFlags", () => {
  test("claude takes the prompt as -p and asks for the stream-json event log", () => {
    expect(harnessFlags("fix it", "opus", false, "claude")).toEqual([
      "-p",
      "fix it",
      "--model",
      "opus",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  test("omp takes the prompt as a trailing message and asks for the json event log", () => {
    expect(harnessFlags("fix it", "opus", false, "omp")).toEqual([
      "--print",
      "--mode",
      "json",
      "--model",
      "anthropic/claude-opus-5",
      "--auto-approve",
      "--no-title",
      "fix it",
    ]);
  });

  test("omp expands logical agent models to current exact Anthropic IDs", () => {
    expect(harnessFlags("next", "sonnet", false, "omp")).toContain("anthropic/claude-sonnet-5");
  });

  test("codex uses JSONL, configured effort, and cwd-scoped resume", () => {
    expect(harnessFlags("fix it", "opus", false, "codex")).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="high"',
      "fix it",
    ]);
    expect(harnessFlags("next", "sonnet", true, "codex")).toEqual([
      "exec",
      "resume",
      "--last",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="medium"',
      "next",
    ]);
  });

  test("resuming keeps --continue ahead of omp's positional prompt", () => {
    expect(harnessFlags("next", "sonnet", true, "omp").slice(-2)).toEqual(["--continue", "next"]);
    expect(harnessFlags("next", "sonnet", true, "claude").at(-1)).toBe("--continue");
  });
});
