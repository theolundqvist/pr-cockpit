import { expect, test } from "bun:test";
import { availableRepositories, filterByRepositories } from "./repoFilter.js";

test("repository choices include configured and cached repositories", () => {
  const prs = [{ repo: "example/app" }, { repo: "example/api" }];
  expect(availableRepositories(["example/empty", "example/app"], prs)).toEqual([
    "example/api",
    "example/app",
    "example/empty",
  ]);
  expect(filterByRepositories(prs, ["example/app"])).toEqual([{ repo: "example/app" }]);
  expect(filterByRepositories(prs, ["example/app", "example/api"])).toEqual(prs);
  expect(filterByRepositories(prs, [])).toBe(prs);
});
