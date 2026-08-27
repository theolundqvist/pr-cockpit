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
