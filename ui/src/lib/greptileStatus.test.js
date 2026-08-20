import { describe, expect, test } from "bun:test";
import { greptileReviewMeta, greptileStatus } from "./greptileStatus.js";

const SCORED_BODY = `Confidence Score: 3/5\nLast reviewed commit: [msg](https://github.com/acme/widgets/commit/48d3ae2a108f1453d7078aab4bcd3935c445df23)`;

function comment(login, body) {
  return { author: { login }, body };
}

function thread(login, isResolved) {
  return { isResolved, comments: { nodes: [{ author: { login } }] } };
}

describe("greptileReviewMeta", () => {
  test("extracts confidence, reviewed sha, and greptile's own unresolved thread count", () => {
    const pr = {
      comments: { nodes: [comment("greptile-apps", SCORED_BODY)] },
      reviewThreads: { nodes: [thread("greptile-apps", false), thread("a-human", false)] },
    };
    const meta = greptileReviewMeta(pr);
    expect(meta.confidence).toBe(3);
    expect(meta.reviewedSha).toBe("48d3ae2a108f1453d7078aab4bcd3935c445df23");
    expect(meta.unresolvedCount).toBe(1);
  });

  test("no greptile comment yields nulls", () => {
    const meta = greptileReviewMeta({ comments: { nodes: [] }, reviewThreads: { nodes: [] } });
    expect(meta.confidence).toBeNull();
    expect(meta.reviewedSha).toBeNull();
  });
});

describe("greptileStatus", () => {
  test("live when reviewed sha matches head", () => {
    expect(greptileStatus({ confidence: 3, reviewedSha: "abc", unresolvedCount: 0 }, "abc")).toBeNull();
  });

  test("stale when commits landed since the review and threads remain", () => {
    expect(greptileStatus({ confidence: 3, reviewedSha: "old", unresolvedCount: 1 }, "new")).toBe("stale");
  });

  test("addressed when stale but every greptile thread is resolved", () => {
    expect(greptileStatus({ confidence: 3, reviewedSha: "old", unresolvedCount: 0 }, "new")).toBe("addressed");
  });
});
