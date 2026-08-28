import type { MergeMethod } from "./mergeMethod.ts";
import { mockGithub, MOCK_FIXTURE_CLOCK } from "./mockGithub.ts";

let cachedToken: string | null = null;
const ghExecutable = process.env.COCKPIT_GH_BIN || "gh";
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
export interface GithubAuthStatus {
  ok: boolean;
  login: string | null;
  error: string | null;
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  if (mockGithub) return { ok: true, login: mockGithub.viewerLogin, error: null };

  const notSignedIn = { ok: false, login: null, error: "GitHub CLI is not signed in. Sign in with: gh auth login" };

  // The token is what every other call actually uses, so it decides the verdict.
  let token: string;
  try {
    token = await runGh(["auth", "token"]);
  } catch {
    return { ok: false, login: null, error: "GitHub CLI is not installed. Install it with: brew install gh" };
  }
  if (!token) return notSignedIn;

  return { ok: true, login: await ghLogin(), error: null };
}

// `gh auth status --json` needs gh 2.66+, so fall back rather than call an older gh signed out.
async function ghLogin(): Promise<string | null> {
  const statusText = await runGh(["auth", "status", "--json", "hosts"]).catch(() => "");
  if (statusText) {
    try {
      const status = JSON.parse(statusText) as { hosts?: Record<string, Array<{ active?: boolean; login?: string; state?: string }>> };
      const account = status.hosts?.["github.com"]?.find((candidate) => candidate.active && candidate.state === "success");
      if (account?.login) return account.login;
    } catch {}
  }
  return (await runGh(["api", "user", "--jq", ".login"]).catch(() => "")) || null;
}

// Resolves to trimmed stdout, empty on a non-zero exit; rejects only when gh cannot be spawned.
async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn([ghExecutable, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? out.trim() : "";
}


export async function ghToken(): Promise<string> {
  if (mockGithub) return "fixture-token";
  if (cachedToken) return cachedToken;
  const proc = Bun.spawn([ghExecutable, "auth", "token"], { stdout: "pipe" });
  const token = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!token) throw new Error("gh auth token returned empty output");
  cachedToken = token;
  return token;
}

let cachedViewerLogin: string | null = null;

export async function getViewerLogin(): Promise<string> {
  if (mockGithub) return mockGithub.viewerLogin;
  if (cachedViewerLogin) return cachedViewerLogin;
  const data = await graphql<{ viewer: { login: string } }>("query { viewer { login } }", {});
  cachedViewerLogin = data.viewer.login;
  return cachedViewerLogin;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await ghToken();
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const status = res.status === 404 ? 404 : 502;
    throw new GithubRequestError(`GraphQL request failed: ${res.status} ${await res.text()}`, status);
  }
  const body = (await res.json()) as { data?: T; errors?: GithubGraphqlError[] };
  if (body.errors?.length) {
    const status = body.errors.every((error) => error.type === "NOT_FOUND") ? 404 : 502;
    throw new GithubRequestError(`GraphQL errors: ${JSON.stringify(body.errors)}`, status, body.errors);
  }
  if (!body.data) throw new GithubRequestError("GraphQL response missing data", 502);
  return body.data;
}

export const MAX_MERGED_PR_ANALYTICS_DAYS = 180;
const MERGED_PR_ANALYTICS_TTL_MS = 60_000;

export interface MergedPrAnalyticsPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt: string;
}

export interface MergedPrAnalytics {
  repo: string;
  base: string;
  asOf: string;
  pullRequests: MergedPrAnalyticsPullRequest[];
}

const mergedPrAnalyticsCache = new Map<string, { expiresAt: number; value: MergedPrAnalytics }>();

