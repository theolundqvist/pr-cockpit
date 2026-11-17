import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db, getSetting, setSetting } from "./db.ts";
import {
  aggregateReviewScore,
  aggregateReviewStale,
  candidateTexts,
  currentReviewerScores,
  parseBotScore,
  parseLabelledScore,
  reviewedShaAt,
  reviewBots,
  reviewerLogins,
} from "./reviewScore.ts";

const EXAMPLE_REVIEW = "Quality Score: 4/5";
const originalReviewBots = getSetting("review_bots");

function configureReviewBots(patterns: string[]): void {
  setSetting("review_bots", JSON.stringify([{ login: "example-reviewer", patterns }]));
}

afterEach(() => {
  if (originalReviewBots === null) db.query("DELETE FROM settings WHERE key = 'review_bots'").run();
  else setSetting("review_bots", originalReviewBots);
});

function comment(login: string, id: string, body: string, at = "2026-01-01T00:00:00Z") {
  return { id, author: { login }, body, createdAt: at };
}

function review(login: string, id: string, body: string, at = "2026-01-01T00:00:00Z") {
  return { id, author: { login }, state: "COMMENTED", body, submittedAt: at };
}

type ReviewFixture = {
  id: string;
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
};

type CommentFixture = {
  id: string;
  author: { login: string; __typename?: string };
  body: string;
  createdAt: string;
};

function detail(reviews: ReviewFixture[], comments: CommentFixture[]) {
  return {
    reviews: { nodes: reviews },
    comments: { nodes: comments },
    reviewRequests: { nodes: [] },
    headRefOid: "head",
    commitList: {
      nodes: [
        { commit: { oid: "old", committedDate: "2026-01-01T00:00:00Z" } },
        { commit: { oid: "head", committedDate: "2026-01-03T00:00:00Z" } },
      ],
    },
  };
}

describe("review bot registry", () => {
  test("configured regexes are authoritative", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("example-reviewer", EXAMPLE_REVIEW)).toBe(4);
    expect(parseBotScore("example-reviewer", "Confidence Score: 2/5")).toBe(null);
  });

  test("the first matching pattern wins", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5", "Legacy Score:\\s*(\\d)\\/5"]);
    expect(parseBotScore("example-reviewer", "Quality Score: 4/5\nLegacy Score: 2/5")).toBe(4);
  });

  test("an unknown login has no bot score", () => {
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

describe("labelled reviewer scores", () => {
  test("normalizes explicit supported scales to five", () => {
    expect(parseLabelledScore("Quality: 8/10")).toBe(4);
    expect(parseLabelledScore("Confidence rating = 90%")).toBe(4.5);
    expect(parseLabelledScore("quality score: 3.5/5")).toBe(3.5);
  });

  test("does not infer a score from prose, verdicts, or bare numbers", () => {
    expect(parseLabelledScore("Looks good, ship it. 10 files reviewed.")).toBe(null);
    expect(parseLabelledScore("APPROVED")).toBe(null);
    expect(parseLabelledScore("4/5")).toBe(null);
  });

  test("rejects values outside their labelled scale", () => {
    expect(parseLabelledScore("Quality score: 11/10")).toBe(null);
    expect(parseLabelledScore("Confidence: 120%")).toBe(null);
  });
});

describe("candidateTexts", () => {
  test("orders reviews and comments by their timestamps, independent of API array order", () => {
    const source = {
      reviews: { nodes: [review("person", "middle", EXAMPLE_REVIEW, "2026-01-02T00:00:00Z")] },
      comments: {
        nodes: [
          comment("person", "new", "Quality Score: 5/5", "2026-01-03T00:00:00Z"),
          comment("person", "old", "Quality Score: 2/5", "2026-01-01T00:00:00Z"),
        ],
      },
    };
    expect(candidateTexts(source, "person").map((text) => text.id)).toEqual(["new", "middle", "old"]);
  });
});

describe("reviewerLogins", () => {
  test("promotes known comment-only bots but not arbitrary commenters", () => {
    configureReviewBots(["Quality Score:\\s*(\\d)\\/5"]);
    const source = {
      reviews: { nodes: [review("human-reviewer", "r1", "Looks good")] },
      comments: { nodes: [comment("example-reviewer", "c1", EXAMPLE_REVIEW), comment("random-commenter", "c2", EXAMPLE_REVIEW)] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "requested-reviewer" } }] },
    };
    expect(reviewerLogins(source)).toEqual(new Set(["human-reviewer", "requested-reviewer", "example-reviewer"]));
  });

  test("parses explicit comment scores from GitHub bots without requiring custom patterns", () => {
    const source = detail([], [
      { ...comment("review-app", "app-score", "Quality score: 8/10"), author: { login: "review-app", __typename: "Bot" } },
      comment("cursor", "cursor-score", "Confidence: 90%"),
    ]);
    expect(currentReviewerScores(source)).toEqual({
      "review-app": { score: 4, stale: true },
      cursor: { score: 4.5, stale: true },
    });
  });
});

