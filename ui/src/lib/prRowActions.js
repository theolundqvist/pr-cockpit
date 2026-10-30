// A PR row's actions, defined once for every list that shows the row context menu: the inbox and the
// embedded overview. Each host passes the handlers it can carry out; an action without a handler is
// left out, so an embed never offers something it cannot do. `key` is the row shortcut for the action.

// Tracked drafts carry state "draft" even though the pull request is still open.
export function isOpenPr(pr) {
  return pr.state === "OPEN" || pr.state === "draft";
}

export function isApprovedForSafeMerge(pr, approvalEnabled) {
  return approvalEnabled && pr.approvedForSafeMerge === true;
}

export const QUICK_ACTIONS = "quick-actions";

export function prRowActions(pr, host) {
  const { view = "open", archived = false, approvalEnabled = false, renameDisabled = false, keys = {} } = host;
  const actions = [];
  const add = (id, label, run, key = null, disabled = false) => {
    if (run) actions.push({ id, label, key: id in keys ? keys[id] : key, disabled, run: () => run(pr) });
  };
  add("open", "Open pull request", host.open, "enter");
  add("github", "Open on GitHub", host.github, "o");
  add("rename", "Rename", host.rename, null, renameDisabled);
  if (view === "open" && !archived && isOpenPr(pr)) add("pin", pr.rank == null ? "Pin" : "Unpin", host.pin, "s");
  // Revoking consent never waits on grant eligibility: drafts and archived rows can still withdraw it.
  const approved = isApprovedForSafeMerge(pr, approvalEnabled);
  if (view === "open" && (approved || (approvalEnabled && !archived && isOpenPr(pr)))) {
    add("approve", approved ? "Revoke safe-merge approval" : "Approve for safe merge", host.approve);
  }
  // An agent hands a PR over for review; the reviewer can only withdraw that handoff here.
  if (pr.readyForReview === true) add("clear-ready", "Clear ready for review", host.clearReady, "n");
  if (view === "open") add("archive", archived ? "Unarchive" : "Archive", host.archive, "e");
  add("set-aside", "Set aside", host.setAside, "b");
  add("remind", "Remind me…", host.remind, "h");
  if (host.quickActions) actions.push({ id: QUICK_ACTIONS });
  if (pr.state === "OPEN") add("close", "Close PR", host.close);
  return actions;
}

// The action a row key runs, matching the keys the inbox list binds: plain keys only, since shifted
// letters there act on the list rather than the row.
export function prRowActionForKey(actions, key, shiftKey = false) {
  if (shiftKey) return null;
  const wanted = key === "Enter" ? "enter" : key.toLowerCase();
  if (key !== "Enter" && key !== wanted) return null;
  return actions.find((action) => action.key === wanted && action.run && !action.disabled) ?? null;
}
