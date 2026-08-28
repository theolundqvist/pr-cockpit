import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ActionWorkflow,
  AssignableUser,
  FileContents,
  FileHistoryCommit,
  FileHistoryDiff,
  PaletteHit,
  PrDetail,
  PrIndexEntry,
  SearchHit,
  ViewerRepo,
  WorkflowRun,
} from "./github.ts";
import { needsMeRank } from "./rank.ts";
import { mockAvatarDataUri } from "./mockImages.ts";

export const isMockGithub = Bun.env.COCKPIT_MOCK === "1";

interface Snapshot {
  repo: string;
  viewer: string;
  capturedAt: string;
  details: PrDetail[];
  diffs: Record<string, string>;
  history: { repo: string; path: string; base: string; commits: FileHistoryCommit[] };
  historyDiffs: Record<string, FileHistoryDiff>;
  assets: Record<string, string>;
  fileContents: Record<string, string>;
}

const snapshotDir = isMockGithub ? Bun.env.COCKPIT_MOCK_DATA || null : null;
const snapshot: Snapshot | null = snapshotDir ? JSON.parse(readFileSync(`${snapshotDir}/snapshot.json`, "utf8")) : null;
const capturedDiffs = snapshot ? new Map(Object.entries(snapshot.diffs).map(([n, p]) => [Number(n), p] as const)) : null;
const capturedHistory = snapshot?.history ?? null;
const capturedRepo = snapshot?.repo ?? null;

export const MOCK_FIXTURE_CLOCK = snapshot?.capturedAt ?? "2026-07-15T10:00:00.000Z";

const REPO = "fixture/cockpit";
const ADMIN_REPO = "fixture/admin-cockpit";
const VIEWER = "theolundqvist";

const sha = (number: number, offset = 0): string => (number * 100 + offset).toString(16).padStart(40, "0");
const at = (minutesBefore: number): string => new Date(Date.parse(MOCK_FIXTURE_CLOCK) - minutesBefore * 60_000).toISOString();
const author = (login: string) => ({ login, avatarUrl: mockAvatarDataUri(login) });
const attachment = (name: string) => `https://github.com/user-attachments/assets/mock-${name}`;
const reactions = (count = 0) => count ? [{ content: "THUMBS_UP", count, viewerReacted: false }] : [];

type Check = NonNullable<PrDetail["lastCommit"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"]["nodes"][number];

function check(name: string, conclusion: string | null, required = true, status = "COMPLETED"): Check {
  const runId = name.split("").reduce((sum, char) => sum + char.charCodeAt(0), 1000);
  return {
    __typename: "CheckRun",
    name,
    status,
    conclusion,
    detailsUrl: conclusion === "FAILURE" ? `https://github.com/${REPO}/actions/runs/${runId}` : null,
    startedAt: at(55),
    completedAt: status === "COMPLETED" ? at(50) : null,
    isRequired: required,
    checkSuite: { workflowRun: { databaseId: runId, workflow: { name: "CI" } } },
  };
}

const passingChecks = [check("lint", "SUCCESS"), check("unit tests", "SUCCESS"), check("build", "SUCCESS")];

function file(path: string, additions = 12, deletions = 3) {
  return { path, additions, deletions };
}

function baseDetail(number: number, overrides: Partial<PrDetail> = {}): PrDetail {
  const head = sha(number);
  return {
    id: `PR_fixture_${number}`,
    title: `Fixture pull request ${number}`,
    number,
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    isDraft: false,
    author: author(number % 3 === 0 ? "octocat" : VIEWER),
    baseRefName: "main",
    baseRefOid: sha(number, 9),
    headRefName: `fixture/pr-${number}`,
    headRefOid: head,
    body: "A deterministic pull request used by the headless screenshot harness.",
    additions: 36,
    deletions: 9,
    changedFiles: 3,
    files: { totalCount: 3, nodes: [file("src/flight.ts"), file("src/flight.test.ts", 18, 4), file("README.md", 6, 2)] },
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    viewerCanMergeAsAdmin: false,
    autoMergeRequest: null,
    reviewDecision: "APPROVED",
    updatedAt: at(number - 100),
    url: `https://github.com/${REPO}/pull/${number}`,
    commitCount: { totalCount: 2 },
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: passingChecks } } } }] },
    commitList: {
      nodes: [
        { commit: { oid: sha(number, 1), abbreviatedOid: sha(number, 1).slice(0, 7), messageHeadline: "Lay the groundwork", committedDate: at(180), additions: 128, deletions: 14, author: { name: "Theodor", user: author(VIEWER) }, parents: { nodes: [{ oid: sha(number, 9) }] } } },
        { commit: { oid: head, abbreviatedOid: head.slice(0, 7), messageHeadline: "Finish the fixture", committedDate: at(60), additions: 37, deletions: 52, author: { name: "Theodor", user: author(VIEWER) }, parents: { nodes: [{ oid: sha(number, 1) }] } } },
      ],
    },
    labels: { nodes: [{ name: "agentic" }, { name: "ui" }] },
    assignees: { nodes: [{ login: VIEWER }] },
    reviewRequests: { nodes: [] },
    reviews: {
      nodes: [{ id: `review-${number}`, author: author("reviewer-one"), state: "APPROVED", body: "Looks solid. The state transitions are easy to follow.", submittedAt: at(45), reactions: reactions(1) }],
    },
    comments: {
      nodes: [
        { id: `comment-${number}-1`, author: author("reviewer-one"), body: "I ran this locally and the behavior matches the description.", createdAt: at(42), reactions: [] },
        { id: `comment-${number}-2`, author: author("greptile-apps"), body: `## Greptile summary\n\nConfidence Score: 5/5\n\nLast reviewed commit: https://github.com/${REPO}/commit/${head}`, createdAt: at(35), reactions: [] },
      ],
    },
    reviewThreads: {
      nodes: [{ id: `thread-${number}-resolved`, isResolved: true, isOutdated: false, path: "src/flight.ts", line: 14, diffSide: "RIGHT", comments: { nodes: [{ databaseId: number * 1000 + 1, diffHunk: "@@ -10,3 +10,5 @@", author: author("reviewer-one"), body: "Could this name describe the domain role?", createdAt: at(40), reactions: [] }, { databaseId: number * 1000 + 2, diffHunk: "@@ -10,3 +10,5 @@", author: author(VIEWER), body: "Renamed it to make the scheduling role explicit.", createdAt: at(38), reactions: reactions(1) }] } }],
    },
    reactions: reactions(2),
    viewerLogin: VIEWER,
    viewerIsAuthor: number % 3 !== 0,
    viewerReviewRequested: false,
    viewerReviewState: null,
    ...overrides,
  };
}

