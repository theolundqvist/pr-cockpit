import { expect, test } from "bun:test";
import { compactActions, deliveredCursor } from "./compactActions.ts";

test("a truncated relay page advances only through the last delivered marker", () => {
  const page = Array.from({ length: 500 }, (_, index) => ({ seq: index + 1 }));
  expect(deliveredCursor(700, page)).toBe(500);
  expect(deliveredCursor(700, [])).toBe(700);
});

test("workflow run and job fixtures preserve attempt and runner state", () => {
  expect(compactActions("workflow_run", { workflow_run: {
    id: 10,
    run_attempt: 2,
    head_sha: "abc",
    head_branch: "feature",
    name: "CI",
    status: "completed",
    conclusion: "failure",
    updated_at: "2026-08-24T10:00:00Z",
    html_url: "https://github.test/run/10",
  } })).toEqual({ run: {
    id: 10,
    attempt: 2,
    headSha: "abc",
    headBranch: "feature",
    workflowName: "CI",
    status: "completed",
    conclusion: "failure",
    eventAt: "2026-08-24T10:00:00Z",
    htmlUrl: "https://github.test/run/10",
  } });

  expect(compactActions("workflow_job", { workflow_job: {
    id: 11,
    run_id: 10,
    run_attempt: 2,
    head_sha: "abc",
    head_branch: "feature",
    workflow_name: "CI",
    name: "build",
    status: "in_progress",
    conclusion: null,
    started_at: "2026-08-24T10:01:00Z",
    completed_at: null,
    html_url: "https://github.test/job/11",
    runner_name: "runner-1",
    runner_group_name: "self-hosted",
    labels: ["arm64", "macOS"],
    steps: [{ name: "checkout", conclusion: "success" }],
  } })).toEqual({ job: {
    id: 11,
    runId: 10,
    attempt: 2,
    headSha: "abc",
    headBranch: "feature",
    workflowName: "CI",
    name: "build",
    status: "in_progress",
    conclusion: null,
    startedAt: "2026-08-24T10:01:00Z",
    completedAt: null,
    htmlUrl: "https://github.test/job/11",
    runnerName: "runner-1",
    runnerGroupName: "self-hosted",
    labels: ["arm64", "macOS"],
    failedStep: null,
  } });
});
