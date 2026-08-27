import type { MergeMethod } from "./mergeMethod.ts";
import { mockGithub } from "./mockGithub.ts";
import {
  githubAuthStatus as liveGithubAuthStatus,
  liveGithubToken,
  startGithubSetup as startLiveGithubSetup,
  type GithubAuthStatus,
} from "./githubAuth.ts";
import {
  instrumentGithubGraphql,
  RATE_LIMIT_ALIAS,
  recordGithubGraphqlUsage,
  type GithubUsageSource,
} from "./githubUsage.ts";
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type GithubGraphqlError = { type?: string; message?: string };

export class GithubRequestError extends Error {
  constructor(message: string, readonly status: 404 | 502, readonly graphqlErrors: readonly GithubGraphqlError[] = []) {
    super(message);
    this.name = "GithubRequestError";
  }
}

export class StalePrHeadError extends Error {
  constructor(message = "PR head changed; reload before committing") {
    super(message);
    this.name = "StalePrHeadError";
  }
}


export async function githubAuthStatus(scopes: readonly string[] = ["repo", "workflow"]): Promise<GithubAuthStatus> {
  if (!mockGithub) return liveGithubAuthStatus(scopes);
  return {
    ok: true,
    state: "ready",
    login: mockGithub.viewerLogin,
    error: null,
    requiredScopes: [...scopes],
    missingScopes: [],
  };
}

export async function startGithubSetup(scopes: readonly string[] = ["repo", "workflow"]): Promise<GithubAuthStatus> {
  if (!mockGithub) return startLiveGithubSetup(scopes);
  return githubAuthStatus(scopes);
}

export async function ghToken(): Promise<string> {
  if (mockGithub) return "fixture-token";
  return liveGithubToken();
}

let cachedViewerLogin: string | null = null;

export async function getViewerLogin(): Promise<string> {
  if (mockGithub) return mockGithub.viewerLogin;
  if (cachedViewerLogin) return cachedViewerLogin;
  const viewer = await restJson<{ login: string }>("/user");
  cachedViewerLogin = viewer.login;
  return cachedViewerLogin;
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  source: GithubUsageSource,
  operation: string,
): Promise<T> {
  const token = await ghToken();
  const instrumented = instrumentGithubGraphql(query);
  let res: Response;
  try {
    res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: instrumented.document, variables }),
    });
  } catch (error) {
    recordGithubGraphqlUsage({
      occurredAt: new Date().toISOString(),
      source,
      operation,
      cost: instrumented.fixedCost,
      used: null,
      remaining: null,
      resetAt: null,
      status: "error",
    });
    throw error;
  }
  const headerNumber = (name: string): number | null => {
    const raw = res.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const headerReset = headerNumber("x-ratelimit-reset");
  const record = (
    rateLimit: { cost: number; used: number; remaining: number; resetAt: string } | null,
    status: "ok" | "error",
  ) => {
    const used = rateLimit?.used ?? headerNumber("x-ratelimit-used");
    const remaining = rateLimit?.remaining ?? headerNumber("x-ratelimit-remaining");
    const resetAt = rateLimit?.resetAt ?? (headerReset === null ? null : new Date(headerReset * 1_000).toISOString());
    updateCachedGraphqlQuota(
      headerNumber("x-ratelimit-limit"),
      used,
      remaining,
      resetAt,
    );
    recordGithubGraphqlUsage({
      occurredAt: new Date().toISOString(),
      source,
      operation,
      cost: rateLimit?.cost ?? instrumented.fixedCost,
      used,
      remaining,
      resetAt,
      status,
    });
  };
  if (!res.ok) {
    record(null, "error");
    const status = res.status === 404 ? 404 : 502;
    throw new GithubRequestError(`GraphQL request failed: ${res.status} ${await res.text()}`, status);
  }
  const body = (await res.json()) as {
    data?: T & Record<string, unknown>;
    errors?: GithubGraphqlError[];
  };
  const rateLimit = body.data?.[RATE_LIMIT_ALIAS] as {
    cost: number;
    used: number;
    remaining: number;
    resetAt: string;
  } | undefined;
  if (body.data) delete body.data[RATE_LIMIT_ALIAS];
  record(rateLimit ?? null, body.errors?.length ? "error" : "ok");
  if (body.errors?.length) {
    const status = body.errors.every((error) => error.type === "NOT_FOUND") ? 404 : 502;
    throw new GithubRequestError(`GraphQL errors: ${JSON.stringify(body.errors)}`, status, body.errors);
  }
  if (!body.data) throw new GithubRequestError("GraphQL response missing data", 502);
  return body.data;
}