const longThreadBody = isMockGithub ? Array.from({ length: 16 }, (_, i) => `Paragraph ${i + 1}: this intentionally long review discussion exercises wrapping, scrolling, code references, and dense reviewer context without relying on network content.`).join("\n\n") : "";
const largeFiles = isMockGithub ? Array.from({ length: 55 }, (_, i) => file(`src/generated/module-${String(i + 1).padStart(2, "0")}.ts`, 20 + i, i % 5)) : [];
const details: Record<string, PrDetail> = {};

function addDetail(repo: string, detail: PrDetail): void {
  detail.url = `https://github.com/${repo}/pull/${detail.number}`;
  details[`${repo}#${detail.number}`] = detail;
}

if (isMockGithub) addDetail(REPO, baseDetail(101, {
  title: "Ship deterministic screenshot fixtures for every PR Cockpit view",
  body: `This green PR is the baseline conversation and files fixture.\n\nThe inbox now renders every state at a glance:\n\n![Inbox overview](${attachment("inbox-overview")})`,
  comments: {
    nodes: [
      { id: "comment-101-1", author: author("reviewer-one"), body: `Ran it locally, the detail view matches:\n\n![Detail view](${attachment("detail-view")})`, createdAt: at(42), reactions: reactions(2) },
      { id: "comment-101-2", author: author("greptile-apps"), body: `## Greptile summary\n\nConfidence Score: 5/5\n\nLast reviewed commit: https://github.com/${REPO}/commit/${sha(101)}`, createdAt: at(35), reactions: [] },
    ],
  },
  updatedAt: at(12),
}));

if (isMockGithub) addDetail(REPO, baseDetail(102, {
  title: "Require a human approval before launching the migration",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: VIEWER, avatarUrl: mockAvatarDataUri(VIEWER) } }] },
  reviews: { nodes: [] },
  comments: { nodes: [{ id: "comment-102-1", author: author("release-manager"), body: "Holding this until the release captain approves the rollout window.", createdAt: at(80), reactions: [] }] },
  viewerIsAuthor: false,
  viewerReviewRequested: true,
  updatedAt: at(18),
}));

if (isMockGithub) addDetail(REPO, baseDetail(103, {
  title: "Resolve conflicting navigation state from the base branch",
  mergeable: "CONFLICTING",
  mergeStateStatus: "DIRTY",
  reviewDecision: "CHANGES_REQUESTED",
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [check("merge queue", "FAILURE")] } } } }] },
  reviewThreads: { nodes: [{ id: "thread-103-long", isResolved: false, isOutdated: false, path: "ui/navigation.ts", line: 88, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 103001, diffHunk: "@@ -74,6 +83,18 @@", author: author("reviewer-two"), body: longThreadBody, createdAt: at(33), reactions: reactions(3) }, { databaseId: 103002, diffHunk: "@@ -74,6 +83,18 @@", author: author(VIEWER), body: "Agreed. The conflict needs to be resolved at the state boundary, not patched in the renderer.", createdAt: at(20), reactions: [] }] } }] },
  reviews: { nodes: [{ id: "review-103", author: author("reviewer-two"), state: "CHANGES_REQUESTED", body: `The navigation state conflict is still observable when switching tabs:\n\n![Conflicting navigation](${attachment("navigation-conflict")})`, submittedAt: at(34), reactions: [] }] },
  updatedAt: at(20),
}));

