import { AsyncLocalStorage } from "node:async_hooks";

export type GithubCredentialKind = "user" | "app";

export type GithubUsageSource =
  | "agent read"
  | "app detail"
  | "background poll"
  | "daemon"
  | "file edit"
  | "index sync"
  | "mutation recovery"
  | "relay"
  | "repository setup"
  | "review inbox"
  | "search"
  | "user action"
  | "webhook";

export interface GithubGraphqlUsageEvent {
  credential?: string;
  credentialKind?: GithubCredentialKind;
  occurredAt: string;
  source: GithubUsageSource;
  operation: string;
  cost: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  status: "ok" | "error";
}

export const RATE_LIMIT_ALIAS = "__prCockpitRateLimit";

let recorder: (event: GithubGraphqlUsageEvent) => void = () => {};

export function setGithubGraphqlUsageRecorder(next: typeof recorder): void {
  recorder = next;
}

export function recordGithubGraphqlUsage(event: GithubGraphqlUsageEvent): void {
  try {
    recorder(event);
  } catch (error) {
    console.error("GitHub GraphQL usage recording failed:", error);
  }
}

export function instrumentGithubGraphql(document: string): {
  document: string;
  fixedCost: number | null;
} {
  const kind = /^\s*(query|mutation)\b/.exec(document)?.[1];
  if (kind === "mutation") return { document, fixedCost: 1 };
  if (kind !== "query") return { document, fixedCost: null };
  const selection = document.indexOf("{");
  if (selection < 0) return { document, fixedCost: null };
  return {
    document: `${document.slice(0, selection + 1)}\n  ${RATE_LIMIT_ALIAS}: rateLimit { cost used remaining resetAt }${document.slice(selection + 1)}`,
    fixedCost: null,
  };
}

const usageSource = new AsyncLocalStorage<GithubUsageSource>();

export function withGithubUsageSource<T>(source: GithubUsageSource, work: () => T): T {
  return usageSource.run(source, work);
}

export function currentGithubUsageSource(): GithubUsageSource | "unknown" {
  return usageSource.getStore() ?? "unknown";
}

// Opaque GitHub CLI traffic cannot be attributed to other clients.
export interface GithubRestCoverage {
  credential: string;
  epoch: string;
  startedAt: string;
  eligible: boolean;
}

const restCoverages = new Map<string, GithubRestCoverage>();
let unmeteredGithubCliOperations = 0;
const restRequestsInFlight = new Map<string, number>();

export function githubRestCoverage(credential = "user"): GithubRestCoverage {
  let coverage = restCoverages.get(credential);
  if (!coverage) {
    coverage = {
      credential,
      epoch: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      eligible: credential.startsWith("app:") || unmeteredGithubCliOperations === 0,
    };
    restCoverages.set(credential, coverage);
  }
  return coverage;
}

export function activeGithubRestCoverage(credential = "user"): GithubRestCoverage | null {
  return restCoverages.get(credential) ?? null;
}

export function endGithubRestCoverage(credential?: string): void {
  if (credential === undefined) restCoverages.clear();
  else restCoverages.delete(credential);
}

export function beginGithubRestRequest(credential = "user"): void {
  restRequestsInFlight.set(credential, (restRequestsInFlight.get(credential) ?? 0) + 1);
}

export function finishGithubRestRequest(coverage: GithubRestCoverage | null, credential = coverage?.credential ?? "user"): void {
  const remaining = (restRequestsInFlight.get(credential) ?? 0) - 1;
  if (remaining > 0) restRequestsInFlight.set(credential, remaining);
  else restRequestsInFlight.delete(credential);
  if (activeGithubRestCoverage(credential) !== coverage) endGithubRestCoverage(credential);
}

export function githubRestRequestsInFlight(credential = "user"): number {
  return restRequestsInFlight.get(credential) ?? 0;
}

export function beginUnmeteredGithubCliOperation(): () => void {
  unmeteredGithubCliOperations++;
  for (const key of restCoverages.keys()) if (!key.startsWith("app:")) endGithubRestCoverage(key);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    unmeteredGithubCliOperations--;
    for (const key of restCoverages.keys()) if (!key.startsWith("app:")) endGithubRestCoverage(key);
  };
}

