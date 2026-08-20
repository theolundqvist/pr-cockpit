const GREPTILE_LOGIN = "greptile-apps";
export const KNOWN_BOT_LOGINS = new Set([GREPTILE_LOGIN, "cursor"]);
const CONFIDENCE_RE = /Confidence Score:\s*(\d)\/5/i;
const REVIEWED_COMMIT_RE = /Last reviewed commit:.*?\/commit\/([0-9a-f]{40})/is;

// mirrors server/poller.ts's greptile parsing - derived client-side since PrDetail.svelte has the raw PR detail, not the flattened inbox row
export function greptileReviewMeta(pr) {
  const comments = pr?.comments?.nodes ?? [];
  const scored = comments.filter((c) => c.author?.login === GREPTILE_LOGIN && CONFIDENCE_RE.test(c.body));
  const last = scored[scored.length - 1] ?? null;
  const confidence = last ? Number(last.body.match(CONFIDENCE_RE)[1]) : null;
  const reviewedSha = last?.body.match(REVIEWED_COMMIT_RE)?.[1] ?? null;
  const unresolvedCount = (pr?.reviewThreads?.nodes ?? []).filter(
    (t) => !t.isResolved && !t.isOutdated && t.comments?.nodes?.[0]?.author?.login === GREPTILE_LOGIN,
  ).length;
  return { confidence, reviewedSha, unresolvedCount };
}

export function greptileStatus(meta, headSha) {
  if (meta.confidence == null) return null;
  if (!meta.reviewedSha || meta.reviewedSha === headSha) return null;
  return meta.unresolvedCount === 0 ? "addressed" : "stale";
}