if (isMockGithub) addDetail(REPO, baseDetail(104, {
  title: "Expose optional telemetry without blocking the required build",
  mergeStateStatus: "UNSTABLE",
  reviewDecision: "CHANGES_REQUESTED",
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [...passingChecks, check("preview deploy", "FAILURE", false), check("visual snapshot", "NEUTRAL", false)] } } } }] },
  reviews: { nodes: [{ id: "review-104", author: author("reviewer-three"), state: "CHANGES_REQUESTED", body: "Please confirm the non-required failure does not hide a production dependency.", submittedAt: at(25), reactions: [] }] },
  updatedAt: at(25),
}));

if (isMockGithub) addDetail(REPO, baseDetail(105, {
  title: "Draft the new command palette information architecture",
  isDraft: true,
  mergeable: "UNKNOWN",
  mergeStateStatus: "DRAFT",
  reviewDecision: null,
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [check("lint", null, true, "IN_PROGRESS"), check("browser tests", null, true, "QUEUED")] } } } }] },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", name: "Design Systems" } }] },
  reviews: { nodes: [{ id: "review-105", author: author(VIEWER), state: "PENDING", body: "Unsaved pending review notes", submittedAt: "", reactions: [] }] },
  updatedAt: at(30),
}));

if (isMockGithub) addDetail(REPO, baseDetail(106, {
  title: "Retire the legacy polling path after webhook rollout",
  state: "MERGED",
  mergeable: "UNKNOWN",
  mergeStateStatus: "UNKNOWN",
  updatedAt: at(90),
}));

if (isMockGithub) addDetail(REPO, baseDetail(107, {
  title: "Regenerate the complete API client and bundled binary assets",
  additions: 4800,
  deletions: 875,
  changedFiles: 58,
  files: { totalCount: 58, nodes: [...largeFiles, file("src/generated/client.ts", 3700, 800), file("assets/cockpit.bin", 0, 0), file("docs/new-name.md", 10, 10)] },
  commitCount: { totalCount: 37 },
  updatedAt: at(40),
}));

const hugeDescription = isMockGithub ? `# Screenshot harness architecture

This fixture proves that long markdown stays readable and useful.

| State | Expected behavior | Screenshot signal |
| --- | --- | --- |
| clean | merge is available | green gate |
| blocked | approval is required | blocked banner |
| unstable | optional check failed | detailed check list |

## Example

\`\`\`ts
const scenarios = fixtures
  .filter((fixture) => fixture.visible)
  .map(({ route, theme }) => ({ route, theme }));
\`\`\`

![Deterministic fixture](${attachment("harness-architecture")})

> A screenshot is only useful when the state that produced it is reproducible.

${Array.from({ length: 12 }, (_, i) => `### Decision ${i + 1}\n\nThe fixture owns its state, uses a fixed clock, and never reaches an external service. This paragraph deliberately wraps across several lines at normal detail widths.`).join("\n\n")}` : "";

if (isMockGithub) addDetail(REPO, baseDetail(108, {
  title: "Document every state in one deliberately enormous markdown description that wraps across the detail view",
  body: hugeDescription,
  comments: { nodes: [] },
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  updatedAt: at(45),
}));

if (isMockGithub) addDetail(REPO, baseDetail(109, {
  title: "Show failed optimistic mutations with recovery controls",
  reviewThreads: { nodes: [{ id: "thread-109", isResolved: false, isOutdated: false, path: "server/mutations.ts", line: 72, diffSide: "RIGHT", comments: { nodes: [{ databaseId: 109001, diffHunk: "@@ -68,5 +68,8 @@", author: author("reviewer-one"), body: "Please make the retry path visible when the write fails.", createdAt: at(16), reactions: [] }] } }] },
  updatedAt: at(8),
}));

if (isMockGithub) addDetail(REPO, baseDetail(110, {
  title: "Exercise agent run history, live state, logs, and terminal outcomes",
  mergeStateStatus: "BEHIND",
  updatedAt: at(50),
}));

if (isMockGithub) addDetail(REPO, baseDetail(111, {
  title: "Archived closed PR retained for historical navigation",
  state: "CLOSED",
  mergeable: "UNKNOWN",
  mergeStateStatus: "UNKNOWN",
  body: "This row is intentionally archived and closed.",
  updatedAt: at(1_440),
}));

if (isMockGithub) addDetail(ADMIN_REPO, baseDetail(112, {
  title: "Bypass a pure approval rule with the configured admin path",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  reviews: { nodes: [] },
  updatedAt: at(65),
}));