export interface GithubQuotaResource {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface GithubQuota {
  rest: GithubQuotaResource;
  graphql: GithubQuotaResource;
  fetchedAt: string;
}

let cachedQuota: GithubQuota | null = null;
const QUOTA_TTL_MS = 60_000;


function updateCachedGraphqlQuota(
  limit: number | null,
  used: number | null,
  remaining: number | null,
  resetAt: string | null,
): void {
  if (!cachedQuota || limit === null || used === null || remaining === null || resetAt === null) return;
  cachedQuota = {
    ...cachedQuota,
    graphql: { limit, used, remaining, resetAt },
    fetchedAt: new Date().toISOString(),
  };
}
export async function fetchGithubQuota(): Promise<GithubQuota> {
  if (cachedQuota && Date.now() - Date.parse(cachedQuota.fetchedAt) < QUOTA_TTL_MS) return cachedQuota;
  if (mockGithub) {
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    return { rest: { limit: 5_000, used: 10, remaining: 4_990, resetAt }, graphql: { limit: 5_000, used: 20, remaining: 4_980, resetAt }, fetchedAt: new Date().toISOString() };
  }

  const token = await ghToken();
  const res = await fetch("https://api.github.com/rate_limit", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub quota request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    resources: Record<"core" | "graphql", { limit: number; used: number; remaining: number; reset: number }>;
  };
  const resource = (name: "core" | "graphql"): GithubQuotaResource => {
    const value = body.resources[name];
    return { limit: value.limit, used: value.used, remaining: value.remaining, resetAt: new Date(value.reset * 1_000).toISOString() };
  };
  cachedQuota = { rest: resource("core"), graphql: resource("graphql"), fetchedAt: new Date().toISOString() };
  return cachedQuota;
}

export interface SearchHit {
  repo: string;
  number: number;
  title: string;
  updatedAt: string;
  headRefOid: string;
  ciState: string;
}

const SEARCH_QUERY = `
query($searchQuery: String!) {
  search(query: $searchQuery, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        updatedAt
        headRefOid
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

export async function searchOpenPrs(repos: string[]): Promise<SearchHit[]> {
  if (mockGithub) return mockGithub.searchOpenPrs(repos);
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");
  const searchQuery = `is:open is:pr archived:false involves:@me ${repoFilter}`;
  const data = await graphql<{
    search: {
      nodes: Array<{
        number: number;
        title: string;
        updatedAt: string;
        headRefOid: string;
        repository: { nameWithOwner: string };
        commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
      }>;
    };
  }>(SEARCH_QUERY, { searchQuery }, "background poll", "open PR search");
  if (data.search.nodes.length === 50) {
    console.warn(`search hit the 50-result cap, PRs may be missing: ${searchQuery}`);
  }
  return data.search.nodes.map((n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    updatedAt: n.updatedAt,
    headRefOid: n.headRefOid,
    ciState: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE",
  }));
}

export interface PaletteHit {
  repo: string;
  number: number;
  title: string;
  state: string;
}


export async function searchPrs(repos: string[], q: string): Promise<PaletteHit[]> {
  if (mockGithub) return mockGithub.searchPrs(repos, q);
  const repoFilter = repos.map((repo) => `repo:${repo}`).join(" ");
  const searchQuery = `is:pr ${repoFilter} in:title ${q}`;
  const items = await restSearchPrs(searchQuery, 15);
  return items.map((item) => ({
    repo: restSearchRepo(item),
    number: item.number,
    title: item.title,
    state: restSearchState(item),
  }));
}

type RawPrIndexEntry = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string } | null;
  mergedAt?: string | null;
  closedAt?: string | null;
};

type RestPrSearchItem = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  updated_at: string;
  closed_at: string | null;
  user: { login: string } | null;
  repository_url: string;
  pull_request: { merged_at: string | null };
};

async function restSearchPrs(query: string, perPage: number): Promise<RestPrSearchItem[]> {
  const result = await restJson<{ items: RestPrSearchItem[] }>(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`,
  );
  return result.items;
}

function restSearchRepo(item: RestPrSearchItem): string {
  return item.repository_url.split("/").slice(-2).join("/");
}

function restSearchState(item: RestPrSearchItem): PrState {
  return item.pull_request.merged_at ? "MERGED" : item.state.toUpperCase() as PrState;
}

const PR_INDEX_LOOKUP_CAP = 100;

export async function lookupPrIndexes(repo: string, numbers: number[]): Promise<PrIndexEntry[]> {
  const unique = [...new Set(numbers)]
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .slice(0, PR_INDEX_LOOKUP_CAP);
  if (unique.length === 0) return [];
  if (mockGithub) {
    const wanted = new Set(unique);
    return mockGithub.searchRecentPrs(repo).filter((entry) => wanted.has(entry.number));
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const selections = unique
    .map((number, index) => `pr${index}: pullRequest(number: ${number}) {
      number title state isDraft updatedAt author { login }
    }`)
    .join("\n");
  const data = await graphql<{
    repository: (Record<string, RawPrIndexEntry | null>) | null;
  }>(`query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${selections}
    }
  }`, { owner, name }, "search", "PR lookup");

  return unique.flatMap((number, index) => {
    const entry = data.repository?.[`pr${index}`];
    return entry ? [{
      repo,
      number,
      title: entry.title,
      state: entry.state,
      isDraft: entry.isDraft,
      author: entry.author?.login ?? "unknown",
      updatedAt: entry.updatedAt,
    }] : [];
  });
}

export async function lookupPr(repo: string, number: number): Promise<PaletteHit | null> {
  const entry = (await lookupPrIndexes(repo, [number]))[0];
  return entry ? { repo, number: entry.number, title: entry.title, state: entry.state } : null;
}

export interface PrIndexEntry {
  repo: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  involvesMe?: boolean;
}


export async function searchRecentPrs(repo: string): Promise<PrIndexEntry[]> {
  if (mockGithub) return mockGithub.searchRecentPrs(repo);
  const searchQuery = `repo:${repo} is:pr sort:updated-desc`;
  const items = await restSearchPrs(searchQuery, 100);
  return items.map((item) => ({
    repo: restSearchRepo(item),
    number: item.number,
    title: item.title,
    state: restSearchState(item),
    isDraft: item.draft,
    author: item.user?.login ?? "unknown",
    updatedAt: item.updated_at,
    mergedAt: item.pull_request.merged_at,
    closedAt: item.closed_at,
  }));
}

export async function searchClosedPrs(repos: string[]): Promise<PrIndexEntry[]> {
  if (repos.length === 0) return [];
  if (mockGithub) {
    const fixture = mockGithub;
    return repos.flatMap((repo) =>
      fixture.searchRecentPrs(repo)
        .filter((entry) => entry.state === "MERGED" || entry.state === "CLOSED")
        .map((entry) => ({ ...entry, involvesMe: true }))
    );
  }
  const repoFilter = repos.map((repo) => `repo:${repo}`).join(" ");
  const searchQuery = `is:pr is:closed involves:@me archived:false ${repoFilter} sort:updated-desc`;
  const items = await restSearchPrs(searchQuery, 100);
  if (items.length === 100) {
    console.warn(`search hit the 100-result cap, PRs may be missing: ${searchQuery}`);
  }
  return items.map((item) => ({
    repo: restSearchRepo(item),
    number: item.number,
    title: item.title,
    state: restSearchState(item),
    isDraft: item.draft,
    author: item.user?.login ?? "unknown",
    updatedAt: item.updated_at,
    mergedAt: item.pull_request.merged_at,
    closedAt: item.closed_at,
    involvesMe: true,
  }));
}

export interface ViewerRepo {
  nameWithOwner: string;
  pushedAt: string | null;
  isPrivate: boolean;
}


export async function viewerRepos(): Promise<ViewerRepo[]> {
  if (mockGithub) return mockGithub.viewerRepos();
  const repos = await restJson<Array<{ full_name: string; pushed_at: string | null; private: boolean }>>(
    "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=30",
  );
  return repos.map((repo) => ({
    nameWithOwner: repo.full_name,
    pushedAt: repo.pushed_at,
    isPrivate: repo.private,
  }));
}

export interface ReviewItem {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  bucket: "review-requested" | "assigned" | "mentioned";
  isDraft: boolean;
  state: string;
}

interface ReviewSearchNode {
  number: number;
  url: string;
  title: string | null;
  isDraft: boolean;
  repository: { nameWithOwner: string } | null;
  headRefName: string;
  reviewDecision: string | null;
  statusCheckRollup: { state: string } | null;
}

function reviewStateFor(node: Pick<ReviewSearchNode, "isDraft" | "reviewDecision" | "statusCheckRollup">): string {
  if (node.isDraft) return "draft";
  const ci = node.statusCheckRollup?.state;
  const run = ci === "FAILURE" || ci === "ERROR" ? "failing" : ci === "PENDING" || ci === "EXPECTED" ? "running" : "passing";
  return `open.${run}.${node.reviewDecision === "APPROVED" ? "approved" : "none"}`;
}

function nodeToReviewItem(node: ReviewSearchNode | null, bucket: ReviewItem["bucket"]): ReviewItem | null {
  if (!node || typeof node.number !== "number" || !node.repository?.nameWithOwner) return null;
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    url: node.url,
    title: node.title ?? `#${node.number}`,
    branch: node.headRefName,
    bucket,
    isDraft: node.isDraft,
    state: reviewStateFor(node),
  };
}