export interface GithubRestUsageEvent {
  credential?: string;
  credentialKind?: GithubCredentialKind;
  occurredAt: string;
  source: GithubUsageSource | "unknown";
  method: string;
  endpoint: string;
  // repo#number for a pull request or issue route, which the normalized endpoint masks.
  pr: string | null;
  // X-RateLimit-Resource when GitHub sent it, otherwise the pool the path belongs to.
  resource: string;
  // null when the request never got an HTTP response.
  status: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  // null when nothing reliable says whether the primary budget paid for it.
  charged: boolean | null;
  // The coverage span the request was sent and settled in.
  coverageEpoch: string;
}

let restRecorder: (event: GithubRestUsageEvent) => void = () => {};

export function setGithubRestUsageRecorder(next: typeof restRecorder): void {
  restRecorder = next;
}

export function recordGithubRestUsage(event: GithubRestUsageEvent): void {
  try {
    restRecorder(event);
  } catch (error) {
    endGithubRestCoverage(event.credential ?? "user");
    console.error("GitHub REST usage recording failed:", error);
  }
}

// GitHub charges neither GET /rate_limit nor a 304 answer to a conditional request, and any other
// answer that served the request costs one. Refusals, errors, and lost connections may or may not
// have been charged, and their headers cannot say which.
export function githubRestCharged(method: string, endpoint: string, status: number | null): boolean | null {
  if (method === "GET" && endpoint === "/rate_limit") return false;
  if (status === 304) return false;
  if (status !== null && status >= 200 && status < 400) return true;
  return null;
}

const REST_PR_PATH_RE = /^\/repos\/([^/?#]+)\/([^/?#]+)\/(?:issues|pulls)\/([1-9][0-9]*)(?:[/?#]|$)/;

// Pull requests share issue numbers, so an issue route names the same pull request.
export function githubRestPullRequest(path: string): string | null {
  const match = REST_PR_PATH_RE.exec(path);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
}

// The identifier after each collection, named as in GitHub's REST reference.
const REST_PATH_PARAMS: Record<string, string> = {
  alerts: ":alert_number",
  assignees: ":assignee",
  attempts: ":attempt_number",
  blobs: ":file_sha",
  "check-runs": ":check_run_id",
  comments: ":comment_id",
  commits: ":sha",
  issues: ":issue_number",
  jobs: ":job_id",
  labels: ":name",
  pulls: ":pull_number",
  reviews: ":review_id",
  runs: ":run_id",
  trees: ":tree_sha",
  users: ":username",
  workflows: ":workflow_id",
};

// Parameters that may span several segments: branch names, file paths, ref names.
const REST_TRAILING_PARAMS: Record<string, string> = {
  branches: ":branch",
  compare: ":basehead",
  contents: ":path",
  refs: ":ref",
};

const REST_STATIC_SEGMENTS: Record<string, true> = {
  actions: true,
  "code-scanning": true,
  events: true,
  files: true,
  git: true,
  graphql: true,
  logs: true,
  merge: true,
  rate_limit: true,
  replies: true,
  repos: true,
  requested_reviewers: true,
  "rerun-failed-jobs": true,
  rules: true,
  search: true,
  status: true,
  "update-branch": true,
  user: true,
};

const REST_COLLECTION_ROUTES: Record<string, Record<string, true>> = {
  issues: { comments: true, events: true },
  pulls: { comments: true },
};

// Private identifiers remain masked even when they match route keywords.
export function normalizeGithubRestEndpoint(path: string): string {
  const segments = path.replace(/[?#].*$/s, "").split("/").filter(Boolean);
  const template: string[] = [];
  let index = 0;
  if (segments[0] === "repos") {
    template.push("repos", ":owner", ":repo");
    index = 3;
  }
  for (; index < segments.length; index++) {
    const segment = segments[index]!;
    const collection = index > 0 && template.at(-1) === segments[index - 1] ? segments[index - 1]! : null;
    if (collection !== null && Object.hasOwn(REST_TRAILING_PARAMS, collection)) {
      template.push(REST_TRAILING_PARAMS[collection]!);
      break;
    }
    if (collection !== null && Object.hasOwn(REST_PATH_PARAMS, collection)) {
      const routes = Object.hasOwn(REST_COLLECTION_ROUTES, collection) ? REST_COLLECTION_ROUTES[collection] : undefined;
      template.push(routes && Object.hasOwn(routes, segment) ? segment : REST_PATH_PARAMS[collection]!);
    } else {
      const known = Object.hasOwn(REST_PATH_PARAMS, segment)
        || Object.hasOwn(REST_TRAILING_PARAMS, segment)
        || Object.hasOwn(REST_STATIC_SEGMENTS, segment);
      template.push(known ? segment : ":id");
    }
  }
  return `/${template.join("/")}`;
}
