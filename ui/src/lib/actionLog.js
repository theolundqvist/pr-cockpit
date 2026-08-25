const CONTROL_RE = /^##\[([^\] ]+)(?: ([^\]]*))?\](.*)$/;
const WORKFLOW_COMMAND_RE = /^::(error|warning|notice)(?: (.*?))?::(.*)$/;

function decodeCommandText(value) {
  return value.replaceAll("%0D", "\r").replaceAll("%0A", "\n").replaceAll("%25", "%");
}

function fields(value) {
  const result = {};
  for (const field of value.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0) continue;
    result[field.slice(0, separator)] = decodeCommandText(field.slice(separator + 1));
  }
  return result;
}

function trimLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].text === "") start++;
  while (end > start && lines[end - 1].text === "") end--;
  return lines.slice(start, end);
}

export function parseActionLog(text, jobConclusion = null) {
  const steps = [];
  const annotations = [];
  let current = null;
  let actionId = null;
  let groupDepth = 0;
  let postCleanup = false;

  function startStep(title) {
    finishStep();
    current = {
      id: `step-${steps.length + 1}`,
      title: title || "Log output",
      conclusion: "success",
      durationMs: null,
      lines: [],
    };
  }

  function ensureStep(title = "Set up job") {
    if (!current) startStep(title);
    return current;
  }

  function finishStep(conclusion = null, durationMs = null) {
    if (!current) return;
    current.lines = trimLines(current.lines);
    if (conclusion && current.conclusion !== "failure") current.conclusion = conclusion;
    if (durationMs !== null && Number.isFinite(durationMs)) current.durationMs = durationMs;
    if (current.lines.length > 0 || current.conclusion === "skipped") steps.push(current);
    current = null;
    actionId = null;
    groupDepth = 0;
  }

  function addLine(line, textValue, tone = "output") {
    ensureStep(postCleanup ? "Post job cleanup" : "Set up job").lines.push({ line, text: textValue, tone });
  }

  const sourceLines = text.replace(/^\uFEFF/, "").split("\n");
  for (let index = 0; index < sourceLines.length; index++) {
    const source = sourceLines[index].replace(/\r$/, "");
    const lineNumber = index + 1;
    const control = source.match(CONTROL_RE);

    if (control) {
      const command = control[1];
      const metadata = control[2] || "";
      const value = control[3];
      if (command === "start-action") {
        const properties = fields(metadata);
        const label = properties.display || "Action";
        startStep(postCleanup ? `Post ${label.replace(/^Run /, "")}` : label);
        actionId = properties.id || null;
        postCleanup = false;
        continue;
      }
      if (command === "end-action") {
        const properties = fields(metadata);
        if (!actionId || !properties.id || properties.id === actionId) {
          finishStep(properties.conclusion || properties.outcome || "success", Number(properties.duration_ms));
        }
        continue;
      }
      if (command === "group") {
        if (actionId || groupDepth > 0) {
          addLine(lineNumber, value, "group");
          groupDepth++;
        } else {
          startStep(value || "Log group");
          groupDepth = 1;
          postCleanup = false;
        }
        continue;
      }
      if (command === "endgroup") {
        groupDepth = Math.max(0, groupDepth - 1);
        continue;
      }
      if (command === "command") {
        addLine(lineNumber, value, "command");
        continue;
      }
      if (command === "error" || command === "warning" || command === "notice") {
        const tone = command === "error" ? "failure" : command;
        const message = decodeCommandText(value);
        annotations.push({ line: lineNumber, tone, text: message });
        const step = ensureStep(postCleanup ? "Post job cleanup" : "Log output");
        step.lines.push({ line: lineNumber, text: message, tone });
        if (tone === "failure") step.conclusion = "failure";
        else if (tone === "warning" && step.conclusion === "success") step.conclusion = "warning";
        continue;
      }
    }

    const workflowCommand = source.match(WORKFLOW_COMMAND_RE);
    if (workflowCommand) {
      const tone = workflowCommand[1] === "error" ? "failure" : workflowCommand[1];
      const message = decodeCommandText(workflowCommand[3]);
      annotations.push({ line: lineNumber, tone, text: message });
      const step = ensureStep(postCleanup ? "Post job cleanup" : "Log output");
      step.lines.push({ line: lineNumber, text: message, tone });
      if (tone === "failure") step.conclusion = "failure";
      else if (tone === "warning" && step.conclusion === "success") step.conclusion = "warning";
      continue;
    }

    if (source === "Post job cleanup.") {
      finishStep();
      postCleanup = true;
      continue;
    }

    const tone = /^\[warn\]/i.test(source) ? "warning" : "output";
    addLine(lineNumber, source, tone);
    if (tone === "warning" && current.conclusion === "success") current.conclusion = "warning";
  }
  finishStep();

  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(jobConclusion)
    && !steps.some((step) => step.conclusion === "failure")) {
    const failed = [...steps].reverse().find((step) => !step.title.startsWith("Post ")) ?? steps.at(-1);
    if (failed) failed.conclusion = "failure";
  }

  return { steps, annotations };
}
