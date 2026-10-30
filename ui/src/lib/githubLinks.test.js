import { expect, test } from "bun:test";
import { actionsRunDestination, cockpitActionsHref } from "./githubLinks.js";

test("cached Actions runs stay in Cockpit and uncached runs open GitHub", () => {
  const url = "https://github.com/scape-app/scape/actions/runs/41051620137";
  expect(actionsRunDestination("scape-app/scape", 41051620137, true)).toBe("#/actions/run/scape-app/scape/41051620137");
  expect(actionsRunDestination("scape-app/scape", 41051620137, false)).toBe(url);
  expect(cockpitActionsHref(url)).toBe("#/actions/run/scape-app/scape/41051620137");
});

test("non-run GitHub links remain external", () => {
  expect(cockpitActionsHref("https://github.com/scape-app/scape/pull/14432")).toBeNull();
});