describe("currentReviewerScores", () => {
  test("uses the latest actual posted score and ignores newer scoreless prose", () => {
    const source = detail([
      review("human-reviewer", "scored", "Quality Score: 6/10", "2026-01-02T00:00:00Z"),
      review("human-reviewer", "follow-up", "Thanks, this is resolved.", "2026-01-04T00:00:00Z"),
    ], []);
    expect(currentReviewerScores(source)).toEqual({
      "human-reviewer": { score: 3, stale: true },
    });
  });

  test("an edited summary naming the current head is current, whenever it was first posted", () => {
    const head = "a".repeat(40);
    const summary = (sha: string) => comment("greptile-apps", "summary", `Confidence Score: 5/5\n\nLast reviewed commit: [fix](https://github.com/acme/app/commit/${sha})`);
    const source = (body: CommentFixture) => ({ ...detail([], [body]), headRefOid: head, commitList: { nodes: [
      { commit: { oid: "b".repeat(40), committedDate: "2026-01-01T00:00:00Z" } },
      { commit: { oid: head, committedDate: "2026-01-03T00:00:00Z" } },
    ] } });
    expect(currentReviewerScores(source(summary(head)))).toEqual({ "greptile-apps": { score: 5, stale: false } });
    expect(currentReviewerScores(source(summary("b".repeat(40))))).toEqual({ "greptile-apps": { score: 5, stale: true } });
  });

  test("scoreless reviewers have no score entry", () => {
    expect(currentReviewerScores(detail([review("human-reviewer", "plain", "Looks good to me.")], []))).toEqual({});
  });

  test("configured bots never fall through to the shared parser", () => {
    configureReviewBots(["Special Rating:\\s*(\\d)\\/5"]);
    expect(currentReviewerScores(detail([review("example-reviewer", "r1", EXAMPLE_REVIEW)], []))).toEqual({});
  });

  test("invalid configured patterns do not activate generic score parsing", () => {
    configureReviewBots(["("]);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(currentReviewerScores(detail([review("example-reviewer", "r1", EXAMPLE_REVIEW)], []))).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });

  test("legacy generated rows cannot override the posted body", () => {
    db.exec("CREATE TABLE review_scores (node_id TEXT PRIMARY KEY, score REAL)");
    try {
      db.query("INSERT INTO review_scores VALUES (?, ?)").run("r1", 1);
      expect(currentReviewerScores(detail([review("human-reviewer", "r1", "Quality Score: 5/5", "2026-01-04T00:00:00Z")], []))).toEqual({
        "human-reviewer": { score: 5, stale: false },
      });
    } finally {
      db.exec("DROP TABLE review_scores");
    }
  });
});

describe("reviewedShaAt", () => {
  const commit = (oid: string, committedDate: string) => ({ commit: { oid, committedDate } });
  const source = {
    commitList: {
      nodes: [commit("a", "2026-01-01T00:00:00Z"), commit("b", "2026-01-02T00:00:00Z"), commit("c", "2026-01-03T00:00:00Z")],
    },
    headRefOid: "c",
  };

  test("picks the newest commit at or before the review time", () => {
    expect(reviewedShaAt(source, "2026-01-02T12:00:00Z")).toBe("b");
  });

  test("unknown commit history cannot prove a score stale", () => {
    expect(reviewedShaAt({ commitList: { nodes: [] }, headRefOid: "c" }, "2026-01-02T00:00:00Z")).toBe(null);
    expect(reviewedShaAt(source, "2025-12-01T00:00:00Z")).toBe(null);
  });

  test("compares timestamp instants rather than timestamp strings", () => {
    const offsetSource = {
      commitList: { nodes: [commit("w", "2026-07-06T00:00:00Z"), commit("x", "2026-07-06T08:00:00+02:00")] },
      headRefOid: "x",
    };
    expect(reviewedShaAt(offsetSource, "2026-07-06T07:00:00Z")).toBe("x");
  });
});

describe("review score aggregation", () => {
  test("takes the lowest real score and excludes scoreless reviewers", () => {
    expect(aggregateReviewScore({
      "example-reviewer": { score: 2 },
      cursor: { score: null },
    }, 4)).toBe(2);
  });

  test("Greptile is supplied from its true confidence metadata and not double-counted", () => {
    expect(aggregateReviewScore({
      "greptile-apps": { score: 1 },
      "example-reviewer": { score: 3 },
    }, 5)).toBe(3);
  });

  test("no scored reviewer yields no score", () => {
    expect(aggregateReviewScore({ cursor: { score: null } }, null)).toBe(null);
  });

  test("only a stale non-Greptile minimum marks the aggregate stale", () => {
    expect(aggregateReviewStale({ "example-reviewer": { score: 2, stale: true } }, 2)).toBe(true);
    expect(aggregateReviewStale({ "example-reviewer": { score: 4, stale: true }, cursor: { score: 2, stale: false } }, 2)).toBe(false);
    expect(aggregateReviewStale({ "greptile-apps": { score: 3, stale: true } }, 3)).toBe(false);
  });
});