const MERGED_PRS_QUERY = `
query($owner: String!, $name: String!, $base: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      states: MERGED
      baseRefName: $base
      first: 100
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        url
        mergedAt
        updatedAt
        author { login }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export async function fetchMergedPrAnalytics(repo: string, base: string, days: number): Promise<MergedPrAnalytics> {
  const cappedDays = Math.min(days, MAX_MERGED_PR_ANALYTICS_DAYS);
  const cacheKey = `${repo}\0${base}\0${cappedDays}`;
  const now = Date.now();
  const cached = mergedPrAnalyticsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) mergedPrAnalyticsCache.delete(cacheKey);

  const asOf = mockGithub ? MOCK_FIXTURE_CLOCK : new Date(now).toISOString();
  const cutoff = Date.parse(asOf) - cappedDays * 24 * 60 * 60_000;
  let pullRequests: MergedPrAnalyticsPullRequest[];

  if (mockGithub) {
    pullRequests = base === "main"
      ? mockGithub.searchRecentPrs(repo)
        .filter((entry) => entry.state === "MERGED")
        .flatMap((entry) => {
          const mergedAt = entry.mergedAt ?? entry.updatedAt;
          return Date.parse(mergedAt) >= cutoff
            ? [{
                number: entry.number,
                title: entry.title,
                url: `https://github.com/${repo}/pull/${entry.number}`,
                author: entry.author,
                mergedAt,
              }]
            : [];
        })
      : [];
  } else {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
    pullRequests = [];
    let cursor: string | null = null;
    while (true) {
      const data = await graphql<{
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number;
              title: string;
              url: string;
              mergedAt: string | null;
              updatedAt: string;
              author: { login: string } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      }>(MERGED_PRS_QUERY, { owner, name, base, cursor });
      if (!data.repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404);

      const nodes = data.repository.pullRequests.nodes;
      const reachedCutoff = nodes.length > 0 && nodes.every((entry) => Date.parse(entry.updatedAt) < cutoff);
      for (const entry of nodes) {
        if (!entry.mergedAt) continue;
        if (Date.parse(entry.mergedAt) < cutoff) continue;
        pullRequests.push({
          number: entry.number,
          title: entry.title,
          url: entry.url,
          author: entry.author?.login ?? "unknown",
          mergedAt: entry.mergedAt,
        });
      }

      const { hasNextPage, endCursor } = data.repository.pullRequests.pageInfo;
      if (reachedCutoff || !hasNextPage) break;
      if (!endCursor) throw new GithubRequestError("GraphQL response missing pull request cursor", 502);
      cursor = endCursor;
    }
  }

  pullRequests.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  const value = { repo, base, asOf, pullRequests };
  mergedPrAnalyticsCache.set(cacheKey, { expiresAt: now + MERGED_PR_ANALYTICS_TTL_MS, value });
  return value;
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
  }>(SEARCH_QUERY, { searchQuery });
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

const PALETTE_SEARCH_QUERY = `
query($searchQuery: String!) {
  search(query: $searchQuery, type: ISSUE, first: 15) {
    nodes {
      ... on PullRequest {
        number
        title
        state
        repository { nameWithOwner }
      }
    }
  }
}`;

export async function searchPrs(repos: string[], q: string): Promise<PaletteHit[]> {
  if (mockGithub) return mockGithub.searchPrs(repos, q);
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");
  const searchQuery = `is:pr ${repoFilter} in:title ${q}`;
  const data = await graphql<{
    search: {
      nodes: Array<{
        number: number;
        title: string;
        state: string;
        repository: { nameWithOwner: string };
      }>;
    };
  }>(PALETTE_SEARCH_QUERY, { searchQuery });
  return data.search.nodes.map((n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    state: n.state,
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
  }`, { owner, name });

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

const RECENT_PRS_QUERY = `
query($searchQuery: String!) {
  search(query: $searchQuery, type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        number
        title
        state
        isDraft
        updatedAt
        mergedAt
        closedAt
        author { login }
        repository { nameWithOwner }
      }
    }
  }
}`;

export async function searchRecentPrs(repo: string): Promise<PrIndexEntry[]> {
  if (mockGithub) return mockGithub.searchRecentPrs(repo);
  const searchQuery = `repo:${repo} is:pr sort:updated-desc`;
  const data = await graphql<{
    search: {
      nodes: Array<{
        number: number;
        title: string;
        state: string;
        isDraft: boolean;
        updatedAt: string;
        mergedAt: string | null;
        closedAt: string | null;
        author: { login: string } | null;
        repository: { nameWithOwner: string };
      }>;
    };
  }>(RECENT_PRS_QUERY, { searchQuery });
  return data.search.nodes.map((n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    state: n.state,
    isDraft: n.isDraft,
    author: n.author?.login ?? "unknown",
    updatedAt: n.updatedAt,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
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
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");
  const searchQuery = `is:pr is:closed involves:@me archived:false ${repoFilter} sort:updated-desc`;
  const data = await graphql<{
    search: {
      nodes: Array<{
        number: number;
        title: string;
        state: string;
        isDraft: boolean;
        updatedAt: string;
        mergedAt: string | null;
        closedAt: string | null;
        author: { login: string } | null;
        repository: { nameWithOwner: string };
      }>;
    };
  }>(RECENT_PRS_QUERY, { searchQuery });
  if (data.search.nodes.length === 100) {
    console.warn(`search hit the 100-result cap, PRs may be missing: ${searchQuery}`);
  }
  return data.search.nodes.map((n) => ({
    repo: n.repository.nameWithOwner,
    number: n.number,
    title: n.title,
    state: n.state,
    isDraft: n.isDraft,
    author: n.author?.login ?? "unknown",
    updatedAt: n.updatedAt,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
    involvesMe: true,
  }));
}

export interface ViewerRepo {
  nameWithOwner: string;
  pushedAt: string | null;
  isPrivate: boolean;
}

const VIEWER_REPOS_QUERY = `
query {
  viewer {
    repositories(first: 30, orderBy: { field: PUSHED_AT, direction: DESC }, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      nodes { nameWithOwner pushedAt isPrivate }
    }
  }
}`;

export async function viewerRepos(): Promise<ViewerRepo[]> {
  if (mockGithub) return mockGithub.viewerRepos();
  const data = await graphql<{ viewer: { repositories: { nodes: ViewerRepo[] } } }>(VIEWER_REPOS_QUERY, {});
  return data.viewer.repositories.nodes;
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
  }>(query, {});

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

const ASSIGNABLE_USERS_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 100) {
      nodes { id login avatarUrl }
    }
  }
}`;

