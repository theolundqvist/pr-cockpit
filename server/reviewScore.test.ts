import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db, getSetting, setSetting } from "./db.ts";
import { aggregateReviewScore, aggregateReviewStale, candidateTexts, currentReviewerScores, isValidLlmScoreResult, parseBotScore, reviewedShaAt, reviewBots, reviewerLogins } from "./reviewScore.ts";

const EXAMPLE_REVIEW = "Quality Score: 4/5";
const CURSOR_REVIEW = "Cursor Bugbot found 2 potential issues.";
const originalReviewBots = getSetting("review_bots");

function configureReviewBots(patterns: string[]): void {
  setSetting("review_bots", JSON.stringify([{ login: "example-reviewer", patterns }]));
}

afterEach(() => {
  if (originalReviewBots === null) db.query("DELETE FROM settings WHERE key = 'review_bots'").run();
  else setSetting("review_bots", originalReviewBots);
});

function comment(login: string, id: string, body: string) {
  return { id, author: { login }, body, createdAt: "2026-01-01T00:00:00Z" };
}

function review(login: string, id: string, body: string) {
  return { id, author: { login }, state: "COMMENTED", body, submittedAt: "2026-01-01T00:00:00Z" };
}

describe("review bot registry", () => {
  test("parses a configured bot score", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("example-reviewer", EXAMPLE_REVIEW)).toBe(4);
  });

  test("a known bot whose patterns miss has no score", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("example-reviewer", "No numeric verdict here.")).toBe(null);
  });

  test("the first matching pattern wins", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5", "Legacy Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("example-reviewer", "Quality Score: 4/5\nLegacy Score: 2/5")).toBe(4);
  });

  test("an unknown login has no score", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("unknown-reviewer", EXAMPLE_REVIEW)).toBe(null);
  });

  test("malformed JSON is ignored without throwing", () => {
    setSetting("review_bots", "{");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => reviewBots()).not.toThrow();
    expect(reviewBots().map((bot) => bot.login)).toEqual(["greptile-apps", "cursor"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("an invalid regex is ignored without throwing", () => {
    configureReviewBots(["(", "Quality Score:\\s*(\\d)\\/5"]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(parseBotScore("example-reviewer", EXAMPLE_REVIEW)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("candidateTexts", () => {
  test("finds a bot's content wherever it posted it", () => {
    const detail = {
      reviews: { nodes: [review("cursor", "r1", CURSOR_REVIEW), review("example-reviewer", "r2", "")] },
      comments: { nodes: [comment("example-reviewer", "c1", EXAMPLE_REVIEW)] },
    };
    expect(candidateTexts(detail, "cursor")).toEqual([{ id: "r1", body: CURSOR_REVIEW, at: "2026-01-01T00:00:00Z" }]);
    expect(candidateTexts(detail, "example-reviewer")).toEqual([{ id: "c1", body: EXAMPLE_REVIEW, at: "2026-01-01T00:00:00Z" }]);
  });

  test("newest text comes first", () => {
    const detail = {
      reviews: { nodes: [] },
      comments: { nodes: [comment("example-reviewer", "old", "Quality Score: 2/5"), comment("example-reviewer", "new", EXAMPLE_REVIEW)] },
    };
    expect(candidateTexts(detail, "example-reviewer").map((t) => t.id)).toEqual(["new", "old"]);
  });
});

describe("reviewerLogins", () => {
  test("promotes a known bot that only left an issue comment", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    const detail = {
      reviews: { nodes: [review("greptile-apps", "r1", "Confidence Score: 4/5")] },
      comments: { nodes: [comment("example-reviewer", "c1", EXAMPLE_REVIEW)] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "theolundqvist" } }] },
    };
    expect(reviewerLogins(detail)).toEqual(new Set(["greptile-apps", "example-reviewer", "theolundqvist"]));
  });

  test("never promotes an arbitrary human commenter", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    const detail = {
      reviews: { nodes: [] },
      comments: { nodes: [comment("some-human", "c1", "looks good to me"), comment("example-reviewer", "c2", EXAMPLE_REVIEW)] },
      reviewRequests: { nodes: [] },
    };
    expect(reviewerLogins(detail)).toEqual(new Set(["example-reviewer"]));
  });
});

describe("aggregateReviewScore", () => {
  test("takes the lowest score across greptile and the other reviewers", () => {
    expect(aggregateReviewScore({ "example-reviewer": { score: 2, basis: null } }, 4)).toBe(2);
  });

  test("null-score reviewers are excluded, not treated as zero", () => {
    expect(aggregateReviewScore({ "example-reviewer": { score: 2, basis: null }, cursor: { score: null, basis: null } }, 4)).toBe(2);
  });

  test("greptile is passed in resolved and its raw entry is ignored to avoid double-counting", () => {
    expect(aggregateReviewScore({ "greptile-apps": { score: 4, basis: null }, "example-reviewer": { score: 3, basis: null } }, 5)).toBe(3);
  });

  test("no scored reviewer at all yields no score", () => {
    expect(aggregateReviewScore({ cursor: { score: null, basis: null } }, null)).toBe(null);
  });
});

describe("currentReviewerScores", () => {
  // scoring itself runs and persists via scoreReviewers elsewhere - this only reads back what's stored
  test("no db row yet means no entry at all, not a false 'no verdict'", () => {
    const detail = {
      reviews: { nodes: [] },
      comments: { nodes: [comment("example-reviewer", "c1", EXAMPLE_REVIEW)] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "theolundqvist" } }] },
      headRefOid: "head",
      commitList: { nodes: [] },
    };
    expect(currentReviewerScores(detail)).toEqual({});
  });
});

