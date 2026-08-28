import { describe, expect, test } from "bun:test";
import {
  checkBucket,
  checkName,
  checkDuration,
  checkStatus,
  buildChecks,
  countChecks,
  summarizeChecks,
  sectionizeChecks,
  ciFixPrompt,
} from "./checks.js";

describe("checkBucket", () => {
  test("CheckRun by status then conclusion", () => {
    expect(checkBucket({ __typename: "CheckRun", status: "IN_PROGRESS" })).toBe("in_progress");
    expect(checkBucket({ __typename: "CheckRun", status: "QUEUED" })).toBe("queued");
    expect(checkBucket({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" })).toBe("success");
    expect(checkBucket({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" })).toBe("skipped");
    expect(checkBucket({ __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" })).toBe("neutral");
    expect(checkBucket({ __typename: "CheckRun", status: "COMPLETED", conclusion: "STALE" })).toBe("neutral");
    expect(checkBucket({ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" })).toBe("failing");
  });

  test("StatusContext by state", () => {
    expect(checkBucket({ state: "SUCCESS" })).toBe("success");
    expect(checkBucket({ state: "FAILURE" })).toBe("failing");
    expect(checkBucket({ state: "ERROR" })).toBe("failing");
    expect(checkBucket({ state: "EXPECTED" })).toBe("expected");
    expect(checkBucket({ state: "PENDING" })).toBe("queued");
  });
});

describe("checkName", () => {
  test("StatusContext uses context", () => {
    expect(checkName({ context: "ci/lint" })).toBe("ci/lint");
  });

  test("CheckRun prefixes workflow name when present", () => {
    expect(checkName({ __typename: "CheckRun", name: "build" })).toBe("build");
    expect(
      checkName({ __typename: "CheckRun", name: "build", checkSuite: { workflowRun: { workflow: { name: "CI" } } } }),
    ).toBe("CI / build");
  });
});

describe("checkDuration", () => {
  test("null when either bound missing or negative", () => {
    expect(checkDuration(null, "2026-01-01T00:00:10Z")).toBeNull();
    expect(checkDuration("2026-01-01T00:00:10Z", "2026-01-01T00:00:00Z")).toBeNull();
  });

  test("formats seconds, minutes, hours", () => {
    expect(checkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z")).toBe("45s");
    expect(checkDuration("2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z")).toBe("5m");
    expect(checkDuration("2026-01-01T00:00:00Z", "2026-01-01T01:30:00Z")).toBe("1h 30m");
  });
});

describe("checkStatus", () => {
  test("failing and success carry duration when known", () => {
    expect(checkStatus("failing", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).toBe("Failing after 30s");
    expect(checkStatus("failing", null, null)).toBe("Failing");
    expect(checkStatus("success", "2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z")).toBe("Successful in 30s");
  });

  test("in_progress without start is generic", () => {
    expect(checkStatus("in_progress", null, null)).toBe("In progress");
  });

  test("static labels", () => {
    expect(checkStatus("queued")).toBe("Queued");
    expect(checkStatus("expected")).toBe("Expected");
    expect(checkStatus("neutral")).toBe("Neutral");
    expect(checkStatus("skipped")).toBe("Skipped");
  });
});

describe("aggregation", () => {
  const rollup = {
    contexts: {
      nodes: [
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", isRequired: true, detailsUrl: "https://github.com/example/web/actions/runs/12/job/34" },
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { context: "vercel", state: "SUCCESS", targetUrl: "u2" },
        { context: "codecov", state: "PENDING" },
      ],
    },
  };

  test("buildChecks maps name, url, required, bucket, dot", () => {
    const checks = buildChecks(rollup);
    expect(checks).toHaveLength(4);
    expect(checks[0]).toMatchObject({ name: "build", url: "https://github.com/example/web/actions/runs/12/job/34", jobId: 34, required: true, bucket: "failing", dot: "bad" });
    expect(checks[2]).toMatchObject({ name: "vercel", url: "u2", required: false, bucket: "success", dot: "ok" });
  });

  test("buildChecks tolerates missing rollup", () => {
    expect(buildChecks(null)).toEqual([]);
  });

  test("countChecks tallies by bucket", () => {
    expect(countChecks(buildChecks(rollup))).toEqual({ failing: 1, success: 2, queued: 1 });
  });

  test("summarizeChecks follows CHECK_BUCKETS order", () => {
    expect(summarizeChecks({ success: 2, failing: 1, queued: 1 })).toBe("1 failing, 1 queued, 2 successful");
  });

  test("sectionizeChecks groups into ordered sections, dropping empties", () => {
    const sections = sectionizeChecks(buildChecks(rollup));
    expect(sections.map((s) => s.section)).toEqual(["failing", "pending", "successful"]);
    expect(sections[2].rows.map((r) => r.name)).toEqual(["test", "vercel"]);
  });

  test("a failing check is dropped once the same job is queued again — the old verdict is stale", () => {
    const rerun = {
      contexts: {
        nodes: [
          { __typename: "CheckRun", name: "Lint", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { workflow: { name: "Desktop CI" } } } },
          { __typename: "CheckRun", name: "Lint", status: "QUEUED", checkSuite: { workflowRun: { workflow: { name: "Desktop CI" } } } },
          { __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { workflow: { name: "Desktop CI" } } } },
        ],
      },
    };
    const checks = buildChecks(rerun);
    expect(checks.map((c) => [c.name, c.bucket])).toEqual([
      ["Desktop CI / Lint", "queued"],
      ["Desktop CI / Tests", "failing"],
    ]);
  });

  test("a same-named job in another workflow is a different check, so its failure stands", () => {
    const twoWorkflows = {
      contexts: {
        nodes: [
          { __typename: "CheckRun", name: "Lint", status: "COMPLETED", conclusion: "FAILURE", checkSuite: { workflowRun: { workflow: { name: "Desktop CI" } } } },
          { __typename: "CheckRun", name: "Lint", status: "QUEUED", checkSuite: { workflowRun: { workflow: { name: "Backend CI" } } } },
        ],
      },
    };
    expect(buildChecks(twoWorkflows).map((c) => c.bucket)).toEqual(["failing", "queued"]);
  });
});

describe("ciFixPrompt", () => {
  test("includes the PR, branch, failing checks, and exact log locations", () => {
    const prompt = ciFixPrompt({
      repo: "example-org/webapp",
      number: 42,
      branch: "moritz-fix-ci",
      checks: [
        { name: "CI / lint", required: true, status: "Failing after 30s", url: "https://github.com/example-org/webapp/actions/runs/123" },
        { name: "Vercel", required: false, status: "Failing", url: null },
      ],
    });

    expect(prompt).toContain("example-org/webapp PR #42");
    expect(prompt).toContain("Branch: moritz-fix-ci");
    expect(prompt).toContain("- CI / lint (required)");
    expect(prompt).toContain("https://github.com/example-org/webapp/actions/runs/123");
    expect(prompt).toContain("gh pr checks 42 --repo example-org/webapp");
  });
});