if (isMockGithub) addDetail(REPO, baseDetail(113, {
  title: "Empty pull request with no changed files and no checks",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  files: { totalCount: 0, nodes: [] },
  lastCommit: { nodes: [{ commit: { statusCheckRollup: null } }] },
  commitCount: { totalCount: 1 },
  body: "",
  comments: { nodes: [] },
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  reactions: [],
  updatedAt: at(75),
}));

if (isMockGithub) addDetail(REPO, baseDetail(115, {
  title: "Keep review activity compact and readable",
  reviews: {
    nodes: [
      { id: "review-115-1", author: author("moritzcodes"), state: "APPROVED", body: "", submittedAt: at(72), reactions: [] },
      { id: "review-115-2", author: author("moritzcodes"), state: "APPROVED", body: "", submittedAt: at(68), reactions: [] },
    ],
  },
  comments: {
    nodes: [{
      id: "comment-115-greptile",
      author: author("greptile-apps"),
      body: `## Greptile Summary

Adds a narrowly scoped egress firewall rule allowing clients in the service subnet to reach HTTPS destinations in that subnet.

- Adds an allow rule at priority 1130 for TCP 443.
- Restricts both source and destination to the service subnet.
- Preserves the terminal deny-all rule for other destinations and ports.

**Confidence Score: 5/5**

The pull request appears safe to merge; no concrete changed-code failure was identified.`,
      createdAt: at(60),
      reactions: [],
    }],
  },
  reviewThreads: { nodes: [] },
  updatedAt: at(55),
}));

if (isMockGithub) addDetail(REPO, baseDetail(114, {
  title: "Wait in the queue while required integration checks start",
  mergeStateStatus: "BEHIND",
  reviewDecision: "REVIEW_REQUIRED",
  lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes: [check("integration", null, true, "QUEUED"), check("browser", null, true, "IN_PROGRESS")] } } } }] },
  reviews: { nodes: [] },
  updatedAt: at(70),
}));

function ciStatus(detail: PrDetail): string {
  return detail.lastCommit.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE";
}

function unresolvedCount(detail: PrDetail): number {
  return detail.reviewThreads.nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length;
}

function prPatch(number: number): string {
  if (capturedDiffs) return capturedDiffs.get(number) ?? "";
  if (number === 107) {
    const generated = Array.from({ length: 700 }, (_, i) => `+export const endpoint${i + 1} = ${JSON.stringify(`/api/fixture/${i + 1}`)};`).join("\n");
    const modules = largeFiles.map(({ path }, i) => `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..${(i + 1).toString(16).padStart(7, "0")}
--- /dev/null
+++ b/${path}
@@ -0,0 +1,2 @@
+export const moduleNumber = ${i + 1};
+export const fixture = "screenshot-harness";
`).join("");
    return `${modules}diff --git a/src/generated/client.ts b/src/generated/client.ts
index 1111111..2222222 100644
--- a/src/generated/client.ts
+++ b/src/generated/client.ts
@@ -1,1 +1,701 @@
-export const oldClient = true;
+export const generatedClient = true;
${generated}
diff --git a/assets/cockpit.bin b/assets/cockpit.bin
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/assets/cockpit.bin differ
diff --git a/docs/old-name.md b/docs/new-name.md
similarity index 100%
rename from docs/old-name.md
rename to docs/new-name.md
`;
  }
  if (number === 113) return "";
  return `diff --git a/src/flight.ts b/src/flight.ts
index 1111111..2222222 100644
--- a/src/flight.ts
+++ b/src/flight.ts
@@ -1,5 +1,9 @@
 export function launch() {
-  return "manual";
+  const state = "deterministic";
+  return state;
 }
+
+export const fixtureNumber = ${number};
diff --git a/src/flight.test.ts b/src/flight.test.ts
index 3333333..4444444 100644
--- a/src/flight.test.ts
+++ b/src/flight.test.ts
@@ -1,2 +1,5 @@
+import { expect, test } from "bun:test";
+import { launch } from "./flight";
+
+test("launches deterministically", () => expect(launch()).toBe("deterministic"));
diff --git a/README.md b/README.md
index 5555555..6666666 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,4 @@
 # PR Cockpit
+
+Deterministic fixture ${number}.
`;
}

const history: FileHistoryCommit[] = isMockGithub ? [
  { sha: sha(101, 5), subject: "Refine deterministic launch state (#98)", author: VIEWER, date: at(2_880), prNumber: 98 },
  { sha: sha(101, 4), subject: "Extract flight scheduling", author: "reviewer-one", date: at(10_080), prNumber: null },
  { sha: sha(101, 3), subject: "Add the first cockpit flight", author: "octocat", date: at(43_200), prNumber: null },
] : [];

const historyDiffs = new Map<string, FileHistoryDiff>(isMockGithub ? [
  [sha(101, 5), { patch: "@@ -1,4 +1,5 @@\n export function launch() {\n-  return mode;\n+  return deterministicMode;\n }", additions: 1, deletions: 1, status: "modified", previous_filename: null }],
  [sha(101, 4), { patch: "@@ -0,0 +1,4 @@\n+export function launch() {\n+  return mode;\n+}", additions: 4, deletions: 0, status: "added", previous_filename: null }],
  [sha(101, 3), { patch: "@@ -1 +1 @@\n-export const takeoff = true;\n+export const launch = true;", additions: 1, deletions: 1, status: "renamed", previous_filename: "src/takeoff.ts" }],
] : []);

