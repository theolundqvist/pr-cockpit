import { describe, expect, test } from "bun:test";
import { harnessFlags, normalizeHarness } from "./harness.ts";

describe("normalizeHarness", () => {
  test("only omp opts out of the claude default", () => {
    expect(normalizeHarness("omp")).toBe("omp");
    expect(normalizeHarness("claude")).toBe("claude");
    expect(normalizeHarness("codex")).toBe("claude");
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

  test("resuming keeps --continue ahead of omp's positional prompt", () => {
    expect(harnessFlags("next", "sonnet", true, "omp").slice(-2)).toEqual(["--continue", "next"]);
    expect(harnessFlags("next", "sonnet", true, "claude").at(-1)).toBe("--continue");
  });
});
