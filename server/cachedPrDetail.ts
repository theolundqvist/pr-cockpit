import { getCachedPrDetail, upsertCachedPrDetail } from "./db.ts";
import { fetchPrDetail, fetchPrDetailPart, type PrDetail, type PrDetailScope } from "./github.ts";
import type { GithubUsageSource } from "./githubUsage.ts";
import { invalidatePr } from "./rendererInvalidation.ts";
import { cacheGithubActionsForCommit } from "./runLogs.ts";

export interface CachedPrDetailDeps {
  fetchPrDetail: typeof fetchPrDetail;
  fetchPrDetailPart: typeof fetchPrDetailPart;
  cacheGithubActionsForCommit: typeof cacheGithubActionsForCommit;
}

const defaultDeps: CachedPrDetailDeps = { fetchPrDetail, fetchPrDetailPart, cacheGithubActionsForCommit };

// Refreshes the detail snapshot of a PR outside the tracked inbox (one the user opened from
// All PRs or a link). Like a tracked refresh, the snapshot is published before the Actions
// catalog lands and the renderer is told again once it has.
export async function refreshCachedPrDetail(
  repo: string,
  number: number,
  source: GithubUsageSource,
  scope: PrDetailScope = "all",
  deps: Partial<CachedPrDetailDeps> = {},
): Promise<void> {
  const { fetchPrDetail, fetchPrDetailPart, cacheGithubActionsForCommit } = { ...defaultDeps, ...deps };
  const snapshotCutoffAt = new Date().toISOString();
  const cached = getCachedPrDetail(repo, number);
  const current = cached ? JSON.parse(cached.detail_json) as PrDetail : null;
  const detail = scope === "all" || current === null
    ? await fetchPrDetail(repo, number, source, current)
    : await fetchPrDetailPart(repo, number, current, scope, source);
  upsertCachedPrDetail({
    repo,
    number,
    head_sha: detail.headRefOid,
    detail_json: JSON.stringify(detail),
    fetched_at: snapshotCutoffAt,
  });
  invalidatePr(repo, number);
  if (scope === "review") return;
  await cacheGithubActionsForCommit(repo, number, detail.headRefOid, undefined, true)
    .catch((error) => console.error(`Actions coverage refresh failed for ${repo}#${number}:`, error));
  invalidatePr(repo, number);
}
