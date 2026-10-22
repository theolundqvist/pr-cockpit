import { describe, expect, test } from "bun:test";
import { locateCommentTarget, parseCommentTarget, prLinkHash, threadOpensInFiles } from "./commentTarget.js";

describe("GitHub pull request links", () => {
  test("keep a comment permalink as the route's target", () => {
    expect(prLinkHash("https://github.com/acme/widgets/pull/12#discussion_r4348303060")).toBe("#/pr/acme/widgets/12?comment=discussion_r4348303060");
    expect(prLinkHash("https://github.com/acme/widgets/pull/12#issuecomment-77")).toBe("#/pr/acme/widgets/12?comment=issuecomment-77");
    expect(prLinkHash("https://github.com/acme/widgets/pull/12?w=1#pullrequestreview-9")).toBe("#/pr/acme/widgets/12?comment=pullrequestreview-9");
    expect(prLinkHash("https://github.com/acme/widgets/pull/12/files#r55")).toBe("#/pr/acme/widgets/12?comment=discussion_r55");
  });

  test("open the PR itself when the fragment names no comment", () => {
    expect(prLinkHash("https://github.com/acme/widgets/pull/12")).toBe("#/pr/acme/widgets/12");
    expect(prLinkHash("https://github.com/acme/widgets/pull/12#discussion_r")).toBe("#/pr/acme/widgets/12");
    expect(prLinkHash("https://github.com/acme/widgets/pull/12#issuecomment-1x")).toBe("#/pr/acme/widgets/12");
  });

  test("leave other GitHub pages as GitHub links", () => {
    expect(prLinkHash("https://github.com/acme/widgets/pull/12/files")).toBeNull();
    expect(prLinkHash("https://github.com/acme/widgets/pull/12/files#diff-abc")).toBeNull();
    expect(prLinkHash("https://github.com/acme/widgets/pull/12/commits")).toBeNull();
    expect(prLinkHash("https://github.com/acme/widgets/issues/12#issuecomment-77")).toBeNull();
    expect(prLinkHash("https://example.com/acme/widgets/pull/12#issuecomment-77")).toBeNull();
  });

  test("accept only positive decimal comment ids", () => {
    expect(parseCommentTarget("discussion_r0")).toBeNull();
    expect(parseCommentTarget("discussion_r12;x")).toBeNull();
    expect(parseCommentTarget(null)).toBeNull();
    expect(parseCommentTarget("pullrequestreview-31")).toEqual({ kind: "review", id: 31, token: "pullrequestreview-31" });
  });
});

describe("locating a target in a loaded detail", () => {
  const thread = { id: "T1", comments: { nodes: [{ databaseId: 10 }, { databaseId: 11 }] } };
  const detail = {
    comments: { nodes: [{ id: "IC_a", databaseId: 11 }, { id: "IC_cached" }] },
    reviews: { nodes: [{ id: "PRR_a", databaseId: 10 }] },
  };

  test("finds the thread that holds a reply, not only its root", () => {
    expect(locateCommentTarget(detail, [thread], parseCommentTarget("discussion_r11"))).toEqual({ thread });
  });

  test("keeps issue comment, review, and review comment ids apart", () => {
    expect(locateCommentTarget(detail, [thread], parseCommentTarget("issuecomment-11"))?.node.id).toBe("IC_a");
    expect(locateCommentTarget(detail, [thread], parseCommentTarget("pullrequestreview-10"))?.node.id).toBe("PRR_a");
    expect(locateCommentTarget(detail, [thread], parseCommentTarget("issuecomment-10"))).toBeNull();
  });

  test("reports a comment the detail does not carry as missing", () => {
    expect(locateCommentTarget(detail, [thread], parseCommentTarget("discussion_r12"))).toBeNull();
    expect(locateCommentTarget(detail, [], parseCommentTarget("discussion_r10"))).toBeNull();
  });
});

test("only current right-side threads open in Files", () => {
  const anchored = { isOutdated: false, line: 14, diffSide: "RIGHT" };
  expect(threadOpensInFiles(anchored)).toBe(true);
  expect(threadOpensInFiles({ ...anchored, isOutdated: true })).toBe(false);
  expect(threadOpensInFiles({ ...anchored, line: null })).toBe(false);
  expect(threadOpensInFiles({ ...anchored, diffSide: "LEFT" })).toBe(false);
});
