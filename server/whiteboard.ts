import { db, getSetting, setSetting, listPrs, listPrIndex } from "./db.ts";
import { emptyBoard, validateBoard, boardKey, normalizeBoardPr } from "../shared/whiteboard.js";
import type { BoardDocument, BoardPr } from "../shared/whiteboard.js";

const KEY = "personal_whiteboard_v1";
const MAX_BYTES = 8 * 1024 * 1024;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function stored() {
  const raw = getSetting(KEY);
  if (raw === null) return { revision: 0, document: emptyBoard() };
  const value = JSON.parse(raw);
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Invalid whiteboard revision");
  validateBoard(value.document);
  return value;
}

function metadata(document: BoardDocument) {
  const keys = new Set(document.nodes.filter((n) => n.type === "pr").map((n) => n.key));
  const rows = new Map<string, BoardPr>(listPrs().map((pr) => [boardKey(pr), normalizeBoardPr({
    repo: pr.repo, number: pr.number, title: pr.title, author: pr.author, state: pr.state,
    isDraft: pr.is_draft === 1, baseRef: pr.base_ref, headRef: pr.head_ref, headSha: pr.head_sha,
    additions: pr.additions, deletions: pr.deletions, ciStatus: pr.ci_status, reviewDecision: pr.review_decision,
    mergeable: pr.mergeable, mergeStateStatus: pr.merge_state_status, unresolvedCount: pr.unresolved_count,
    viewerIsAuthor: pr.viewer_is_author === 1, viewerReviewRequested: pr.viewer_review_requested === 1,
    updatedAt: pr.updated_at, cachedAt: pr.fetched_at, available: true,
  })]));
  for (const pr of listPrIndex()) {
    const key = boardKey(pr);
    if (!keys.has(key)) continue;
    const tracked = rows.get(key);
    if (tracked && (tracked.updatedAt ?? "") >= pr.updated_at) continue;
    if (!tracked && (document.snapshots[key]?.updatedAt ?? "") > pr.updated_at) continue;
    rows.set(key, normalizeBoardPr({ ...(tracked ?? document.snapshots[key]), repo: pr.repo, number: pr.number, title: pr.title,
      author: pr.author, state: pr.state, isDraft: pr.is_draft === 1, updatedAt: pr.updated_at,
      available: !!tracked, cachedAt: tracked?.cachedAt ?? pr.updated_at }));
  }
  return [...rows.values()];
}

const save = db.transaction((revision: number, document: BoardDocument) => {
  const current = stored();
  if (revision !== current.revision) return null;
  const next = { revision: revision + 1, document };
  setSetting(KEY, JSON.stringify(next));
  return next.revision;
});

export async function handleWhiteboard(req: Request): Promise<Response> {
  if (getSetting("whiteboard_enabled") !== "true") return response({ error: "Whiteboard is disabled" }, 404);
  if (req.method === "GET") {
    if (new URL(req.url).searchParams.has("raw")) return new Response(getSetting(KEY) ?? "null", { headers: { "content-type": "application/json", "content-disposition": "attachment; filename=whiteboard-recovery.json" } });
    try {
      const value = stored();
      return response({ ...value, prs: metadata(value.document) });
    } catch {
      return response({ error: "Saved whiteboard could not be read. Your original data is intact; export it for recovery. No reset was performed." }, 422);
    }
  }
  if (req.method !== "PUT") return response({ error: "Method not allowed" }, 405);
  try {
    // Bound the actual stream, not only the untrusted Content-Length header.
    const reader = req.body?.getReader();
    if (!reader) return response({ error: "Missing whiteboard document" }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); return response({ error: "Whiteboard exceeds the 8 MB limit. Export your work before removing objects." }, 413); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) return response({ error: "Invalid revision" }, 400);
    validateBoard(body.document);
    // Settings may change while the request body is still arriving.
    if (getSetting("whiteboard_enabled") !== "true") return response({ error: "Whiteboard is disabled" }, 404);
    const revision = save(body.revision, body.document);
    if (revision === null) return response({ error: "This board changed in another window. Your edits are kept here; choose which version to save." }, 409);
    return response({ revision });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "Whiteboard could not be saved" }, 400);
  }
}
