const CONTROL_RE = /^##\[([^\] ]+)(?: ([^\]]*))?\](.*)$/;
const WORKFLOW_COMMAND_RE = /^::(error|warning|notice)(?: (.*?))?::(.*)$/;
const COMMAND_RE = /^\[command\](.*)$/;
const ANSI_SGR_RE = /\u001b\[([0-9;]*)m/g;
const ANSI_COLORS = new Map([
  [30, "black"], [31, "red"], [32, "green"], [33, "yellow"],
  [34, "blue"], [35, "magenta"], [36, "cyan"], [37, "white"],
  [90, "bright-black"], [91, "bright-red"], [92, "bright-green"], [93, "bright-yellow"],
  [94, "bright-blue"], [95, "bright-magenta"], [96, "bright-cyan"], [97, "bright-white"],
]);

function styledText(value) {
  const matches = [...value.matchAll(ANSI_SGR_RE)];
  if (matches.length === 0) return { text: value, segments: null };
  const segments = [];
  let cursor = 0;
  let color = null;
  let bold = false;
  const append = (text) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.color === color && previous?.bold === bold) previous.text += text;
    else segments.push({ text, color, bold });
  };
  for (const match of matches) {
    append(value.slice(cursor, match.index));
    const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        color = null;
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        color = null;
      } else if (ANSI_COLORS.has(code)) {
        color = ANSI_COLORS.get(code);
      }
    }
    cursor = match.index + match[0].length;
  }
  append(value.slice(cursor));
  return { text: segments.map((segment) => segment.text).join(""), segments };
}

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

export function parseActionLog(text, jobConclusion = null, failedStep = null) {
  const steps = [];
  const annotations = [];
  let current = null;
  let actionId = null;
  let actionOpen = false;
  let rootGroupDepth = 0;
  let groupStack = [];
  let groupCounter = 0;
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
    const groupConclusions = new Map();
    for (const line of current.lines) {
      for (const groupId of line.groups ?? []) {
        const existing = groupConclusions.get(groupId);
        if (line.tone === "failure") groupConclusions.set(groupId, "failure");
        else if (line.tone === "warning" && existing !== "failure") groupConclusions.set(groupId, "warning");
        else if (!existing) groupConclusions.set(groupId, "success");
      }
    }
    for (const line of current.lines) {
      if (line.groupId) line.conclusion = groupConclusions.get(line.groupId) ?? "success";
    }
    if (current.lines.length > 0 || current.conclusion === "skipped") steps.push(current);
    current = null;
    actionId = null;
    actionOpen = false;
    rootGroupDepth = 0;
    groupStack = [];
  }

  function addLine(line, textValue, tone = "output", fields = {}) {
    const styled = styledText(textValue);
    const item = { line, text: styled.text, tone, ...fields };
    if (styled.segments) item.segments = styled.segments;
    if (groupStack.length > 0) item.groups = [...groupStack];
    const step = ensureStep(postCleanup ? "Post job cleanup" : "Set up job");
    if (rootGroupDepth > 0 && step.rootGroup) item.rootGroupId = step.rootGroup.id;
    step.lines.push(item);
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
        actionOpen = true;
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
        if (actionOpen || rootGroupDepth > 0 || groupStack.length > 0) {
          const groupId = `${ensureStep().id}-group-${++groupCounter}`;
          addLine(lineNumber, value || "Log group", "group", { groupId });
          groupStack.push(groupId);
        } else {
          startStep(value || "Log group");
          current.rootGroup = {
            id: `${current.id}-shell`,
            line: lineNumber,
            title: value || "Log group",
          };
          rootGroupDepth = 1;
          postCleanup = false;
        }
        continue;
      }
      if (command === "endgroup") {
        if (groupStack.length > 0) groupStack.pop();
        else rootGroupDepth = Math.max(0, rootGroupDepth - 1);
        continue;
      }
      if (command === "command") {
        addLine(lineNumber, value, "command");
        continue;
      }
      if (command === "error" || command === "warning" || command === "notice") {
        const tone = command === "error" ? "failure" : command;
        const message = decodeCommandText(value);
        annotations.push({ line: lineNumber, tone, text: styledText(message).text });
        addLine(lineNumber, message, tone);
        if (tone === "failure") current.conclusion = "failure";
        else if (tone === "warning" && current.conclusion === "success") current.conclusion = "warning";
        continue;
      }
    }
    const commandLine = source.match(COMMAND_RE);
    if (commandLine) {
      addLine(lineNumber, commandLine[1], "command");
      continue;
    }


    const workflowCommand = source.match(WORKFLOW_COMMAND_RE);
    if (workflowCommand) {
      const tone = workflowCommand[1] === "error" ? "failure" : workflowCommand[1];
      const message = decodeCommandText(workflowCommand[3]);
      annotations.push({ line: lineNumber, tone, text: styledText(message).text });
      addLine(lineNumber, message, tone);
      if (tone === "failure") current.conclusion = "failure";
      else if (tone === "warning" && current.conclusion === "success") current.conclusion = "warning";
      continue;
    }

    if (source === "Post job cleanup.") {
      finishStep();
      postCleanup = true;
      continue;
    }

    const plain = styledText(source).text;
    const tone = /^\[warn\]/i.test(plain) ? "warning" : "output";
    addLine(lineNumber, source, tone);
    if (tone === "warning" && current.conclusion === "success") current.conclusion = "warning";
  }
  finishStep();

  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(jobConclusion)
    && !steps.some((step) => step.conclusion === "failure")) {
    const failed = [...steps].reverse().find((step) => !step.title.startsWith("Post ")) ?? steps.at(-1);
    if (failed) failed.conclusion = "failure";
  }

  const failed = steps.find((step) =>
    step.conclusion === "failure" && /^Run\b/.test(step.title) && step.rootGroup
  );
  if (failedStep && failed && failed.title !== failedStep) {
    const group = failed.rootGroup;
    let groupConclusion = "success";
    for (const line of failed.lines) {
      if (line.rootGroupId !== group.id) continue;
      line.groups = [group.id, ...(line.groups ?? [])];
      if (line.tone === "failure") groupConclusion = "failure";
      else if (line.tone === "warning" && groupConclusion === "success") groupConclusion = "warning";
    }
    failed.lines.unshift({
      line: group.line,
      text: group.title,
      tone: "group",
      groupId: group.id,
      conclusion: groupConclusion,
    });
    failed.title = failedStep;
  }
  for (const step of steps) {
    delete step.rootGroup;
    for (const line of step.lines) delete line.rootGroupId;
  }

  return { steps, annotations };
}
