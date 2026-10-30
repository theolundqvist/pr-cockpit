import { expect, test } from "bun:test";
import { actionsRunDestination, cockpitActionsHref, isMissingActionRunError } from "./githubLinks.js";

test("cached Actions runs stay in Cockpit and uncached runs open GitHub", () => {
  const url = "https://github.com/example-org/example/actions/runs/12345";
  expect(actionsRunDestination("example-org/example", 12345, true)).toBe("#/actions/run/example-org/example/12345");
  expect(actionsRunDestination("example-org/example", 12345, false)).toBe(url);
  expect(cockpitActionsHref(url)).toBe("#/actions/run/example-org/example/12345");
});

test("only a missing cached run opens GitHub", () => {
  expect(isMissingActionRunError({ status: 404 })).toBe(true);
  expect(isMissingActionRunError({ status: 503 })).toBe(false);
});

test("non-run GitHub links remain external", () => {
  expect(cockpitActionsHref("https://github.com/example-org/example/pull/1")).toBeNull();
});