export async function fetchAssignableUsers(repo: string): Promise<AssignableUser[]> {
  if (mockGithub) return mockGithub.assignableUsers(repo);
  const [owner, name] = repo.split("/");
  const data = await graphql<{ repository: { assignableUsers: { nodes: AssignableUser[] } } | null }>(
    ASSIGNABLE_USERS_QUERY,
    { owner, name },
  );
  return data.repository?.assignableUsers.nodes ?? [];
}

const ADD_ASSIGNEES_MUTATION = `
mutation($assignableId: ID!, $assigneeIds: [ID!]!) {
  addAssigneesToAssignable(input: { assignableId: $assignableId, assigneeIds: $assigneeIds }) { clientMutationId }
}`;

export async function addAssigneesToAssignable(assignableId: string, assigneeIds: string[]): Promise<void> {
  if (mockGithub) return;
  await graphql(ADD_ASSIGNEES_MUTATION, { assignableId, assigneeIds });
}

const REQUEST_REVIEWS_MUTATION = `
mutation($pullRequestId: ID!, $userIds: [ID!]!) {
  requestReviews(input: { pullRequestId: $pullRequestId, userIds: $userIds, union: true }) { clientMutationId }
}`;

export async function requestReviewsFromUsers(pullRequestId: string, userIds: string[]): Promise<void> {
  if (mockGithub) return;
  await graphql(REQUEST_REVIEWS_MUTATION, { pullRequestId, userIds });
}

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

export async function resolveReviewThread(threadId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
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

const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      title
      number
      state
      isDraft
      mergedAt
      closedAt
      author { login avatarUrl }
      baseRefName
      baseRefOid
      headRefName
      headRefOid
      body
      ${REACTION_GROUPS_FIELD}
      additions
      deletions
      changedFiles
      files(first: 100) {
        totalCount
        nodes { path additions deletions }
      }
      mergeable
      mergeStateStatus
      viewerCanMergeAsAdmin
      autoMergeRequest { mergeMethod enabledBy { login } }
      reviewDecision
      createdAt
      updatedAt
      url
      commitCount: commits { totalCount }
      lastCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ${CHECK_CONTEXT_FIELDS}
                }
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
      labels(first: 20) { nodes { name } }
      assignees(first: 10) { nodes { login } }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login avatarUrl }
            ... on Team { name }
          }
        }
      }
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
            nodes {
              ${THREAD_COMMENT_FIELDS}
            }
          }
        }
      }
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
    }>(CHECK_CONTEXTS_PAGE_QUERY, { owner, name, number, after });
    const next = data.repository?.pullRequest?.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!next?.pageInfo) throw new GithubRequestError("Check pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
}