describe("reviewedShaAt", () => {
  const commit = (oid: string, committedDate: string) => ({ commit: { oid, committedDate } });
  const detail = {
    commitList: {
      nodes: [commit("a", "2026-01-01T00:00:00Z"), commit("b", "2026-01-02T00:00:00Z"), commit("c", "2026-01-03T00:00:00Z")],
    },
    headRefOid: "c",
  };

  test("picks the newest commit at or before the review time", () => {
    expect(reviewedShaAt(detail, "2026-01-02T12:00:00Z")).toBe("b");
  });

  test("a review after every commit maps to the head commit", () => {
    expect(reviewedShaAt(detail, "2026-01-09T00:00:00Z")).toBe("c");
  });

  test("a review predating all known commits is unknown, not stale", () => {
    expect(reviewedShaAt(detail, "2025-12-01T00:00:00Z")).toBe(null);
  });

  test("no commit history is unknown, not stale", () => {
    expect(reviewedShaAt({ commitList: { nodes: [] }, headRefOid: "c" }, "2026-01-02T00:00:00Z")).toBe(null);
  });

  test("a git committedDate with an author offset is compared by real instant, not string order", () => {
    // x committed at 06:00Z but stamped +02:00; string order would put it after the 07:00Z review and miss it
    const offsetDetail = {
      commitList: { nodes: [commit("w", "2026-07-06T00:00:00Z"), commit("x", "2026-07-06T08:00:00+02:00")] },
      headRefOid: "x",
    };
    expect(reviewedShaAt(offsetDetail, "2026-07-06T07:00:00Z")).toBe("x");
  });
});

describe("aggregateReviewStale", () => {
  test("a non-greptile reviewer whose stale score sets the min marks the aggregate stale", () => {
    expect(aggregateReviewStale({ "example-reviewer": { score: 2, basis: null, stale: true } }, 2)).toBe(true);
  });

  test("a stale reviewer above the min does not mark the aggregate stale", () => {
    expect(aggregateReviewStale({ "example-reviewer": { score: 4, basis: null, stale: true }, cursor: { score: 2, basis: null, stale: false } }, 2)).toBe(false);
  });

  test("greptile's own staleness is not counted here", () => {
    expect(aggregateReviewStale({ "greptile-apps": { score: 3, basis: null, stale: true } }, 3)).toBe(false);
  });

  test("no aggregate score is never stale", () => {
    expect(aggregateReviewStale({ "example-reviewer": { score: null, basis: null, stale: true } }, null)).toBe(false);
  });
});

describe("isValidLlmScoreResult", () => {
  test("accepts a null score with a null basis - the genuinely-unscored case", () => {
    expect(isValidLlmScoreResult({ score: null, basis: null })).toBe(true);
  });

  test("accepts a half-point score with a basis string", () => {
    expect(isValidLlmScoreResult({ score: 3.5, basis: "flags one real bug, otherwise clean" })).toBe(true);
  });

  test("rejects a non-half score", () => {
    expect(isValidLlmScoreResult({ score: 3.2, basis: "x" })).toBe(false);
  });

  test("rejects an out-of-range score", () => {
    expect(isValidLlmScoreResult({ score: 7, basis: "x" })).toBe(false);
  });

  test("rejects a basis that isn't a string when a score is present", () => {
    expect(isValidLlmScoreResult({ score: 4, basis: 4 })).toBe(false);
  });
});
