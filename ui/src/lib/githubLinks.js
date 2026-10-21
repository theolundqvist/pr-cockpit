// Cockpit page for a github.com Actions run or job URL, or null when Cockpit has no such page.
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
    return `#/actions/run/${parts[0]}/${parts[1]}/${parts[4]}`;
  }
  return null;
}
