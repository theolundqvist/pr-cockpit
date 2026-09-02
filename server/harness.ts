import { existsSync } from "node:fs";
import { getSetting } from "./db.ts";

// which headless coding CLI the agents drive; each emits a JSON event stream on stdout
export type Harness = "claude" | "omp" | "codex";

export function claudeBinPath(): string | null {
  return Bun.which("claude") ?? [`${process.env.HOME}/.local/bin/claude`, `${process.env.HOME}/.claude/local/claude`].find(existsSync) ?? null;
}

export function ompBinPath(): string | null {
  return Bun.which("omp") ?? [`${process.env.HOME}/.bun/bin/omp`, `${process.env.HOME}/.local/bin/omp`].find(existsSync) ?? null;
}

export function codexBinPath(): string | null {
  return Bun.which("codex") ?? [`${process.env.HOME}/.local/bin/codex`, `${process.env.HOME}/.bun/bin/codex`].find(existsSync) ?? null;
}

// preserve the existing default, but use Codex when it is the only installed harness
export function detectHarness(): Harness {
  if (ompBinPath()) return "omp";
  if (claudeBinPath()) return "claude";
  return codexBinPath() ? "codex" : "claude";
}

export function normalizeHarness(value: unknown): Harness {
  return value === "omp" || value === "codex" ? value : "claude";
}

export function agentHarness(): Harness {
  return normalizeHarness(getSetting("agent_harness"));
}

export function harnessBin(harness: Harness = agentHarness()): string {
  const found = harness === "omp" ? ompBinPath() : harness === "codex" ? codexBinPath() : claudeBinPath();
  if (!found) throw new Error(`${harness} binary not found - install it or switch the agent harness in Settings`);
  return found;
}

function ompModel(model: string): string {
  if (model === "opus") return "anthropic/claude-opus-5";
  if (model === "sonnet") return "anthropic/claude-sonnet-5";
  return model;
}

export function harnessFlags(prompt: string, model: string, useContinue: boolean, harness: Harness): string[] {
  if (harness === "codex") {
    const args = useContinue ? ["exec", "resume", "--last"] : ["exec"];
    args.push(
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `model_reasoning_effort="${model === "sonnet" ? "medium" : "high"}"`,
      prompt,
    );
    return args;
  }
  if (harness === "omp") {
    const args = ["--print", "--mode", "json", "--model", ompModel(model), "--auto-approve", "--no-title"];
    if (useContinue) args.push("--continue");
    args.push(prompt);
    return args;
  }
  const args = ["-p", prompt, "--model", model, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
  if (useContinue) args.push("--continue");
  return args;
}

export function harnessArgs(prompt: string, model: string, useContinue = false, harness: Harness = agentHarness()): string[] {
  return [harnessBin(harness), ...harnessFlags(prompt, model, useContinue, harness)];
}