if (snapshot) {
  for (const key of Object.keys(details)) delete details[key];
  for (const detail of snapshot.details) details[`${snapshot.repo}#${detail.number}`] = detail;
  history.length = 0;
  history.push(...snapshot.history.commits);
  historyDiffs.clear();
  for (const [commitSha, diff] of Object.entries(snapshot.historyDiffs)) historyDiffs.set(commitSha, diff);
}

function fixtureDetail(repo: string, number: number): PrDetail {
  const detail = details[`${repo}#${number}`];
  if (!detail) throw new Error(`no mock fixture for ${repo}#${number}`);
  return structuredClone(detail);
}

interface RunJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface RunJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps: RunJobStep[];
}

function fixtureRunHeadSha(repo: string, runId: number): string {
  for (const [key, detail] of Object.entries(details)) {
    if (!key.startsWith(`${repo}#`)) continue;
    const checks = detail.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    const matches = checks.some((candidate) =>
      candidate.__typename === "CheckRun"
      && candidate.conclusion === "FAILURE"
      && candidate.checkSuite?.workflowRun?.databaseId === runId
    );
    if (matches) return sha(detail.number);
  }
  throw new Error(`no mock run jobs for ${repo}:${runId}`);
}
function fixtureWorkflowRun(repo: string, runId: number): WorkflowRun {
  return {
    id: runId,
    run_attempt: 1,
    head_sha: fixtureRunHeadSha(repo, runId),
    head_branch: "fixture",
    name: "CI",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "failure",
    updated_at: at(43),
    html_url: `https://github.com/${repo}/actions/runs/${runId}`,
  };
}


