import { expect, test } from "bun:test";
import { availableRepositories, filterByRepository } from "./repoFilter.js";

test("repository choices include configured and cached repositories", () => {
  const prs = [{ repo: "example/app" }, { repo: "example/api" }];
  expect(availableRepositories(["example/empty", "example/app"], prs)).toEqual([
    "example/api",
    "example/app",
    "example/empty",
  ]);
  expect(filterByRepository(prs, "example/app")).toEqual([{ repo: "example/app" }]);
  expect(filterByRepository(prs, "")).toBe(prs);
});
