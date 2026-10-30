import { expect, test } from "bun:test";
import { prRowActionForKey, prRowActions, QUICK_ACTIONS } from "./prRowActions.js";

const pr = { repo: "acme/app", number: 7, state: "OPEN", rank: null, approvedForSafeMerge: false };
const handler = () => {};
const everything = {
  open: handler, github: handler, rename: handler, pin: handler, approve: handler, archive: handler,
  setAside: handler, remind: handler, quickActions: true, close: handler,
};

test("lists the inbox row menu in its order with each row key", () => {
  const actions = prRowActions(pr, { ...everything, approvalEnabled: true });
  expect(actions.map((action) => [action.id, action.label, action.key ?? null])).toEqual([
    ["open", "Open pull request", "enter"],
    ["github", "Open on GitHub", "o"],
    ["rename", "Rename", null],
    ["pin", "Pin", "s"],
    ["approve", "Approve for safe merge", null],
    ["archive", "Archive", "e"],
    ["set-aside", "Set aside", "b"],
    ["remind", "Remind me…", "h"],
    [QUICK_ACTIONS, undefined, null],
    ["close", "Close PR", null],
  ]);
});

test("offers only the actions a host can carry out, with its own key overrides", () => {
  const actions = prRowActions(pr, { open: handler, archive: handler, close: handler, keys: { archive: null } });
  expect(actions.map((action) => [action.id, action.key])).toEqual([["open", "enter"], ["archive", null], ["close", null]]);
});

test("archived and closed rows keep only what applies to them", () => {
  const archived = prRowActions({ ...pr, approvedForSafeMerge: true }, { ...everything, archived: true, approvalEnabled: true });
  expect(archived.map((action) => action.label)).toEqual([
    "Open pull request", "Open on GitHub", "Rename", "Revoke safe-merge approval", "Unarchive", "Set aside", "Remind me…", undefined, "Close PR",
  ]);
  const merged = prRowActions({ ...pr, state: "MERGED", rank: 2 }, everything);
  expect(merged.map((action) => action.id)).toEqual(["open", "github", "rename", "archive", "set-aside", "remind", QUICK_ACTIONS]);
  expect(prRowActions({ ...pr, rank: 0 }, everything).find((action) => action.id === "pin").label).toBe("Unpin");
});

test("a row key runs the action bound to it, never a shifted letter or a disabled action", () => {
  const ran = [];
  const actions = prRowActions(pr, {
    open: () => ran.push("open"), github: () => ran.push("github"), pin: () => ran.push("pin"),
    rename: handler, renameDisabled: true,
  });
  prRowActionForKey(actions, "Enter")?.run();
  prRowActionForKey(actions, "o")?.run();
  prRowActionForKey(actions, "s")?.run();
  expect(ran).toEqual(["open", "github", "pin"]);
  expect(prRowActionForKey(actions, "S", true)).toBeNull();
  expect(prRowActionForKey(actions, "O")).toBeNull();
  expect(prRowActionForKey(actions, "x")).toBeNull();
  expect(prRowActionForKey([{ id: "rename", key: "r", disabled: true, run: handler }], "r")).toBeNull();
});