async function completeThreadComments(thread: RawThread): Promise<void> {
  const cursors = new Set<string>();
  while (thread.comments.pageInfo?.hasNextPage) {
    const after = thread.comments.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review comment pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{ node: { comments: RawThreadCommentConnection } | null }>(
      THREAD_COMMENTS_PAGE_QUERY,
      { threadId: thread.id, after },
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
): Promise<void> {
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{
      repository: { pullRequest: { reviewThreads: RawThreadConnection } | null } | null;
    }>(REVIEW_THREADS_PAGE_QUERY, { owner, name, number, after });
    const next = data.repository?.pullRequest?.reviewThreads;
    if (!next?.pageInfo) throw new GithubRequestError("Review thread pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
  for (const thread of connection.nodes) {
    if (!thread.isResolved) await completeThreadComments(thread);
  }
}

export async function fetchPrDetail(repo: string, number: number): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const data = await graphql<{
    viewer: { login: string };
    repository: { pullRequest: RawPrDetail | null } | null;
  }>(DETAIL_QUERY, {
    owner,
    name,
    number,
  });
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  const rollup = pullRequest.lastCommit.nodes[0]?.commit.statusCheckRollup;
  if (rollup) await completeCheckContexts(owner, name, number, rollup.contexts);
  await completeReviewThreads(owner, name, number, pullRequest.reviewThreads);
  const { reactionGroups, ...raw } = pullRequest;
  const viewerLogin = data.viewer.login;
  const viewerReviews = raw.reviews.nodes
    .filter((r) => r.author?.login === viewerLogin && r.submittedAt)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return {
    ...raw,
    reactions: mapReactions(reactionGroups),
    viewerLogin,
    viewerIsAuthor: raw.author?.login === viewerLogin,
    viewerReviewRequested: raw.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === viewerLogin),
    viewerReviewState: viewerReviews[0]?.state ?? null,
    reviews: {
      pageInfo: raw.reviews.pageInfo,
      nodes: raw.reviews.nodes.map(({ reactionGroups, ...r }) => ({ ...r, reactions: mapReactions(reactionGroups) })),
    },
    comments: {
      pageInfo: raw.comments.pageInfo,
      nodes: raw.comments.nodes.map(({ reactionGroups, ...c }) => ({ ...c, reactions: mapReactions(reactionGroups) })),
    },
    reviewThreads: {
      pageInfo: raw.reviewThreads.pageInfo,
      nodes: raw.reviewThreads.nodes.map((t) => ({
        ...t,
        comments: {
          pageInfo: t.comments.pageInfo,
          nodes: t.comments.nodes.map(({ reactionGroups, ...c }) => ({ ...c, reactions: mapReactions(reactionGroups) })),
        },
      })),
    },
  };
}

export interface PrCommentSince {
  kind: "comment" | "review" | "thread";
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
      kind: "thread" as const,
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
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps: RunJobStep[];
}

// filter=latest is GitHub's default and drops jobs superseded by a re-run attempt
export async function fetchRunJobs(repo: string, runId: number): Promise<RunJob[]> {
  if (mockGithub) return mockGithub.runJobs(repo, runId);
  const token = await ghToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`, {
    headers: { Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`run jobs fetch failed: ${res.status} ${await res.text()}`);
  const payload = (await res.json()) as { jobs?: RunJob[] };
  return payload.jobs ?? [];
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

const PR_FILE_EDIT_HEAD_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $fileExpression: String!, $parentExpression: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefName
      headRefOid
      headRepository {
        nameWithOwner
        file: object(expression: $fileExpression) {
          __typename
          ... on Blob { isBinary }
        }
        parent: object(expression: $parentExpression) {
          __typename
          ... on Tree { entries { name type mode } }
        }
      }
    }
  }
}`;

const CREATE_PR_FILE_COMMIT_MUTATION = `
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
  }
}`;

function isExpectedHeadRace(error: unknown): boolean {
  if (!(error instanceof GithubRequestError)) return false;
  const details = [
    error.message,
    ...error.graphqlErrors.map(({ type, message }) => `${type ?? ""} ${message ?? ""}`),
  ].join("\n");
  return /\bSTALE_DATA\b|expected branch to point to/i.test(details)
    || (/expected.?head.?oid/i.test(details) && /(?:mismatch|match|current|changed|stale)/i.test(details));
}

export async function commitPrFileEdit(input: PrFileEdit): Promise<{ commitOid: string }> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${input.repo}`, 404);
  const expectedHeadOid = input.expectedHeadOid.toLowerCase();
  const fileExpression = `${expectedHeadOid}:${input.path}`;
  const lastSlash = input.path.lastIndexOf("/");
  const parentPath = lastSlash === -1 ? "" : input.path.slice(0, lastSlash);
  const basename = input.path.slice(lastSlash + 1);
  const parentExpression = `${expectedHeadOid}:${parentPath}`;

  const data = await graphql<{
    repository: {
      pullRequest: {
        state: string;
        headRefName: string | null;
        headRefOid: string | null;
        headRepository: {
          nameWithOwner: string;
          file: { __typename: string; isBinary?: boolean | null } | null;
          parent: {
            __typename: string;
            entries?: Array<{ name: string; type: string; mode: number }> | null;
          } | null;
        } | null;
      } | null;
    } | null;
  }>(PR_FILE_EDIT_HEAD_QUERY, { owner, name, number: input.number, fileExpression, parentExpression });
  const pullRequest = data.repository?.pullRequest;
  if (!pullRequest) throw new GithubRequestError(`${input.repo}#${input.number} was not found`, 404);
  if (pullRequest.state !== "OPEN") throw new StalePrHeadError("PR is no longer open");
  if (!pullRequest.headRefName || !pullRequest.headRefOid || !pullRequest.headRepository?.nameWithOwner) {
    throw new StalePrHeadError("PR head is unavailable");
  }
  if (pullRequest.headRefOid !== expectedHeadOid) throw new StalePrHeadError();
  const file = pullRequest.headRepository.file;
  const parent = pullRequest.headRepository.parent;
  const entry = parent?.entries?.find((candidate) => candidate.name === basename);
  if (
    file?.__typename !== "Blob"
    || file?.isBinary !== false
    || parent?.__typename !== "Tree"
    || entry?.type !== "blob"
    || entry?.mode !== 0o100644
  ) {
    throw new StalePrHeadError("PR file is no longer editable");
  }

  try {
    const result = await graphql<{
      createCommitOnBranch: { commit: { oid: string } | null } | null;
    }>(CREATE_PR_FILE_COMMIT_MUTATION, {
      input: {
        branch: {
          repositoryNameWithOwner: pullRequest.headRepository.nameWithOwner,
          branchName: pullRequest.headRefName,
        },
        message: { headline: input.message },
        fileChanges: {
          additions: [{
            path: input.path,
            contents: Buffer.from(input.content).toString("base64"),
          }],
        },
        expectedHeadOid,
      },
    });
    const commitOid = result.createCommitOnBranch?.commit?.oid;
    if (!commitOid) throw new GithubRequestError("GitHub did not return a commit OID", 502);
    return { commitOid };
  } catch (error) {
    if (isExpectedHeadRace(error)) throw new StalePrHeadError();
    throw error;
  }
}

export class RestRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RestRequestError";
  }
}