const BUCKET_RANK: Record<ReviewItem["bucket"], number> = {
  "review-requested": 0,
  assigned: 1,
  mentioned: 2,
};

const REVIEW_SEARCH_FIELDS = "number url title isDraft repository { nameWithOwner } headRefName reviewDecision statusCheckRollup { state }";

export interface ReviewsPollResult {
  items: ReviewItem[];
  cost: number | null;
  remaining: number | null;
}

export async function fetchReviewItems(): Promise<ReviewsPollResult> {
  if (mockGithub) return { items: [], cost: 0, remaining: 5_000 };
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const query = `
query {
  rateLimit { cost remaining }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
  assigned: search(query: "is:pr is:open assignee:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
  mentioned: search(query: "is:pr is:open mentions:@me archived:false updated:>=${since}", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
}`;
  const data = await graphql<{
    rateLimit: { cost: number; remaining: number } | null;
    reviewRequested: { nodes: ReviewSearchNode[] };
    assigned: { nodes: ReviewSearchNode[] };
    mentioned: { nodes: ReviewSearchNode[] };
  }>(query, {}, "review inbox", "review inbox");

  const merged = new Map<string, ReviewItem>();
  const addBucket = (nodes: ReviewSearchNode[], bucket: ReviewItem["bucket"]) => {
    for (const node of nodes) {
      const item = nodeToReviewItem(node, bucket);
      if (!item) continue;
      const key = `${item.repo}#${item.number}`;
      const previous = merged.get(key);
      if (!previous || BUCKET_RANK[item.bucket] < BUCKET_RANK[previous.bucket]) merged.set(key, item);
    }
  };
  addBucket(data.reviewRequested.nodes, "review-requested");
  addBucket(data.assigned.nodes, "assigned");
  addBucket(data.mentioned.nodes, "mentioned");

  return {
    items: [...merged.values()],
    cost: data.rateLimit?.cost ?? null,
    remaining: data.rateLimit?.remaining ?? null,
  };
}



export interface AssignableUser {
  id: string;
  login: string;
  avatarUrl: string;
}


export async function fetchAssignableUsers(repo: string): Promise<AssignableUser[]> {
  if (mockGithub) return mockGithub.assignableUsers(repo);
  const users = await restJson<Array<{ node_id: string; login: string; avatar_url: string }>>(
    `/repos/${repo}/assignees?per_page=100`,
  );
  return users.map((user) => ({
    id: user.node_id,
    login: user.login,
    avatarUrl: user.avatar_url,
  }));
}


export async function addAssignees(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("POST", `/repos/${repo}/issues/${number}/assignees`, { assignees: logins });
}


export async function requestReviewers(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("POST", `/repos/${repo}/pulls/${number}/requested_reviewers`, { reviewers: logins });
}

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

export async function resolveReviewThread(threadId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId }, "user action", "resolve review thread");
}

export async function removeAssignees(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("DELETE", `/repos/${repo}/issues/${number}/assignees`, { assignees: logins });
}

export async function removeRequestedReviewers(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("DELETE", `/repos/${repo}/pulls/${number}/requested_reviewers`, { reviewers: logins });
}

export const SCHEMA_EPOCH = 11;

const REACTION_GROUPS_FIELD = `reactionGroups { content viewerHasReacted reactors { totalCount } }`;

const CHECK_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    name
    status
    conclusion
    detailsUrl
    startedAt
    completedAt
    isRequired(pullRequestNumber: $number)
    checkSuite { workflowRun { databaseId workflow { name } } }
  }
  ... on StatusContext {
    context
    state
    targetUrl
    createdAt
    isRequired(pullRequestNumber: $number)
  }