function fixtureRunJobs(repo: string, runId: number): RunJob[] {
  const headSha = fixtureRunHeadSha(repo, runId);
  const job = (offset: number, name: string, conclusion: string, started: number, completed: number, steps: RunJobStep[]): RunJob => {
    const id = runId * 10 + offset;
    return {
      id,
      run_id: runId,
      run_attempt: 1,
      head_sha: headSha,
      name,
      status: "completed",
      conclusion,
      started_at: at(started),
      completed_at: at(completed),
      html_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${id}`,
      steps,
    };
  };
  return [
    job(1, "Lint", "success", 49, 47, [
      { name: "Set up job", number: 1, status: "completed", conclusion: "success", started_at: at(49), completed_at: at(48) },
      { name: "Run lint", number: 2, status: "completed", conclusion: "success", started_at: at(48), completed_at: at(47) },
    ]),
    job(2, "Unit tests", "failure", 47, 44, [
      { name: "Set up job", number: 1, status: "completed", conclusion: "success", started_at: at(47), completed_at: at(46) },
      { name: "Run tests", number: 2, status: "completed", conclusion: "failure", started_at: at(46), completed_at: at(44) },
    ]),
    job(3, "Browser tests", "cancelled", 46, 43, [
      { name: "Set up job", number: 1, status: "completed", conclusion: "success", started_at: at(46), completed_at: at(45) },
      { name: "Run browser tests", number: 2, status: "completed", conclusion: "cancelled", started_at: at(45), completed_at: at(43) },
    ]),
  ];
}

function fixtureJobLog(repo: string, jobId: number): string {
  const runId = Math.floor(jobId / 10);
  if (!fixtureRunJobs(repo, runId).some((job) => job.id === jobId)) throw new Error(`no mock job log for ${repo}:${jobId}`);
  const lines = [
    `Runner version: '2.325.0' for job ${jobId}`,
    "##[group]Operating System",
    "macOS",
    "15.5",
    "24F74",
    "##[endgroup]",
    "##[group]Runner Image",
    "Image: macos-15-arm64",
    "Version: 20260713.1",
    "Included Software: https://github.com/actions/runner-images",
    "##[endgroup]",
    "Prepare workflow directory",
    "Prepare all required actions",
    "Getting action download info",
    "Download action repository 'actions/checkout@v4'",
    "Complete job name: Unit tests",
    "##[group]Run actions/checkout@v4",
    "Syncing repository: fixture/cockpit",
    "Getting Git version info",
    "Temporarily overriding HOME",
    "Adding repository directory to the temporary git global config",
    "Disabling automatic garbage collection",
    "Setting up auth",
    "Fetching the repository",
    "Determining the checkout info",
    "Checking out the ref",
    "##[endgroup]",
    "##[group]Run bun test src/flight.test.ts",
    "$ bun test src/flight.test.ts",
    "bun test v1.2.18",
    "",
    "src/flight.test.ts:",
    "✓ takes off deterministically [2.00ms]",
    "\u001b[31mFAIL src/flight.test.ts > lands the plane\u001b[0m",
    "expect(received).toBe(expected)",
    "Expected: \"landed\"",
    "Received: \"circling\"",
    "##[error]Process completed with exit code 1",
    "##[endgroup]",
    "Cleaning up orphan processes",
  ];
  return lines.map((line, index) => `${new Date(Date.parse(at(50)) + index * 1_000).toISOString().replace("Z", "0000Z")} ${line}`).join("\n");
}
const failedJobReruns: Array<{ repo: string; runId: number }> = [];


export const mockGithub = isMockGithub ? {
  viewerLogin: snapshot?.viewer ?? VIEWER,
  localBranch: (repo: string): string | null => capturedRepo ? null : repo === REPO ? "fixture/pr-101" : null,
  searchOpenPrs: (repos: string[]): SearchHit[] => Object.entries(details)
    .filter(([key, detail]) => detail.state === "OPEN" && repos.some((repo) => key.startsWith(`${repo}#`)))
    .map(([key, detail]) => ({ repo: key.split("#")[0]!, number: detail.number, title: detail.title, updatedAt: detail.updatedAt, headRefOid: detail.headRefOid, ciState: ciStatus(detail) })),
  searchPrs: (repos: string[], q: string): PaletteHit[] => Object.entries(details)
    .filter(([key, detail]) => repos.some((repo) => key.startsWith(`${repo}#`)) && detail.title.toLowerCase().includes(q.toLowerCase()))
    .map(([key, detail]) => ({ repo: key.split("#")[0]!, number: detail.number, title: detail.title, state: detail.state })),
  lookupPr: (repo: string, number: number): PaletteHit | null => {
    const detail = details[`${repo}#${number}`];
    return detail ? { repo, number, title: detail.title, state: detail.state } : null;
  },
  searchRecentPrs: (repo: string): PrIndexEntry[] => Object.entries(details)
    .filter(([key]) => key.startsWith(`${repo}#`))
    .map(([key, detail]) => ({
      repo: key.split("#")[0]!,
      number: detail.number,
      title: detail.title,
      state: detail.state,
      isDraft: detail.isDraft,
      author: detail.author?.login ?? "unknown",
      updatedAt: detail.updatedAt,
      mergedAt: detail.mergedAt,
      closedAt: detail.closedAt,
    })),
  viewerRepos: (): ViewerRepo[] => capturedRepo
    ? [{ nameWithOwner: capturedRepo, pushedAt: MOCK_FIXTURE_CLOCK, isPrivate: false }]
    : [
        { nameWithOwner: REPO, pushedAt: at(5), isPrivate: true },
        { nameWithOwner: ADMIN_REPO, pushedAt: at(60), isPrivate: true },
      ],
  detail: fixtureDetail,
  setAutoMerge: async (pullRequestId: string, method: string | null): Promise<void> => {
    await Bun.sleep(300);
    const detail = Object.values(details).find((candidate) => candidate.id === pullRequestId);
    if (!detail) throw new Error(`no mock PR ${pullRequestId}`);
    detail.autoMergeRequest = method
      ? { mergeMethod: method.toUpperCase(), enabledBy: { login: snapshot?.viewer ?? VIEWER } }
      : null;
  },
  conflictFiles: (_repo: string, number: number): string[] => !capturedRepo && number === 103
    ? ["ui/navigation.ts", "ui/src/lib/router/state.ts", "server/navigation.ts"]
    : [],
  diff: (repo: string, number: number): string => {
    fixtureDetail(repo, number);
    return prPatch(number);
  },
  runJobs: fixtureRunJobs,
  workflowRun: fixtureWorkflowRun,
  actionWorkflows: (_repo: string): ActionWorkflow[] => [
    { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
    { id: 2, name: "Release Backend", path: ".github/workflows/release.yml", state: "active" },
    { id: 3, name: "Tag Staging Release", path: ".github/workflows/tag.yml", state: "active" },
  ],
  rerunFailedJobs: async (repo: string, runId: number): Promise<void> => {
    failedJobReruns.push({ repo, runId });
    await Bun.sleep(350);
  },
  failedJobRerunCalls: (): Array<{ repo: string; runId: number }> => structuredClone(failedJobReruns),
  jobLog: fixtureJobLog,
  fileHistory: (repo: string, path: string, base: string): FileHistoryCommit[] => {
    const key = capturedHistory ?? { repo: REPO, path: "src/flight.ts", base: "main" };
    if (repo !== key.repo || path !== key.path || base !== key.base) throw new Error(`no mock file history for ${repo}:${base}:${path}`);
    return structuredClone(history);
  },
  fileHistoryDiff: (repo: string, commitSha: string, path: string): FileHistoryDiff | null => {
    const key = capturedHistory ?? { repo: REPO, path: "src/flight.ts" };
    if (repo !== key.repo || path !== key.path || !historyDiffs.has(commitSha)) throw new Error(`no mock file history diff for ${repo}:${commitSha}:${path}`);
    return structuredClone(historyDiffs.get(commitSha)!);
  },
  fileContents: (repo: string, path: string, fileSha: string): FileContents => {
    if (capturedRepo) {
      if (repo !== capturedRepo) throw new Error(`no mock file contents for ${repo}:${fileSha}:${path}`);
      const content = snapshot?.fileContents[`${fileSha}:${path}`];
      return content === undefined ? { tooLarge: true } : { content };
    }
    const detail = Object.entries(details).find(([key, candidate]) => key.startsWith(`${repo}#`) && candidate.headRefOid === fileSha)?.[1];
    if (!detail?.files.nodes.some((candidate) => candidate.path === path)) throw new Error(`no mock file contents for ${repo}:${fileSha}:${path}`);
    return path.endsWith(".bin") ? { tooLarge: true } : { content: `export const fixturePath = ${JSON.stringify(path)};\nexport const capturedAt = ${JSON.stringify(MOCK_FIXTURE_CLOCK)};\n` };
  },
  assignableUsers: (repo: string): AssignableUser[] => {
    if (capturedRepo) return [];
    if (repo !== REPO && repo !== ADMIN_REPO) throw new Error(`no mock assignable users for ${repo}`);
    return [{ id: "user-viewer", ...author(VIEWER) }, { id: "user-reviewer-one", ...author("reviewer-one") }, { id: "user-reviewer-two", ...author("reviewer-two") }];
  },
  image: (url: string): Uint8Array | null => {
    const name = snapshot?.assets[url];
    if (!name) return null;
    try {
      return new Uint8Array(readFileSync(`${snapshotDir}/blobs/${name}`));
    } catch {
      return null;
    }
  },
} : null;

export function installMockNetworkGuard(): void {
  if (!isMockGithub) return;
  globalThis.fetch = ((input: Request | URL | string, _init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0);
    throw new Error(`COCKPIT_MOCK blocked outbound request: ${url.href}`);
  }) as typeof fetch;
}

export function seedMockDatabase(db: Database, dataDir: string): void {
  if (!isMockGithub) return;
  const insertedAt = "2999-01-01T00:00:00.000Z";
  db.exec("DELETE FROM prs; DELETE FROM diffs; DELETE FROM file_contents; DELETE FROM mutations; DELETE FROM pr_index; DELETE FROM archived_prs; DELETE FROM pr_rank; DELETE FROM pr_detail_cache; DELETE FROM repo_users; DELETE FROM fixer_agents; DELETE FROM agent_runs;");
  const insertPr = db.prepare(`
    INSERT INTO prs (repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha, updated_at, additions, deletions, changed_files, commit_count, mergeable, merge_state_status, auto_merge_enabled, viewer_is_author, viewer_review_requested, viewer_review_state, ci_status, review_decision, unresolved_count, needs_me_rank, greptile_confidence, greptile_reviewed_sha, greptile_unresolved_count, detail_json, fetched_at)
    VALUES ($repo, $number, $state, $is_draft, $title, $author, $base_ref, $head_ref, $head_sha, $updated_at, $additions, $deletions, $changed_files, $commit_count, $mergeable, $merge_state_status, $auto_merge_enabled, $viewer_is_author, $viewer_review_requested, $viewer_review_state, $ci_status, $review_decision, $unresolved_count, $needs_me_rank, $greptile_confidence, $greptile_reviewed_sha, $greptile_unresolved_count, $detail_json, $fetched_at)
  `);
  const insertIndex = db.prepare("INSERT INTO pr_index (repo, number, title, state, is_draft, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertDiff = db.prepare("INSERT INTO diffs (head_sha, patch, fetched_at) VALUES (?, ?, datetime('now'))");
  const seed = db.transaction(() => {
    for (const [key, detail] of Object.entries(details)) {
      const repo = key.split("#")[0]!;
      const unresolved = unresolvedCount(detail);
      const greptile = detail.comments.nodes.findLast((comment) => comment.author?.login === "greptile-apps");
      const confidence = greptile ? 5 : null;
      const rank = snapshot
        ? needsMeRank({ ciStatus: ciStatus(detail), reviewDecision: detail.reviewDecision, unresolvedCount: unresolved, mergeable: detail.mergeable, isDraft: detail.isDraft })
        : unresolved > 0 ? 1 : ciStatus(detail) === "FAILURE" ? 0 : 2;
      insertPr.run({
        $repo: repo,
        $number: detail.number,
        $state: detail.state,
        $is_draft: detail.isDraft ? 1 : 0,
        $title: detail.title,
        $author: detail.author?.login ?? "unknown",
        $base_ref: detail.baseRefName,
        $head_ref: detail.headRefName,
        $head_sha: detail.headRefOid,
        $updated_at: detail.updatedAt,
        $additions: detail.additions,
        $deletions: detail.deletions,
        $changed_files: detail.changedFiles,
        $commit_count: detail.commitCount.totalCount,
        $mergeable: detail.mergeable,
        $merge_state_status: detail.mergeStateStatus,
        $auto_merge_enabled: detail.number === 110 ? 1 : 0,
        $viewer_is_author: detail.viewerIsAuthor ? 1 : 0,
        $viewer_review_requested: detail.viewerReviewRequested ? 1 : 0,
        $viewer_review_state: detail.viewerReviewState,
        $ci_status: ciStatus(detail),
        $review_decision: detail.reviewDecision,
        $unresolved_count: unresolved,
        $needs_me_rank: rank,
        $greptile_confidence: confidence,
        $greptile_reviewed_sha: confidence ? detail.headRefOid : null,
        $greptile_unresolved_count: 0,
        $detail_json: JSON.stringify(detail),
        $fetched_at: insertedAt,
      });
      insertIndex.run(repo, detail.number, detail.title, detail.state, detail.isDraft ? 1 : 0, detail.author?.login ?? "unknown", detail.updatedAt);
      insertDiff.run(detail.headRefOid, prPatch(detail.number));
    }
  });
  seed();

  if (snapshot) {
    const setSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    setSetting.run("repos", capturedRepo!);
    setSetting.run("default_repo", capturedRepo!);
    setSetting.run("relay_url", "");
    return;
  }

  db.prepare("INSERT INTO archived_prs (repo, number, archived_at) VALUES (?, ?, ?)").run(REPO, 111, at(1_400));
  db.prepare("INSERT INTO pr_rank (repo, number, position) VALUES (?, ?, ?)").run(REPO, 101, 10);
  db.prepare("INSERT INTO pr_rank (repo, number, position) VALUES (?, ?, ?)").run(REPO, 109, 20);
  db.prepare("INSERT INTO mutations (repo, number, kind, payload_json, state, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(REPO, 109, "reply-to-thread", JSON.stringify({ kind: "reply-to-thread", rootCommentId: 109001, body: "This reply failed and can be retried or discarded." }), "failed", "fixture: GitHub rejected the review reply", at(4));
  db.prepare("INSERT INTO mutations (repo, number, kind, payload_json, state, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(REPO, 114, "comment", JSON.stringify({ kind: "comment", body: "Pending deterministic comment" }), "pending", null, at(2));
  db.prepare("INSERT INTO repo_users (repo, login, user_id, avatar_url, fetched_at) VALUES (?, ?, ?, ?, ?)").run(REPO, VIEWER, "user-viewer", mockAvatarDataUri(VIEWER), insertedAt);
  db.prepare("INSERT INTO repo_users (repo, login, user_id, avatar_url, fetched_at) VALUES (?, ?, ?, ?, ?)").run(REPO, "reviewer-one", "user-reviewer-one", mockAvatarDataUri("reviewer-one"), insertedAt);

  const logDir = `${dataDir}/agents`;
  mkdirSync(logDir, { recursive: true });
  const runningLog = `${logDir}/fixture-110-running.jsonl`;
  const failedLog = `${logDir}/fixture-110-failed.jsonl`;
  writeFileSync(runningLog, `${JSON.stringify({ type: "assistant", timestamp: at(8), message: { content: [{ type: "text", text: "Inspecting the queued checks and base branch state." }] } })}\n`);
  writeFileSync(failedLog, `${JSON.stringify({ type: "assistant", timestamp: at(120), message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test server/http.test.ts" } }] } })}\n${JSON.stringify({ type: "result", timestamp: at(115), result: "The targeted test exposed a fixture-only failure.", is_error: true })}\n`);
  db.prepare("INSERT INTO fixer_agents (repo, number, pid, pid_started, state, started_at, workdir, log_path, exit_reason, kind, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(REPO, 110, 0, "", "running", at(10), `${logDir}/fixture-110`, runningLog, null, "fixer", "");
  db.prepare("INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, ended_at, workdir, log_path, brief, exit_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(REPO, 110, "fixer", "", "running", at(10), null, `${logDir}/fixture-110`, runningLog, "Keep the PR current until its checks pass", null);
  db.prepare("INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, ended_at, workdir, log_path, brief, exit_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(REPO, 110, "autofix", "", "exited", at(130), at(115), `${logDir}/fixture-110-old`, failedLog, "Repair the failing screenshot gate", "gave-up");
  db.prepare("INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, ended_at, workdir, log_path, brief, exit_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(REPO, 110, "custom", "custom-release", "killed", at(220), at(205), `${logDir}/fixture-110-killed`, runningLog, "Prepare the release notes", null);
  db.prepare("INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, ended_at, workdir, log_path, brief, exit_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(REPO, 110, "fixer", "", "exited", at(350), at(320), `${logDir}/fixture-110-green`, runningLog, "Resolve the required review thread", "green");

  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("repos", `${REPO},${ADMIN_REPO}`);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("default_repo", REPO);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("force_merge_repos", ADMIN_REPO);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("relay_url", "");
}
