// Maps GitHub REST payloads onto the GraphQL detail contract, for reads that take the REST
// quota while GraphQL is exhausted. REST cannot see everything GraphQL does: thread ids and
// resolution, per-commit check rollups, and the viewer's own reactions have no REST field, so
// they carry over from the previous GraphQL read where one exists.
import { checkState, currentChecks, type PrCheck } from "./checkState.ts";
import type { PrDetail, RawPrDetail, WorkflowRun } from "./github.ts";

export type RestActor = { login: string; avatar_url: string; type?: string } | null;

export type RestReactions = Partial<Record<"+1" | "-1" | "laugh" | "hooray" | "confused" | "heart" | "rocket" | "eyes", number>>;

export type RestCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  app: { id: number } | null;
  check_suite: { id: number } | null;
};

export type RestCommitStatus = { context: string; state: string; target_url: string | null; created_at: string };

export type RestPrCommit = {
  sha: string;
  commit: {
    message: string;
    author: { name: string | null; date: string } | null;
    committer: { date: string } | null;
  };
  author: RestActor;
  parents: Array<{ sha: string }>;
};

export type RestReview = {
  id: number;
  node_id: string;
  user: RestActor;
  state: string;
  body: string | null;
  submitted_at: string | null;
};

export type RestIssueComment = {
  id: number;
  node_id: string;
  user: RestActor;
  body: string | null;
  created_at: string;
  reactions?: RestReactions;
};

export type RestReviewComment = RestIssueComment & {
  in_reply_to_id?: number;
  pull_request_review_id: number | null;
  diff_hunk: string;
  path: string;
  line: number | null;
  side?: string | null;
};

type RawReactionGroup = RawPrDetail["reactionGroups"][number];
type RawCommitList = RawPrDetail["commitList"];
type RawReviewThreads = RawPrDetail["reviewThreads"];
type RawThread = RawReviewThreads["nodes"][number];

const NO_MORE_PAGES = { hasNextPage: false, endCursor: null };

// GraphQL names bots without the "[bot]" suffix REST adds, and login comparisons (the Greptile
// score, the viewer's own reviews) expect the GraphQL form.
export function restAuthor(user: RestActor): { __typename?: string; login: string; avatarUrl: string } | null {
  if (!user) return null;
  const bot = user.type === "Bot";
  return {
    ...(user.type ? { __typename: user.type } : {}),
    login: bot ? user.login.replace(/\[bot\]$/, "") : user.login,
    avatarUrl: user.avatar_url,
  };
}

const REACTION_CONTENT: Array<[keyof RestReactions, string]> = [
  ["+1", "THUMBS_UP"],
  ["-1", "THUMBS_DOWN"],
  ["laugh", "LAUGH"],
  ["hooray", "HOORAY"],
  ["confused", "CONFUSED"],
  ["heart", "HEART"],
  ["rocket", "ROCKET"],
  ["eyes", "EYES"],
];

// REST reports counts only; whether the viewer reacted is unknown and reads as not reacted.
export function restReactionGroups(reactions: RestReactions | undefined): RawReactionGroup[] {
  return REACTION_CONTENT.map(([key, content]) => ({
    content,
    viewerHasReacted: false,
    reactors: { totalCount: reactions?.[key] ?? 0 },
  }));
}

// Actions job URLs carry the run id; any other app's check has no workflow run.
function workflowRunFor(run: RestCheckRun, workflowRuns: Map<number, WorkflowRun>) {
  const suite = run.check_suite?.id;
  const workflowRun = suite === undefined ? undefined : workflowRuns.get(suite);
  if (!workflowRun) return null;
  return {
    databaseId: workflowRun.id,
    workflow: { databaseId: workflowRun.workflow_id ?? null, name: workflowRun.name },
  };
}

export function restCheckContexts(
  checkRuns: RestCheckRun[],
  statuses: RestCommitStatus[],
  workflowRuns: WorkflowRun[],
  required: ReadonlySet<string>,
): PrCheck[] {
  const runsBySuite = new Map<number, WorkflowRun>();
  for (const run of workflowRuns) if (typeof run.check_suite_id === "number") runsBySuite.set(run.check_suite_id, run);
  return [
    ...checkRuns.map((run): PrCheck => ({
      __typename: "CheckRun",
      databaseId: run.id,
      name: run.name,
      status: run.status.toUpperCase(),
      conclusion: run.conclusion ? run.conclusion.toUpperCase() : null,
      detailsUrl: run.details_url ?? run.html_url,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      isRequired: required.has(run.name),
      checkSuite: { app: run.app ? { databaseId: run.app.id } : null, workflowRun: workflowRunFor(run, runsBySuite) },
    })),
    ...statuses.map((status): PrCheck => ({
      __typename: "StatusContext",
      context: status.context,
      state: status.state.toUpperCase(),
      targetUrl: status.target_url,
      createdAt: status.created_at,
      isRequired: required.has(status.context),
    })),
  ];
}

// GitHub computes the rollup server-side; this reproduces it from the current checks, with a
// cancelled check failing the rollup as it does on GitHub.
export function restRollupState(contexts: PrCheck[]): string | null {
  if (contexts.length === 0) return null;
  const states = currentChecks(contexts).map(checkState);
  if (states.some((state) => state === "failed" || state === "cancelled")) return "FAILURE";
  if (states.includes("running")) return "PENDING";
  return "SUCCESS";
}

