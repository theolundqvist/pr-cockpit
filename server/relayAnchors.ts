import { createHash } from "node:crypto";
import { forEachWithConcurrency } from "./concurrency.ts";
import { getSetting, setSetting } from "./db.ts";
import { fetchCommitTree, fetchRefActivity, fetchRepositoryIdentity, type RefActivity } from "./github.ts";
import { withGithubUsageSource } from "./githubUsage.ts";
import { field } from "./quickGenerate.ts";
import { DEFAULT_RELAY_URL } from "./settings.ts";

// A refused or failed resolution is retried at most this often per repository; activity read for
// coverage is reused for as long.
const RESOLVE_INTERVAL_MS = 10 * 60_000;
// GitHub's activity list can trail the push webhook that rotated the anchor, so a repository
// still presenting its previous proof looks for the new push again much sooner.
const PREVIOUS_RETRY_MS = 60_000;
const ANCHOR_REPOS_PER_REQUEST = 50;
const GITHUB_FANOUT = 4;
const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const ANCHOR_URLS_KEY = "relay_anchor_urls";

export type RelayCapability = "legacy" | "websocket" | "anchors";

export interface RelaySettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const storedSettings: RelaySettings = { get: getSetting, set: setSetting };

function anchorUrls(settings: RelaySettings): string[] {
  const raw = settings.get(ANCHOR_URLS_KEY);
  const urls: unknown = raw === null ? [] : JSON.parse(raw);
  return Array.isArray(urls) ? urls.filter((url) => typeof url === "string") : [];
}

// A relay that ever offered token-free access, and the hosted relay always, must never receive a
// token: answering without anchors would otherwise downgrade the client into sending one.
export function anchorsRequired(url: string, settings: RelaySettings = storedSettings): boolean {
  return url === DEFAULT_RELAY_URL || anchorUrls(settings).includes(url);
}

export async function relayCapability(
  url: string,
  fetcher: typeof fetch = fetch,
  settings: RelaySettings = storedSettings,
): Promise<RelayCapability> {
  const required = anchorsRequired(url, settings);
  const response = await fetcher(`${url}/capabilities`, { signal: AbortSignal.timeout(4_000) });
  if (response.status === 404 && !required) return "legacy";
  if (!response.ok) throw new Error(`relay capabilities responded ${response.status}`);
  const capabilities: unknown = await response.json();
  if (field(capabilities, "stream") !== "websocket-v1") throw new Error("relay advertised an unsupported stream");
  if (field(capabilities, "anchors") === "v1") {
    const urls = anchorUrls(settings);
    if (!urls.includes(url)) settings.set(ANCHOR_URLS_KEY, JSON.stringify([...urls, url]));
    return "anchors";
  }
  if (required) throw new Error("relay no longer advertises token-free access");
  return "websocket";
}

function anchorId(repo: string, repoId: number, after: string): string {
  return createHash("sha256").update(`pr-cockpit-relay anchor\n${repo.toLowerCase()}\n${repoId}\n${after}`).digest("hex");
}

function anchorProof(repo: string, repoId: number, after: string, tree: string): string {
  return createHash("sha256").update(`pr-cockpit-relay proof\n${repo.toLowerCase()}\n${repoId}\n${after}\n${tree}`).digest("hex");
}

export interface AnchorGithub {
  repository(repo: string): Promise<{ id: number; defaultBranch: string }>;
  activity(repo: string, ref: string): Promise<RefActivity[]>;
  tree(repo: string, sha: string): Promise<string>;
}

const githubAnchors: AnchorGithub = {
  repository: (repo) => withGithubUsageSource("relay", () => fetchRepositoryIdentity(repo)),
  activity: (repo, ref) => withGithubUsageSource("relay", () => fetchRefActivity(repo, ref)),
  tree: (repo, sha) => withGithubUsageSource("relay", () => fetchCommitTree(repo, sha)),
};

interface RepoAnchor {
  // Default-branch push SHAs from the last activity read; null until read, or when the next
  // resolution must read afresh.
  candidates: { readAt: number; repoId: number | null; afters: string[] } | null;
  resolvedAt: number | null;
  // Kept after a refusal so a re-match of the same push needs no commit read.
  proof: { after: string; tree: string; proof: string } | null;
  // "previous": rotated away or unmatched since, still presented while the relay's grace may
  // honour it; "none": nothing to present until a resolution matches.
  standing: "proven" | "previous" | "none";
}

export class RelayAnchors {
  private readonly identities = new Map<string, { id: number; defaultBranch: string }>();
  private readonly anchors = new Map<string, RepoAnchor>();

