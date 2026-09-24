import { expect, test } from "bun:test";
import { refreshCachedPrDetail } from "./cachedPrDetail.ts";
import { db, getCachedPrDetail, upsertCachedPrDetail } from "./db.ts";
import type { PrDetail } from "./github.ts";
import { setRendererInvalidationPublisher, type RendererInvalidation } from "./rendererInvalidation.ts";

test("an untracked refresh publishes before the Actions catalog and honours the event scope", async () => {
  const repo = "cached-detail/scope";
  const number = 4242;
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  const stored = { headRefOid: oldHead, title: "stored" } as unknown as PrDetail;
  upsertCachedPrDetail({ repo, number, head_sha: oldHead, detail_json: JSON.stringify(stored), fetched_at: "2026-09-01T00:00:00.000Z" });
  const log: string[] = [];
  setRendererInvalidationPublisher((event: RendererInvalidation) => {
    if (event.type === "pr") log.push(`invalidate ${getCachedPrDetail(repo, number)?.head_sha === newHead ? "new" : "old"}`);
  });
  try {
    await refreshCachedPrDetail(repo, number, "relay", "checks", {
      fetchPrDetail: async () => { throw new Error("a checks event must not refetch the whole detail"); },
      fetchPrDetailPart: async (_repo, _number, current, scope) => {
        log.push(`part ${scope} ${(current as unknown as { title: string }).title}`);
        return { ...current, headRefOid: newHead };
      },
      cacheGithubActionsForCommit: async (_repo, _number, head) => {
        log.push(`actions ${head === newHead ? "new" : "old"}`);
        return undefined as never;
      },
    });
    expect(log).toEqual(["part checks stored", "invalidate new", "actions new", "invalidate new"]);

    log.length = 0;
    await refreshCachedPrDetail(repo, number, "relay", "review", {
      fetchPrDetailPart: async (_repo, _number, current) => current,
      cacheGithubActionsForCommit: async () => {
        log.push("actions");
        return undefined as never;
      },
    });
    expect(log).toEqual(["invalidate new"]);
  } finally {
    setRendererInvalidationPublisher(() => {});
    db.run("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?", [repo, number]);
  }
});