`;

const THREAD_COMMENT_FIELDS = `
  databaseId
  diffHunk
  author { login avatarUrl }
  body
  createdAt
  ${REACTION_GROUPS_FIELD}
`;

const DETAIL_CHECKS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      lastCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { ${CHECK_CONTEXT_FIELDS} }
              }
            }
          }
        }
      }
      commitList: commits(last: 100) {
        nodes {
          commit {
            oid
            abbreviatedOid
            messageHeadline
            committedDate
            additions
            deletions
            statusCheckRollup { state }
            author { name user { login avatarUrl } }
            parents(first: 1) { nodes { oid } }
          }
        }
      }
    }
  }
}`;

const DETAIL_REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${REACTION_GROUPS_FIELD}
      viewerCanMergeAsAdmin
      reviewDecision
      reviews(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { login avatarUrl }
          state
          body
          submittedAt
          ${REACTION_GROUPS_FIELD}
        }
      }
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { login avatarUrl }
          body
          createdAt
          ${REACTION_GROUPS_FIELD}
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_COMMENT_FIELDS} }
          }
        }
      }
      author { login avatarUrl }
    }
  }
}`;

interface RawReactionGroup {
  content: string;
  viewerHasReacted: boolean;
  reactors: { totalCount: number };
}

export interface Reaction {
  content: string;
  count: number;
  viewerReacted: boolean;
}

function mapReactions(groups: RawReactionGroup[]): Reaction[] {
  return groups
    .filter((g) => g.reactors.totalCount > 0)
    .map((g) => ({ content: g.content, count: g.reactors.totalCount, viewerReacted: g.viewerHasReacted }));
}

type Author = { login: string; avatarUrl: string };
type ReviewNode = { id: string; author: Author | null; state: string; body: string; submittedAt: string };
type CommentNode = { id: string; author: Author | null; body: string; createdAt: string };
type ThreadCommentNode = { databaseId: number | null; diffHunk: string; author: Author | null; body: string; createdAt: string };

export type PrState = "OPEN" | "CLOSED" | "MERGED";

type PrDetailShape<Rx> = {
  id: string;
  title: string;
  number: number;
  state: PrState;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  author: Author | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { totalCount: number; nodes: Array<{ path: string; additions: number; deletions: number }> };
  mergeable: string;
  mergeStateStatus: string;
  viewerCanMergeAsAdmin: boolean;
  autoMergeRequest: { mergeMethod: string; enabledBy: { login: string } | null } | null;
  reviewDecision: string | null;
  createdAt?: string;
  updatedAt: string;
  url: string;
  commitCount: { totalCount: number };
  lastCommit: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<
              | {
                  __typename: "CheckRun";
                  name: string;
                  status: string;
                  conclusion: string | null;
                  detailsUrl: string | null;
                  startedAt: string | null;
                  completedAt: string | null;
                  isRequired: boolean;
                  checkSuite: { workflowRun: { databaseId: number | null; workflow: { name: string } } | null } | null;
                }
              | {
                  __typename: "StatusContext";
                  context: string;
                  state: string;
                  targetUrl: string | null;
                  createdAt: string;
                  isRequired: boolean;
                }
            >;
          };
        } | null;
      };
    }>;
  };
  commitList: {
    nodes: Array<{
      commit: {
        oid: string;
        abbreviatedOid: string;
        messageHeadline: string;
        committedDate: string;
        additions?: number;
        deletions?: number;
        statusCheckRollup?: { state: string } | null;
        author: { name: string | null; user: { login: string; avatarUrl: string } | null } | null;
        parents: { nodes: Array<{ oid: string }> };
      };
    }>;
  };
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { __typename: string; login?: string; avatarUrl?: string; name?: string } | null }>;
  };
  reviews: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<ReviewNode & Rx> };
  comments: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<CommentNode & Rx> };
  reviewThreads: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      diffSide: string;
      comments: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<ThreadCommentNode & Rx> };
    }>;
  };
} & Rx;

type RawPrDetail = PrDetailShape<{ reactionGroups: RawReactionGroup[] }>;

type RawPrDetailChecks = Pick<RawPrDetail, "lastCommit" | "commitList">;
type RawPrDetailReview = Pick<
  RawPrDetail,
  "author" | "reactionGroups" | "viewerCanMergeAsAdmin" | "reviewDecision" | "reviews" | "comments" | "reviewThreads"
>;
type RawPrDetailResidual = RawPrDetailChecks & RawPrDetailReview;
type RestPrDetailBase = Omit<RawPrDetail, keyof RawPrDetailResidual> & Pick<RawPrDetail, "author">;

type RestUser = { node_id: string; login: string; avatar_url: string };
type RestPullRequest = {
  node_id: string;
  title: string;
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  draft: boolean;
  user: RestUser | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  body: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable: boolean | null;
  mergeable_state: string;
  auto_merge: { merge_method: string; enabled_by: Pick<RestUser, "login"> | null } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  commits: number;
  labels: Array<{ name: string }>;
  assignees: Array<Pick<RestUser, "login">>;
  requested_reviewers: RestUser[];
  requested_teams: Array<{ name: string }>;
};

type RestPullRequestFile = { filename: string; additions: number; deletions: number };

export function mapRestPrDetailBase(pullRequest: RestPullRequest, files: RestPullRequestFile[]): RestPrDetailBase {
  return {
    id: pullRequest.node_id,
    title: pullRequest.title,
    number: pullRequest.number,
    state: pullRequest.merged_at ? "MERGED" : pullRequest.state.toUpperCase() as PrState,
    mergedAt: pullRequest.merged_at,
    closedAt: pullRequest.closed_at,
    isDraft: pullRequest.draft,
    author: pullRequest.user ? { login: pullRequest.user.login, avatarUrl: pullRequest.user.avatar_url } : null,
    baseRefName: pullRequest.base.ref,
    baseRefOid: pullRequest.base.sha,
    headRefName: pullRequest.head.ref,
    headRefOid: pullRequest.head.sha,
    body: pullRequest.body ?? "",
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    files: {
      totalCount: pullRequest.changed_files,
      nodes: files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      })),
    },
    mergeable: pullRequest.mergeable === null ? "UNKNOWN" : pullRequest.mergeable ? "MERGEABLE" : "CONFLICTING",
    mergeStateStatus: pullRequest.mergeable_state.toUpperCase(),
    autoMergeRequest: pullRequest.auto_merge
      ? {
          mergeMethod: pullRequest.auto_merge.merge_method.toUpperCase(),
          enabledBy: pullRequest.auto_merge.enabled_by,
        }
      : null,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
    url: pullRequest.html_url,
    commitCount: { totalCount: pullRequest.commits },
    labels: { nodes: pullRequest.labels.map(({ name }) => ({ name })) },
    assignees: { nodes: pullRequest.assignees.map(({ login }) => ({ login })) },
    reviewRequests: {
      nodes: [
        ...pullRequest.requested_reviewers.map((reviewer) => ({
          requestedReviewer: {
            __typename: "User",
            login: reviewer.login,
            avatarUrl: reviewer.avatar_url,
          },
        })),
        ...pullRequest.requested_teams.map((team) => ({
          requestedReviewer: {
            __typename: "Team",
            name: team.name,
          },
        })),
      ],
    },
  };
}

async function fetchRestPrDetailBase(repo: string, number: number): Promise<RestPrDetailBase> {
  const [pullRequest, files] = await Promise.all([
    restJson<RestPullRequest>(`/repos/${repo}/pulls/${number}`),
    restJson<RestPullRequestFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100`),
  ]);
  return mapRestPrDetailBase(pullRequest, files);
}