  constructor(private readonly deps: { fetcher?: typeof fetch; github?: AnchorGithub; now?: () => number } = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private entry(url: string, repo: string): RepoAnchor {
    const key = `${url}\n${repo.toLowerCase()}`;
    const known = this.anchors.get(key);
    if (known) return known;
    const created: RepoAnchor = { candidates: null, resolvedAt: null, proof: null, standing: "none" };
    this.anchors.set(key, created);
    return created;
  }

  private due(url: string, repo: string): boolean {
    const { standing, resolvedAt } = this.entry(url, repo);
    if (standing === "proven") return false;
    return resolvedAt === null || this.now() - resolvedAt >= (standing === "previous" ? PREVIOUS_RETRY_MS : RESOLVE_INTERVAL_MS);
  }

  private async readCandidates(url: string, repos: string[]): Promise<void> {
    const github = this.deps.github ?? githubAnchors;
    const stale = repos.filter((repo) => {
      const candidates = this.entry(url, repo).candidates;
      return candidates === null || this.now() - candidates.readAt >= RESOLVE_INTERVAL_MS;
    });
    await forEachWithConcurrency(stale, GITHUB_FANOUT, async (repo) => {
      const readAt = this.now();
      try {
        const key = repo.toLowerCase();
        const identity = this.identities.get(key) ?? await github.repository(repo);
        this.identities.set(key, identity);
        const activity = await github.activity(repo, `refs/heads/${identity.defaultBranch}`);
        const afters = activity
          .filter((entry) => entry.activity_type !== "branch_deletion" && entry.after !== ZERO_SHA && SHA.test(entry.after))
          .map((entry) => entry.after);
        this.entry(url, repo).candidates = { readAt, repoId: identity.id, afters: [...new Set(afters)] };
      } catch (error) {
        // Lost access or exhausted quota: the repository stays on polling until the next read.
        console.warn(`relay anchors unavailable for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
        this.entry(url, repo).candidates = { readAt, repoId: null, afters: [] };
      }
    });
  }

  // Each repository's push the relay holds as its anchor.
  private async match(url: string, repos: string[]): Promise<Map<string, string>> {
    const lookups: Array<[string, Map<string, string>]> = [];
    for (const repo of repos) {
      const candidates = this.entry(url, repo).candidates;
      if (candidates === null || candidates.repoId === null || candidates.afters.length === 0) continue;
      const { repoId } = candidates;
      lookups.push([repo, new Map(candidates.afters.map((after) => [anchorId(repo, repoId, after), after]))]);
    }
    const matched = new Map<string, string>();
    const fetcher = this.deps.fetcher ?? fetch;
    for (let start = 0; start < lookups.length; start += ANCHOR_REPOS_PER_REQUEST) {
      const batch = lookups.slice(start, start + ANCHOR_REPOS_PER_REQUEST);
      const response = await fetcher(`${url}/anchors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repos: Object.fromEntries(batch.map(([repo, ids]) => [repo, [...ids.keys()]])) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`relay anchors responded ${response.status}`);
      const found = field(await response.json(), "repos");
      for (const [repo, ids] of batch) {
        const id = field(found, repo);
        const after = typeof id === "string" ? ids.get(id) : undefined;
        if (after !== undefined) matched.set(repo, after);
      }
    }
    // A renamed default branch or recreated repository shows up as no match.
    for (const repo of repos) if (!matched.has(repo)) this.identities.delete(repo.toLowerCase());
    return matched;
  }

  async coverage(url: string, repos: string[]): Promise<Record<string, boolean>> {
    const unique = [...new Set(repos)];
    await this.readCandidates(url, unique);
    const matched = await this.match(url, unique);
    return Object.fromEntries(unique.map((repo) => [repo, matched.has(repo)]));
  }

  // Cached proofs first; only repositories without a proven proof that are due resolve again.
  async proofs(url: string, repos: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(repos)];
    const due = unique.filter((repo) => this.due(url, repo));
    if (due.length > 0) {
      const github = this.deps.github ?? githubAnchors;
      await this.readCandidates(url, due);
      const matched = await this.match(url, due);
      const resolvedAt = this.now();
      await forEachWithConcurrency(due, GITHUB_FANOUT, async (repo) => {
        const entry = this.entry(url, repo);
        entry.resolvedAt = resolvedAt;
        const matchedAfter = matched.get(repo);
        // During the grace the relay still matches the rotated-away anchor; only a new push is progress.
        const after = entry.standing === "previous" && matchedAfter === entry.proof?.after ? undefined : matchedAfter;
        const repoId = entry.candidates?.repoId ?? null;
        if (after === undefined || repoId === null) {
          // The relay decides whether the previous proof is still within its grace.
          if (entry.standing === "previous") entry.candidates = null;
          return;
        }
        try {
          const tree = entry.proof?.after === after ? entry.proof.tree : await github.tree(repo, after);
          entry.proof = { after, tree, proof: anchorProof(repo, repoId, after, tree) };
          entry.standing = "proven";
        } catch (error) {
          console.warn(`relay anchor commit unavailable for ${repo}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    return Object.fromEntries(unique.flatMap((repo) => {
      const { standing, proof } = this.entry(url, repo);
      return standing !== "none" && proof !== null ? [[repo, proof.proof]] : [];
    }));
  }

  // Marks proofs the relay refused; true when any of them may be resolved again right away.
  reject(url: string, repos: string[]): boolean {
    for (const repo of repos) {
      const entry = this.entry(url, repo);
      entry.standing = "none";
      entry.candidates = null;
      // A recreated repository keeps its name but not its id.
      this.identities.delete(repo.toLowerCase());
    }
    return repos.some((repo) => this.due(url, repo));
  }

  // The relay rotated the repository's anchor: the next session proves it from fresh activity,
  // presenting the previous proof meanwhile.
  rotate(url: string, repo: string): void {
    const entry = this.entry(url, repo);
    entry.candidates = null;
    entry.resolvedAt = null;
    if (entry.standing === "proven") entry.standing = "previous";
  }
}

export const relayAnchors = new RelayAnchors();
