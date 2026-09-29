import { describe, expect, test } from "bun:test";
import { createRecentPrViews } from "./recentPrViews.ts";

describe("recent PR views", () => {
  test("remember a bounded set of PRs for a limited window", () => {
    let clock = 0;
    const views = createRecentPrViews(() => clock, 1_000, 2);
    views.note("acme/app", 1);
    views.note("acme/app", 2);
    expect(views.has("acme/app", 1)).toBe(true);
    expect(views.has("acme/app", 3)).toBe(false);

    views.note("acme/app", 1);
    views.note("acme/app", 3);
    expect(views.has("acme/app", 2)).toBe(false);
    expect(views.has("acme/app", 1)).toBe(true);

    clock = 999;
    expect(views.has("acme/app", 3)).toBe(true);
    clock = 1_000;
    expect(views.has("acme/app", 3)).toBe(false);
  });

  test("list a repository's unexpired views without matching other repositories", () => {
    let clock = 0;
    const views = createRecentPrViews(() => clock, 1_000, 5);
    views.note("acme/app", 1);
    views.note("acme/ap", 2);
    views.note("acme/app-two", 3);
    clock = 500;
    views.note("acme/app", 4);
    expect(views.numbers("acme/app")).toEqual([1, 4]);

    clock = 1_000;
    expect(views.numbers("acme/app")).toEqual([4]);
    expect(views.numbers("acme/ap")).toEqual([]);
  });
});
