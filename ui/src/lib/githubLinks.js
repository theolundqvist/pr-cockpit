// Cockpit Actions routes use a cache-aware destination; body links start in Cockpit so the cache can be checked.
export function actionsRunDestination(repo, runId, cached) {
  return cached
    ? `#/actions/run/${repo}/${runId}`
    : `https://github.com/${repo}/actions/runs/${runId}`;
}

// Cockpit page for a GitHub Actions run URL, or null when Cockpit has no such page.
export function cockpitActionsHref(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 5 && parts[2] === "actions" && parts[3] === "runs" && /^\d+$/.test(parts[4])) {
    return actionsRunDestination(`${parts[0]}/${parts[1]}`, parts[4], true);
  }
  return null;
}

export function isMissingActionRunError(error) {
  return error?.status === 404;
}
