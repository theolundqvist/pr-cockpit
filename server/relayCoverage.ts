import { ghToken } from "./github.ts";
import { relayConfig } from "./settings.ts";

type Coverage = Record<string, boolean>;
type CoverageLookup = (url: string, repos: string[]) => Promise<Coverage>;

// The inbox re-reads coverage after every PR refresh, which cost a relay round trip (0.1-0.8s)
// each time. Full coverage is remembered briefly; a result with an uncovered repository is
// never reused, so onboarding still sees an installation the moment it lands.
const FULL_COVERAGE_TTL_MS = 5 * 60_000;

async function fetchRelayCoverage(url: string, repos: string[]): Promise<Coverage> {
  const res = await fetch(`${url}/coverage?repos=${encodeURIComponent(repos.join(","))}`, {
    headers: { Authorization: `Bearer ${await ghToken()}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`relay coverage failed: ${res.status} ${await res.text()}`);
  const { repos: coverage } = (await res.json()) as { repos: Coverage };
  return coverage;
}

export function createRelayCoverage(
  lookup: CoverageLookup = fetchRelayCoverage,
  now: () => number = Date.now,
): (repos: string[], url?: string) => Promise<Coverage> {
  let full: { key: string; at: number; coverage: Coverage } | null = null;
  return async (repos, url = relayConfig().url) => {
    const key = `${url}\n${[...new Set(repos)].sort().join(",")}`;
    if (full?.key === key && now() - full.at < FULL_COVERAGE_TTL_MS) return full.coverage;
    const coverage = await lookup(url, repos);
    const covered = repos.every((repo) => coverage[repo] === true);
    full = covered ? { key, at: now(), coverage } : null;
    return coverage;
  };
}

export const relayCoverage = createRelayCoverage();
