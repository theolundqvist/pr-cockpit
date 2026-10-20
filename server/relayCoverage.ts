import { ghToken } from "./github.ts";
import { field } from "./quickGenerate.ts";
import { relayAnchors, relayCapability, type RelayAnchors, type RelaySettings } from "./relayAnchors.ts";
import { relayConfig } from "./settings.ts";

type Coverage = Record<string, boolean>;
type CoverageLookup = (url: string, repos: string[]) => Promise<Coverage>;

// The inbox re-reads coverage after every PR refresh, which cost a relay round trip (0.1-0.8s)
// each time. Full coverage is remembered briefly; a result with an uncovered repository is
// never reused, so onboarding still sees an installation the moment it lands.
const FULL_COVERAGE_TTL_MS = 5 * 60_000;

// Anchor relays report a repository as covered when they hold its anchor. Others are asked with
// the token, after re-reading capabilities so a relay that has since offered token-free access
// never receives it.
export function createRelayCoverageLookup(deps: {
  fetcher?: typeof fetch;
  token?: typeof ghToken;
  anchors?: RelayAnchors;
  settings?: RelaySettings;
} = {}): CoverageLookup {
  const anchorRelays = new Set<string>();
  return async (url, repos) => {
    const fetcher = deps.fetcher ?? fetch;
    if (!anchorRelays.has(url) && await relayCapability(url, fetcher, deps.settings) === "anchors") anchorRelays.add(url);
    if (anchorRelays.has(url)) return (deps.anchors ?? relayAnchors).coverage(url, repos);
    const res = await fetcher(`${url}/coverage?repos=${encodeURIComponent(repos.join(","))}`, {
      headers: { Authorization: `Bearer ${await (deps.token ?? ghToken)()}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`relay coverage failed: ${res.status} ${await res.text()}`);
    const found = field(await res.json(), "repos");
    return Object.fromEntries(repos.flatMap((repo) => {
      const covered = field(found, repo);
      return typeof covered === "boolean" ? [[repo, covered]] : [];
    }));
  };
}

export function createRelayCoverage(
  lookup: CoverageLookup = createRelayCoverageLookup(),
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
