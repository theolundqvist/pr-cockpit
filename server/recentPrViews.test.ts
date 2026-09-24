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
});