async function restRequest(method: string, path: string, body: unknown): Promise<void> {
  if (mockGithub) return;
  const token = await ghToken();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new RestRequestError(`${method} ${path} failed: ${res.status} ${await res.text()}`, res.status);
  }
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
  if (method) await graphql(ENABLE_AUTO_MERGE_MUTATION, { pullRequestId, mergeMethod: method.toUpperCase() });
  else await graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId });
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
  await graphql(resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION, { threadId });
}

const UPDATE_BRANCH_MUTATION = `
mutation($pullRequestId: ID!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId }) { pullRequest { headRefOid } }
}`;

export async function updatePullRequestBranch(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(UPDATE_BRANCH_MUTATION, { pullRequestId });
}

const MARK_READY_MUTATION = `
mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } }
}`;

export async function markPullRequestReadyForReview(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(MARK_READY_MUTATION, { pullRequestId });
}

const CLOSE_PR_MUTATION = `
mutation($pullRequestId: ID!) {
  closePullRequest(input: { pullRequestId: $pullRequestId }) { pullRequest { state } }
}`;

export async function closePullRequest(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(CLOSE_PR_MUTATION, { pullRequestId });
}

const UPDATE_PR_BODY_MUTATION = `
mutation($pullRequestId: ID!, $body: String!) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, body: $body }) { pullRequest { body } }
}`;

export async function updatePullRequestBody(pullRequestId: string, body: string): Promise<void> {
  if (mockGithub) return;
  await graphql(UPDATE_PR_BODY_MUTATION, { pullRequestId, body });
}

const UPDATE_PR_TITLE_MUTATION = `
mutation($pullRequestId: ID!, $title: String!) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, title: $title }) { pullRequest { title } }
}`;

export async function updatePullRequestTitle(pullRequestId: string, title: string): Promise<void> {
  if (mockGithub) return;
  await graphql(UPDATE_PR_TITLE_MUTATION, { pullRequestId, title });
}
