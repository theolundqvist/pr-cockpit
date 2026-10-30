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

test("a bare order label cooks as an order request until Kitchen labels a later stage", () => {
  const ordered = cookingStage(pr(["order"]));
  expect(ordered).toEqual({ label: "order", title: "Order requested", rank: cookingStage(pr(["kitchen: order"])).rank });
  expect(cookingStage(pr(["Order", "kitchen: prep"]))?.title).toBe("Preparing");
  expect(cookingStage(pr(["order"], "MERGED"))).toBeNull();
});

test("a stacked PR with only the bare order label waits for the layers below it", () => {
  const stacked = (labels, baseIsDefaultBranch) => ({ ...pr(labels), baseIsDefaultBranch });
  expect(cookingStage(stacked(["order"], false))).toEqual({ label: "order", title: "Waiting for lower layers", rank: cookingStage(pr(["order"])).rank });
  expect(cookingStage(stacked(["order"], true))?.title).toBe("Order requested");
  expect(cookingStage(stacked(["order"], null))?.title).toBe("Order requested");
  expect(cookingStage(stacked(["order", "kitchen: order"], false))?.title).toBe("Order requested");
  expect(cookingStage(stacked(["order", "kitchen: prep"], false))?.title).toBe("Preparing");
});