// The rollup of commits other than the head would cost two requests each, so they keep the
// state the previous read saw for the same oid.
export function restCommitList(
  commits: RestPrCommit[],
  headOid: string,
  headRollup: string | null,
  previous: Pick<PrDetail, "commitList"> | null,
): RawCommitList {
  const known = new Map<string, RawCommitList["nodes"][number]["commit"]>();
  for (const { commit } of previous?.commitList?.nodes ?? []) known.set(commit.oid, commit);
  return {
    nodes: commits.slice(-100).map(({ sha, commit, author, parents }) => {
      const earlier = known.get(sha);
      return {
        commit: {
          oid: sha,
          abbreviatedOid: sha.slice(0, 7),
          messageHeadline: commit.message.split("\n", 1)[0] ?? "",
          committedDate: commit.committer?.date ?? commit.author?.date ?? "",
          ...(typeof earlier?.additions === "number" && typeof earlier.deletions === "number"
            ? { additions: earlier.additions, deletions: earlier.deletions }
            : {}),
          statusCheckRollup: sha === headOid
            ? headRollup === null ? null : { state: headRollup }
            : earlier?.statusCheckRollup ?? null,
          author: {
            name: commit.author?.name ?? null,
            user: author ? { login: restAuthor(author)!.login, avatarUrl: author.avatar_url } : null,
          },
          parents: { nodes: parents.slice(0, 1).map((parent) => ({ oid: parent.sha })) },
        },
      };
    }),
  };
}

// Each reviewer's latest approving or blocking review counts; comments neither grant nor
// withdraw approval. Without a known approval requirement any approval reads as approved.
export function restReviewDecision(reviews: RestReview[], requiredApprovals: number): string | null {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
    latest.set(login, review.state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  const approvals = states.filter((state) => state === "APPROVED").length;
  if (requiredApprovals > 0) return approvals >= requiredApprovals ? "APPROVED" : "REVIEW_REQUIRED";
  return approvals > 0 ? "APPROVED" : null;
}

export function restReviews(reviews: RestReview[]): RawPrDetail["reviews"] {
  return {
    pageInfo: NO_MORE_PAGES,
    nodes: reviews.map((review) => ({
      id: review.node_id,
      author: restAuthor(review.user),
      state: review.state,
      body: review.body ?? "",
      submittedAt: review.submitted_at ?? "",
      reactionGroups: [],
    })),
  };
}

export function restIssueComments(comments: RestIssueComment[]): RawPrDetail["comments"] {
  return {
    pageInfo: NO_MORE_PAGES,
    nodes: comments.slice(-100).map((comment) => ({
      id: comment.node_id,
      author: restAuthor(comment.user),
      body: comment.body ?? "",
      createdAt: comment.created_at,
      reactionGroups: restReactionGroups(comment.reactions),
    })),
  };
}

// REST has review comments, not threads: a reply points at its thread's first comment. The
// thread's GraphQL id and resolution exist only in the previous read, matched by comment id;
// a thread first seen over REST reads as unresolved until GraphQL is back.
export function restReviewThreads(
  comments: RestReviewComment[],
  reviews: RestReview[],
  previous: Pick<PrDetail, "reviewThreads"> | null,
): RawReviewThreads {
  const reviewStates = new Map(reviews.map((review) => [review.id, review.state]));
  const previousByComment = new Map<number, { id: string; isResolved: boolean }>();
  for (const thread of previous?.reviewThreads?.nodes ?? []) {
    for (const comment of thread.comments.nodes) {
      if (typeof comment.databaseId === "number") previousByComment.set(comment.databaseId, thread);
    }
  }
  const ids = new Set(comments.map((comment) => comment.id));
  const threads = new Map<number, RestReviewComment[]>();
  for (const comment of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const root = comment.in_reply_to_id !== undefined && ids.has(comment.in_reply_to_id) ? comment.in_reply_to_id : comment.id;
    const thread = threads.get(root);
    if (thread) thread.push(comment);
    else threads.set(root, [comment]);
  }
  return {
    pageInfo: NO_MORE_PAGES,
    nodes: [...threads.values()].map((thread): RawThread => {
      const root = thread[0]!;
      const earlier = thread.map((comment) => previousByComment.get(comment.id)).find(Boolean);
      return {
        id: earlier?.id ?? `rest:${root.node_id}`,
        isResolved: earlier?.isResolved ?? false,
        isOutdated: root.line === null,
        path: root.path,
        line: root.line,
        diffSide: root.side === "LEFT" ? "LEFT" : "RIGHT",
        comments: {
          pageInfo: NO_MORE_PAGES,
          nodes: thread.map((comment) => ({
            id: comment.node_id,
            databaseId: comment.id,
            diffHunk: comment.diff_hunk,
            author: restAuthor(comment.user),
            body: comment.body ?? "",
            createdAt: comment.created_at,
            pullRequestReview: comment.pull_request_review_id === null
              ? null
              : { state: reviewStates.get(comment.pull_request_review_id) ?? "COMMENTED" },
            reactionGroups: restReactionGroups(comment.reactions),
          })),
        },
      };
    }),
  };
}
