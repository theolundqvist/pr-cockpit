import { describe, expect, test } from "bun:test";
import { constrainsDrafts, matchesQuery, parseQuery, wantsHistoricalPrs, type QueryContext, type QueryTarget } from "./query.ts";

function pr(overrides: Partial<QueryTarget>): QueryTarget {
  return {
    repo: "example-org/webapp",
    number: 1,
    state: "OPEN",
    is_draft: 0,
    title: "Fix the thing",
    author: "theolundqvist",
    base_ref: "staging",
    head_ref: "fix-thing",
    review_decision: null,
    labels: [],
    ...overrides,
  };
}

function matches(query: string, overrides: Partial<QueryTarget> = {}, context: Partial<QueryContext> = {}): boolean {
  return matchesQuery(pr(overrides), parseQuery(query), { archived: false, ...context });
}

describe("matchesQuery", () => {
  test("bare words match title, repo, number, branch, or label, and AND together", () => {
    expect(matches("thing")).toBe(true);
    expect(matches("webapp")).toBe(true);
    expect(matches("#1")).toBe(true);
    expect(matches("staging")).toBe(true);
    expect(matches("merge", { labels: ["do not merge"] })).toBe(true);
    expect(matches("fix thing")).toBe(true);
    expect(matches("fix nomatch")).toBe(false);
  });

  test("a quoted phrase matches as a whole, and -phrase excludes it", () => {
    expect(matches('"the thing"')).toBe(true);
    expect(matches('"thing the"')).toBe(false);
    expect(matches('-"do not merge"', { title: "Do not merge: experiment" })).toBe(false);
    expect(matches('-"do not merge"', { labels: ["Do Not Merge"] })).toBe(false);
    expect(matches('-"do not merge"')).toBe(true);
    expect(matches("-thing")).toBe(false);
  });

  test("an unterminated quote while typing still filters by the phrase so far", () => {
    expect(matches('"fix the')).toBe(true);
    expect(matches('-"fix the')).toBe(false);
  });

  test("label: matches a label exactly, case-insensitively; a comma list matches any", () => {
    const labelled = { labels: ["agent-owned", "Preview"] };
    expect(matches("label:agent-owned", labelled)).toBe(true);
    expect(matches("label:AGENT-OWNED", labelled)).toBe(true);
    expect(matches("label:agent", labelled)).toBe(false);
    expect(matches("label:bug,preview", labelled)).toBe(true);
    expect(matches("label:agent-owned label:bug", labelled)).toBe(false);
    expect(matches('label:"do not merge"', { labels: ["do not merge"] })).toBe(true);
  });

  test("-label: excludes the label and keeps unlabelled PRs", () => {
    expect(matches("-label:agent-owned", { labels: ["agent-owned"] })).toBe(false);
    expect(matches("-label:agent-owned", { labels: ["preview"] })).toBe(true);
    expect(matches("-label:agent-owned")).toBe(true);
  });

  test("is:<label> reads as label:, while GitHub's own is: values keep their meaning", () => {
    expect(matches("is:agent-owned", { labels: ["agent-owned"] })).toBe(true);
    expect(matches("-is:agent-owned", { labels: ["agent-owned"] })).toBe(false);
    expect(matches("is:open", { labels: [] })).toBe(true);
    expect(matches("is:pr")).toBe(true);
  });

  test("no:label matches only unlabelled PRs", () => {
    expect(matches("no:label")).toBe(true);
    expect(matches("no:label", { labels: ["bug"] })).toBe(false);
    expect(matches("-no:label", { labels: ["bug"] })).toBe(true);
  });

  test("is:draft, -is:draft, draft:true and draft:false check is_draft", () => {
    const draft = { state: "draft", is_draft: 1 };
    expect(matches("is:draft", draft)).toBe(true);
    expect(matches("is:draft")).toBe(false);
    expect(matches("-is:draft", draft)).toBe(false);
    expect(matches("-is:draft")).toBe(true);
    expect(matches("draft:true", draft)).toBe(true);
    expect(matches("draft:false", draft)).toBe(false);
    expect(matches("draft:false")).toBe(true);
  });

  test("author: matches the exact login; @me resolves to the viewer and app/ names bots", () => {
    expect(matches("author:TheoLundqvist")).toBe(true);
    expect(matches("author:theo")).toBe(false);
    expect(matches("-author:theolundqvist")).toBe(false);
    expect(matches("author:@me", {}, { viewer: "TheoLundqvist" })).toBe(true);
    expect(matches("author:@me", {}, { viewer: "someone" })).toBe(false);
    expect(matches("author:@me", {}, { viewer: null })).toBe(false);
    expect(matches("author:app/dependabot", { author: "dependabot" })).toBe(true);
  });

  test("state:/is: open matches drafts; closed and merged match the stored state", () => {
    expect(matches("state:open", { state: "draft", is_draft: 1 })).toBe(true);
    expect(matches("state:closed", { state: "draft", is_draft: 1 })).toBe(false);
    expect(matches("is:merged", { state: "MERGED" })).toBe(true);
    expect(matches("state:open", { state: "MERGED" })).toBe(false);
    expect(matches("-is:open", { state: "MERGED" })).toBe(true);
    expect(matches("is:draft state:closed", { state: "CLOSED", is_draft: 1 })).toBe(true);
  });

  test("is:archived checks the passed-in archived flag", () => {
    expect(matches("is:archived", {}, { archived: true })).toBe(true);
    expect(matches("is:archived")).toBe(false);
    expect(matches("-is:archived")).toBe(true);
  });

  test("repo: accepts owner/name or the bare name; base: and head: match exactly", () => {
    expect(matches("repo:example-org/webapp")).toBe(true);
    expect(matches("repo:webapp")).toBe(true);
    expect(matches("repo:web")).toBe(false);
    expect(matches("-repo:webapp")).toBe(false);
    expect(matches("base:staging")).toBe(true);
    expect(matches("base:main")).toBe(false);
    expect(matches("head:fix-thing")).toBe(true);
  });

  test("review: maps to the review decision", () => {
    expect(matches("review:approved", { review_decision: "APPROVED" })).toBe(true);
    expect(matches("review:required", { review_decision: "APPROVED" })).toBe(false);
    expect(matches("review:required", { review_decision: "REVIEW_REQUIRED" })).toBe(true);
    expect(matches("review:changes_requested", { review_decision: "CHANGES_REQUESTED" })).toBe(true);
    expect(matches("review:none")).toBe(true);
    expect(matches("-review:approved", { review_decision: "APPROVED" })).toBe(false);
  });

  test("qualifiers AND with each other and with words", () => {
    expect(matches("author:theolundqvist state:open thing")).toBe(true);
    expect(matches("author:theolundqvist state:closed thing")).toBe(false);
    expect(matches("author:theolundqvist author:someoneelse")).toBe(false);
  });

  test("a qualifier still being typed filters nothing; unknown ones are words", () => {
    expect(matches("label:")).toBe(true);
    expect(matches("-")).toBe(true);
    expect(matches("state:banana")).toBe(false);
    expect(matches("foo:bar", { title: "foo:bar fix" })).toBe(true);
  });
});

describe("wantsHistoricalPrs", () => {
  test("only when the state filter rules out open PRs", () => {
    expect(wantsHistoricalPrs(parseQuery("thing"))).toBe(false);
    expect(wantsHistoricalPrs(parseQuery("state:open"))).toBe(false);
    expect(wantsHistoricalPrs(parseQuery("-state:closed"))).toBe(false);
    expect(wantsHistoricalPrs(parseQuery("is:merged"))).toBe(true);
    expect(wantsHistoricalPrs(parseQuery("-is:open"))).toBe(true);
  });
});

test("constrainsDrafts reports whether the query decides draft visibility", () => {
  expect(constrainsDrafts(parseQuery("is:draft"))).toBe(true);
  expect(constrainsDrafts(parseQuery("-is:draft"))).toBe(true);
  expect(constrainsDrafts(parseQuery("draft:false"))).toBe(true);
  expect(constrainsDrafts(parseQuery("label:draft"))).toBe(false);
});