export type PrDetail = PrDetailShape<{ reactions: Reaction[] }> & {
  viewerLogin: string;
  viewerIsAuthor: boolean;
  viewerReviewRequested: boolean;
  viewerReviewState: string | null;
};

type RawCheckConnection = NonNullable<RawPrDetail["lastCommit"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"];
type RawThreadConnection = RawPrDetail["reviewThreads"];
type RawThread = RawThreadConnection["nodes"][number];
type RawThreadCommentConnection = RawThread["comments"];

const CHECK_CONTEXTS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      lastCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { ${CHECK_CONTEXT_FIELDS} }
              }
            }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_PAGE_QUERY = `
query($threadId: ID!, $after: String!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_COMMENT_FIELDS} }
      }
    }
  }
}`;


async function completeCheckContexts(
  owner: string,
  name: string,
  number: number,
  connection: RawCheckConnection,
  source: GithubUsageSource,
): Promise<void> {
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Check pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{
      repository: {
        pullRequest: {
          lastCommit: {
            nodes: Array<{ commit: { statusCheckRollup: { contexts: RawCheckConnection } | null } }>;
          };
        } | null;
      } | null;
    }>(CHECK_CONTEXTS_PAGE_QUERY, { owner, name, number, after }, source, "PR check pagination");
    const next = data.repository?.pullRequest?.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!next?.pageInfo) throw new GithubRequestError("Check pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
}


async function completeThreadComments(thread: RawThread, source: GithubUsageSource): Promise<void> {
  const cursors = new Set<string>();
  while (thread.comments.pageInfo?.hasNextPage) {
    const after = thread.comments.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review comment pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{ node: { comments: RawThreadCommentConnection } | null }>(
      THREAD_COMMENTS_PAGE_QUERY,
      { threadId: thread.id, after },
      source,
      "PR review comment pagination",
    );
    if (!data.node?.comments.pageInfo) throw new GithubRequestError("Review comment pagination returned no page", 502);
    thread.comments.nodes.push(...data.node.comments.nodes);
    thread.comments.pageInfo = data.node.comments.pageInfo;
  }
}

async function completeReviewThreads(
  owner: string,
  name: string,
  number: number,
  connection: RawThreadConnection,
  source: GithubUsageSource,
): Promise<void> {
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{
      repository: { pullRequest: { reviewThreads: RawThreadConnection } | null } | null;
    }>(REVIEW_THREADS_PAGE_QUERY, { owner, name, number, after }, source, "PR review thread pagination");
    const next = data.repository?.pullRequest?.reviewThreads;
    if (!next?.pageInfo) throw new GithubRequestError("Review thread pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
  for (const thread of connection.nodes) {
    if (!thread.isResolved) await completeThreadComments(thread, source);
  }
}

function normalizeReviewDetail(
  review: RawPrDetailReview,
  viewerLogin: string,
  author: Author | null,
  reviewRequests: RestPrDetailBase["reviewRequests"],
) {
  const { reactionGroups, reviews, comments, reviewThreads, ...scalars } = review;
  const viewerReviews = reviews.nodes
    .filter((item) => item.author?.login === viewerLogin && item.submittedAt)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return {
    ...scalars,
    reactions: mapReactions(reactionGroups),
    viewerIsAuthor: author?.login === viewerLogin,
    viewerReviewRequested: reviewRequests.nodes.some((request) => request.requestedReviewer?.login === viewerLogin),
    viewerReviewState: viewerReviews[0]?.state ?? null,
    reviews: {
      pageInfo: reviews.pageInfo,
      nodes: reviews.nodes.map(({ reactionGroups, ...item }) => ({
        ...item,
        reactions: mapReactions(reactionGroups),
      })),
    },
    comments: {
      pageInfo: comments.pageInfo,
      nodes: comments.nodes.map(({ reactionGroups, ...item }) => ({
        ...item,
        reactions: mapReactions(reactionGroups),
      })),
    },
    reviewThreads: {
      pageInfo: reviewThreads.pageInfo,
      nodes: reviewThreads.nodes.map((thread) => ({
        ...thread,
        comments: {
          pageInfo: thread.comments.pageInfo,
          nodes: thread.comments.nodes.map(({ reactionGroups, ...item }) => ({
            ...item,
            reactions: mapReactions(reactionGroups),
          })),
        },
      })),
    },
  };
}

export async function fetchPrDetail(
  repo: string,
  number: number,
  source: GithubUsageSource = "app detail",
): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const variables = { owner, name, number };
  const [checksData, reviewData, rest, viewerLogin] = await Promise.all([
    graphql<{
      repository: { pullRequest: RawPrDetailChecks | null } | null;
    }>(DETAIL_CHECKS_QUERY, variables, source, "PR checks"),
    graphql<{
      repository: { pullRequest: RawPrDetailReview | null } | null;
    }>(DETAIL_REVIEW_QUERY, variables, source, "PR review detail"),
    fetchRestPrDetailBase(repo, number).catch((error) => {
      if (error instanceof RestRequestError) {
        throw new GithubRequestError(error.message, error.status === 404 ? 404 : 502);
      }
      throw error;
    }),
    getViewerLogin(),
  ]);
  const checks = checksData.repository?.pullRequest;
  const review = reviewData.repository?.pullRequest;
  if (!checks || !review) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  const rollup = checks.lastCommit.nodes[0]?.commit.statusCheckRollup;
  if (rollup) await completeCheckContexts(owner, name, number, rollup.contexts, source);
  await completeReviewThreads(owner, name, number, review.reviewThreads, source);
  return {
    ...rest,
    ...checks,
    viewerLogin,
    ...normalizeReviewDetail(review, viewerLogin, review.author, rest.reviewRequests),
  };
}

