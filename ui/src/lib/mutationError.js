function sentence(text) {
  if (!text) return "GitHub rejected the request.";
  if (/^interrupted$/i.test(text)) return "The request was interrupted.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function jsonMessage(raw) {
  const start = raw.search(/[{\[]/);
  if (start === -1) return null;
  try {
    const body = JSON.parse(raw.slice(start));
    const errors = Array.isArray(body) ? body : [body];
    const messages = errors.map((error) => error?.message).filter((message) => typeof message === "string");
    return messages.length ? messages.join(" ") : null;
  } catch {
    return null;
  }
}

export function presentMutationError(action, rawError) {
  const details = String(rawError ?? "").trim();
  let message = jsonMessage(details);

  if (!message) {
    message = details.replace(/^(?:[A-Za-z][A-Za-z0-9]*)?Error:\s*/, "");
    const failed = message.match(/\bfailed:\s*(?:\d{3}\s*)?([\s\S]*)$/i);
    if (failed) message = failed[1];
  }

  const lines = String(message ?? "")
    .replaceAll("\\n", "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1 && /^repository rule violations found$/i.test(lines[0])) lines.shift();

  const cleanMessage = sentence(lines.join(" "));
  const blocked = /repository rule|must be resolved|not mergeable|conflict|not allowed|blocked/i.test(cleanMessage);
  const subject = action.trim();

  return {
    title: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${blocked ? "blocked" : "failed"}`,
    message: cleanMessage,
    details,
  };
}
