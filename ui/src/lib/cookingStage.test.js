import { expect, test } from "bun:test";
import { cookingStage, isBurnt } from "./cookingStage.js";

const pr = (labels, state = "OPEN") => ({ state, mergeFailed: false, labels: labels.map((name) => ({ name })) });

test("an open PR labelled burnt is burnt and never cooking", () => {
  const burnt = pr(["kitchen: oven", " Kitchen: Burnt "]);
  expect(isBurnt(burnt)).toBe(true);
  expect(cookingStage(burnt)).toBeNull();
  expect(isBurnt({ state: "OPEN", labels: ["kitchen: burnt"] })).toBe(true);
});

test("closed, merged, and unlabelled PRs are not burnt", () => {
  expect(isBurnt(pr(["kitchen: burnt"], "MERGED"))).toBe(false);
  expect(isBurnt(pr(["kitchen: burnt"], "CLOSED"))).toBe(false);
  expect(isBurnt(pr(["kitchen: oven"]))).toBe(false);
  expect(isBurnt({ state: "OPEN" })).toBe(false);
  expect(cookingStage(pr(["kitchen: oven"]))?.title).toBe("In the oven");
});