export type PrDetailScope = "all" | "checks" | "review";

export async function fetchPrDetailPart(
  repo: string,
  number: number,
  current: PrDetail,
  scope: Exclude<PrDetailScope, "all">,
  source: GithubUsageSource,
): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const variables = { owner, name, number };

  if (scope === "checks") {
    const data = await graphql<{
      repository: { pullRequest: RawPrDetailChecks | null } | null;
    }>(DETAIL_CHECKS_QUERY, variables, source, "PR checks");
    const checks = data.repository?.pullRequest;
    if (!checks) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
    const rollup = checks.lastCommit.nodes[0]?.commit.statusCheckRollup;
    if (rollup) await completeCheckContexts(owner, name, number, rollup.contexts, source);
    return {
      ...current,
      ...checks,
    };
  }

  const [data, viewerLogin] = await Promise.all([
    graphql<{
      repository: { pullRequest: RawPrDetailReview | null } | null;
    }>(DETAIL_REVIEW_QUERY, variables, source, "PR review detail"),
    getViewerLogin(),
  ]);
  const review = data.repository?.pullRequest;
  if (!review) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  await completeReviewThreads(owner, name, number, review.reviewThreads, source);
  return {
    ...current,
    viewerLogin,
    ...normalizeReviewDetail(review, viewerLogin, review.author, current.reviewRequests),
  };
}

export interface PrCommentSince {
  kind: "comment" | "review" | "review comment" | "thread";
  author: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  state: string | null;
  url: string | null;
}

