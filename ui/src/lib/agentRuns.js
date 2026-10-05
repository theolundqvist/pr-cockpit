export function runHealth(run) {
  if (run.state === "running") return "running";
  if (run.state === "killed" || run.state === "died" || run.exit_reason === "gave-up") return "failed";
  if (run.exit_reason === "green" || run.exit_reason === "merged" || run.exit_reason === "done") return "succeeded";
  return "idle";
}

export function runStateLabel(run) {
  return run.state === "running" ? "running" : (run.exit_reason || run.state);
}

const RUN_TONES = { running: "review", failed: "fail", succeeded: "ready", idle: "wait" };

export function runTone(run) {
  return RUN_TONES[runHealth(run)];
}

const KIND_LABELS = { fixer: "Auto-merge fixer", autofix: "Auto-fix", prompt: "Prompt", custom: "Custom agent" };

export function agentLabel(row, agents) {
  const configured = agents.find((agent) => agent.id === (row.agent_id || row.kind));
  return configured?.name || KIND_LABELS[row.kind] || row.kind;
}