async function fetchRestPages<T>(initialUrl: string, token: string): Promise<T[]> {
  const pages: T[] = [];
  const seen = new Set<string>();
  let url: string | null = initialUrl;
  while (url !== null) {
    if (seen.has(url)) throw new GithubRequestError("GitHub REST pagination repeated a page", 502);
    seen.add(url);
    const response: Response = await fetch(url, {
      headers: {
        Authorization: `bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new GithubRequestError(`GitHub comments request failed: ${response.status} ${await response.text()}`, response.status === 404 ? 404 : 502);
    }
    pages.push(...await response.json() as T[]);
    const next: string | undefined = response.headers
      .get("link")
      ?.split(",")
      .find((part: string) => part.includes('rel="next"'))
      ?.match(/<([^>]+)>/)?.[1];
    url = next ?? null;
  }
  return pages;
}

export async function fetchPrCommentsSince(repo: string, number: number, since: string): Promise<PrCommentSince[]> {
  if (mockGithub) {
    const detail = mockGithub.detail(repo, number);
    return [
      ...detail.comments.nodes.map((comment) => ({
        kind: "comment" as const,
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
        path: null,
        line: null,
        state: null,
        url: detail.url,
      })),
      ...detail.reviews.nodes.filter((review) => review.body.trim()).map((review) => ({
        kind: "review" as const,
        author: review.author?.login ?? "unknown",
        body: review.body,
        createdAt: review.submittedAt,
        path: null,
        line: null,
        state: review.state,
        url: detail.url,
      })),
      ...detail.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes.map((comment) => ({
        kind: "thread" as const,
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
        path: thread.path,
        line: thread.line,
        state: null,
        url: detail.url,
      }))),
    ]
      .filter((comment) => Date.parse(comment.createdAt) >= Date.parse(since))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  const token = await ghToken();
  const baseUrl = `https://api.github.com/repos/${repo}`;
  const encodedSince = encodeURIComponent(since);
  const [issueComments, reviewComments, reviews] = await Promise.all([
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
    }>(`${baseUrl}/issues/${number}/comments?since=${encodedSince}&per_page=100`, token),
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
      path: string;
      line: number | null;
      original_line: number | null;
    }>(`${baseUrl}/pulls/${number}/comments?since=${encodedSince}&per_page=100`, token),
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      submitted_at: string | null;
      state: string;
      html_url: string;
    }>(`${baseUrl}/pulls/${number}/reviews?per_page=100`, token),
  ]);
  const sinceMs = Date.parse(since);
  return [
    ...issueComments.map((comment) => ({
      kind: "comment" as const,
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.created_at,
      path: null,
      line: null,
      state: null,
      url: comment.html_url,
    })),
    ...reviewComments.map((comment) => ({
      kind: "review comment" as const,
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.created_at,
      path: comment.path,
      line: comment.line ?? comment.original_line,
      state: null,
      url: comment.html_url,
    })),
    ...reviews
      .filter((review) => review.submitted_at !== null && review.body.trim())
      .map((review) => ({
        kind: "review" as const,
        author: review.user?.login ?? "unknown",
        body: review.body,
        createdAt: review.submitted_at!,
        path: null,
        line: null,
        state: review.state,
        url: review.html_url,
      })),
  ]
    .filter((comment) => Date.parse(comment.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export async function fetchDiff(repo: string, number: number, base?: string, head?: string): Promise<string> {
  if (mockGithub) return mockGithub.diff(repo, number);
  const token = await ghToken();
  const path = base && head
    ? `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    : `/repos/${repo}/pulls/${number}`;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github.v3.diff",
    },
  });
  if (!res.ok) {
    throw new Error(`diff fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.text();
}

export interface RunJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface RunJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  head_branch?: string;
  workflow_name?: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name?: string | null;
  runner_group_name?: string | null;
  labels?: string[];
  steps: RunJobStep[];
}

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  name: string;
  path: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
  html_url: string | null;
}
export async function fetchWorkflowRun(repo: string, runId: number): Promise<WorkflowRun> {
  if (mockGithub) return mockGithub.workflowRun(repo, runId);
  const token = await ghToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`workflow run fetch failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<WorkflowRun>;
}


export async function fetchWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRun[]> {
  const token = await ghToken();
  const runs: WorkflowRun[] = [];
  for (let page = 1;; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100&page=${page}`, {
      headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`workflow runs fetch failed: ${res.status} ${await res.text()}`);
    const payload = (await res.json()) as { workflow_runs?: WorkflowRun[] };
    const batch = payload.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

export async function fetchRunJobs(repo: string, runId: number, attempt?: number): Promise<RunJob[]> {
  if (mockGithub) return mockGithub.runJobs(repo, runId);
  const token = await ghToken();
  const jobs: RunJob[] = [];
  for (let page = 1;; page++) {
    const endpoint = attempt === undefined
      ? `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest&page=${page}`
      : `https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
    const res = await fetch(endpoint, {
      headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`run jobs fetch failed: ${res.status} ${await res.text()}`);
    const payload = (await res.json()) as { jobs?: RunJob[] };
    const batch = payload.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}

// The logs endpoint answers 302 with a Location that expires after a minute, and that storage host
// rejects a request carrying GitHub's Authorization header, so the download is a second bare fetch.
export async function fetchJobLog(repo: string, jobId: number): Promise<string> {
  if (mockGithub) return mockGithub.jobLog(repo, jobId);
  const token = await ghToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "manual",
  });
  const location = res.headers.get("location");
  if (!location) throw new Error(`job log fetch failed: ${res.status} ${await res.text()}`);
  const download = await fetch(location);
  if (!download.ok) throw new Error(`job log download failed: ${download.status}`);
  return download.text();
}

export interface FileHistoryCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  prNumber: number | null;
}

export async function fetchFileHistory(repo: string, path: string, base: string): Promise<FileHistoryCommit[]> {
  if (mockGithub) return mockGithub.fileHistory(repo, path, base);
  const token = await ghToken();
  const params = new URLSearchParams({ sha: base, path, per_page: "30" });
  const res = await fetch(`https://api.github.com/repos/${repo}/commits?${params}`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`file history fetch failed: ${res.status} ${await res.text()}`);
  const commits = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } | null };
    author: { login: string } | null;
  }>;
  return commits.map((c) => {
    const subject = c.commit.message.split("\n", 1)[0] ?? "";
    const prMatch = subject.match(/\(#(\d+)\)\s*$/);
    return {
      sha: c.sha,
      subject,
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
      prNumber: prMatch ? Number(prMatch[1]) : null,
    };
  });
}

export interface FileHistoryDiff {
  patch: string | undefined;
  additions: number;
  deletions: number;
  status: string;
  previous_filename: string | null;
}

export async function fetchFileHistoryDiff(repo: string, sha: string, path: string): Promise<FileHistoryDiff | null> {
  if (mockGithub) return mockGithub.fileHistoryDiff(repo, sha, path);
  const token = await ghToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`commit fetch failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    files?: Array<{
      filename: string;
      previous_filename?: string;
      patch?: string;
      additions: number;
      deletions: number;
      status: string;
    }>;
  };
  const files = body.files ?? [];
  const entry = files.find((f) => f.filename === path) ?? files.find((f) => f.previous_filename === path);
  if (!entry) return null;
  return {
    patch: entry.patch,
    additions: entry.additions,
    deletions: entry.deletions,
    status: entry.status,
    previous_filename: entry.previous_filename ?? null,
  };
}

export type FileContents = { content: string } | { tooLarge: true };

export async function fetchFileContents(repo: string, path: string, sha: string): Promise<FileContents> {
  if (mockGithub) return mockGithub.fileContents(repo, path, sha);
  const token = await ghToken();
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${sha}`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`file fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (Array.isArray(body) || body.encoding !== "base64") return { tooLarge: true };
  return { content: strictUtf8Decoder.decode(Buffer.from(body.content ?? "", "base64")) };
}

export type PrFileEdit = {
  repo: string;
  number: number;
  path: string;
  expectedHeadOid: string;
  content: string;
  message: string;
};

type RestPull = {
  state: string;
  head: {
    sha: string;
    ref: string;
    repo: { full_name: string } | null;
  };
};

type RestTreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
};

async function githubRestResponse(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await ghToken();
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function githubRestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await githubRestResponse(method, path, body);
  if (!response.ok) {
    throw new GithubRequestError(
      `GitHub REST request failed: ${response.status} ${await response.text()}`,
      response.status === 404 ? 404 : 502,
    );
  }
  return response.json() as Promise<T>;
}

function encodedRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function isRefUpdateRace(error: unknown): boolean {
  return error instanceof GithubRequestError
    && /REST request failed: (?:409|422)\b/i.test(error.message)
    && /(?:fast.?forward|reference update|expected|stale)/i.test(error.message);
}

export async function commitPrFileEdit(input: PrFileEdit): Promise<{ commitOid: string }> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${input.repo}`, 404);
  const expectedHeadOid = input.expectedHeadOid.toLowerCase();
  const baseRepo = encodedRepo(input.repo);
  const pullRequest = await githubRestJson<RestPull>("GET", `/repos/${baseRepo}/pulls/${input.number}`);
  if (pullRequest.state !== "open") throw new StalePrHeadError("PR is no longer open");
  if (!pullRequest.head?.ref || !pullRequest.head.repo?.full_name) {
    throw new StalePrHeadError("PR head is unavailable");
  }
  if (pullRequest.head.sha.toLowerCase() !== expectedHeadOid) throw new StalePrHeadError();

  const headRepo = encodedRepo(pullRequest.head.repo.full_name);
  const commit = await githubRestJson<{ tree: { sha: string } }>(
    "GET",
    `/repos/${headRepo}/git/commits/${expectedHeadOid}`,
  );
  const segments = input.path.split("/");
  let treeSha = commit.tree.sha;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = await githubRestJson<{ tree: RestTreeEntry[] }>(
      "GET",
      `/repos/${headRepo}/git/trees/${encodeURIComponent(treeSha)}`,
    );
    const entry = tree.tree.find((candidate) => candidate.path === segments[index]);
    const isFile = index === segments.length - 1;
    if (!entry || (isFile ? entry.type !== "blob" || entry.mode !== "100644" : entry.type !== "tree")) {
      throw new StalePrHeadError("PR file is no longer editable");
    }
    treeSha = entry.sha;
  }
  const currentBlob = await githubRestJson<{ content: string; encoding: string }>(
    "GET",
    `/repos/${headRepo}/git/blobs/${encodeURIComponent(treeSha)}`,
  );
  if (currentBlob.encoding !== "base64") throw new StalePrHeadError("PR file is no longer editable");
  try {
    if (strictUtf8Decoder.decode(Buffer.from(currentBlob.content, "base64")).includes("\0")) {
      throw new StalePrHeadError("PR file is no longer editable");
    }
  } catch (error) {
    if (error instanceof StalePrHeadError) throw error;
    throw new StalePrHeadError("PR file is no longer editable");
  }

  const blob = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/blobs`, {
    content: Buffer.from(input.content).toString("base64"),
    encoding: "base64",
  });
  const nextTree = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: [{ path: input.path, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const nextCommit = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/commits`, {
    message: input.message,
    tree: nextTree.sha,
    parents: [expectedHeadOid],
  });
  const encodedRef = pullRequest.head.ref.split("/").map(encodeURIComponent).join("/");
  try {
    await githubRestJson("PATCH", `/repos/${headRepo}/git/refs/heads/${encodedRef}`, {
      sha: nextCommit.sha,
      force: false,
    });
  } catch (error) {
    if (isRefUpdateRace(error)) throw new StalePrHeadError();
    throw error;
  }
  return { commitOid: nextCommit.sha };
}

export class RestRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RestRequestError";
  }
}

async function restRequest(method: string, path: string, body: unknown): Promise<void> {
  if (mockGithub) return;
  const response = await githubRestResponse(method, path, body);
  if (!response.ok) {
    throw new RestRequestError(`${method} ${path} failed: ${response.status} ${await response.text()}`, response.status);
  }
}

async function restJson<T>(path: string): Promise<T> {
  return githubRestJson<T>("GET", path);
}

export async function postIssueComment(repo: string, number: number, body: string): Promise<void> {
  await restRequest("POST", `/repos/${repo}/issues/${number}/comments`, { body });
}

export async function postReviewCommentReply(
  repo: string,
  number: number,
  rootCommentId: number,
  body: string,
): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/comments/${rootCommentId}/replies`, { body });
}

export async function postInlineComment(
  repo: string,
  number: number,
  commitId: string,
  comment: {
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    startLine?: number;
    startSide?: "LEFT" | "RIGHT";
    body: string;
  },
): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/comments`, {
    body: comment.body,
    commit_id: commitId,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    ...(comment.startLine === undefined
      ? {}
      : { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }),
  });
}

export async function postReview(repo: string, number: number, event: string, body: string): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/reviews`, { event, body });
}

export async function mergePullRequest(repo: string, number: number, method: MergeMethod, sha?: string): Promise<void> {
  await restRequest("PUT", `/repos/${repo}/pulls/${number}/merge`, sha ? { merge_method: method, sha } : { merge_method: method });
}

const ENABLE_AUTO_MERGE_MUTATION = `
mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { pullRequest { id } }
}`;

const DISABLE_AUTO_MERGE_MUTATION = `
mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { pullRequest { id } }
}`;

// method null disables GitHub's native auto-merge; the enum is the REST method upper-cased
export async function setGithubAutoMerge(pullRequestId: string, method: MergeMethod | null): Promise<void> {
  if (mockGithub) return mockGithub.setAutoMerge(pullRequestId, method);
  if (method) await graphql(ENABLE_AUTO_MERGE_MUTATION, { pullRequestId, mergeMethod: method.toUpperCase() }, "user action", "enable auto-merge");
  else await graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId }, "user action", "disable auto-merge");
}

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const UNRESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  if (mockGithub) return;
  await graphql(resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION, { threadId }, "user action", resolved ? "resolve review thread" : "unresolve review thread");
}


export async function updatePullRequestBranch(repo: string, number: number): Promise<void> {
  if (mockGithub) return;
  await restRequest("PUT", `/repos/${repo}/pulls/${number}/update-branch`, {});
}

const MARK_READY_MUTATION = `
mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } }
}`;

export async function markPullRequestReadyForReview(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(MARK_READY_MUTATION, { pullRequestId }, "user action", "mark PR ready");
}


export async function closePullRequest(repo: string, number: number): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { state: "closed" });
}


export async function updatePullRequestBody(repo: string, number: number, body: string): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { body });
}


export async function updatePullRequestTitle(repo: string, number: number, title: string): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { title });
}
