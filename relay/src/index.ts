import { DurableObject } from "cloudflare:workers";

interface Env {
  WEBHOOK_SECRET: string;
  EVENTS: DurableObjectNamespace<Events>;
}

interface Marker {
  seq: number;
  ts: number;
  repo: string;
  number: number | null;
  event: string;
}

interface Coverage {
  all: boolean;
  repos: string[];
}

const CAP = 1000;
const PAGE = 500;
const ACCESS_TTL_MS = 60 * 60 * 1000;

export class Events extends DurableObject<Env> {
  seq = 0;
  events: Marker[] = [];
  coverage: Record<string, Coverage> = {};
  access = new Map<string, { readable: boolean; expires: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.seq = (await ctx.storage.get<number>("seq")) ?? 0;
      this.events = (await ctx.storage.get<Marker[]>("events")) ?? [];
      this.coverage = (await ctx.storage.get<Record<string, Coverage>>("coverage")) ?? {};
    });
  }

  async append(marker: Omit<Marker, "seq">): Promise<void> {
    this.seq++;
    this.events.push({ seq: this.seq, ...marker });
    if (this.events.length > CAP) this.events.splice(0, this.events.length - CAP);
    const owner = marker.repo.split("/")[0];
    const entry = (this.coverage[owner] ??= { all: false, repos: [] });
    const seed = !entry.all && !entry.repos.includes(marker.repo);
    if (seed) entry.repos.push(marker.repo);
    await this.ctx.storage.put(
      seed
        ? { seq: this.seq, events: this.events, coverage: this.coverage }
        : { seq: this.seq, events: this.events },
    );
  }

  async installation(event: string, payload: any): Promise<void> {
    const account = payload.installation?.account?.login;
    if (!account) return;
    const all = payload.installation.repository_selection === "all";
    if (event === "installation") {
      if (payload.action === "created" || payload.action === "unsuspend") {
        this.coverage[account] = { all, repos: (payload.repositories ?? []).map((r: any) => r.full_name) };
      } else if (payload.action === "deleted" || payload.action === "suspend") {
        delete this.coverage[account];
      } else return;
    } else if (payload.action === "added" || payload.action === "removed") {
      const entry = (this.coverage[account] ??= { all: false, repos: [] });
      entry.all = all;
      const removed = new Set((payload.repositories_removed ?? []).map((r: any) => r.full_name));
      entry.repos = entry.repos.filter((r) => !removed.has(r));
      for (const r of payload.repositories_added ?? []) {
        if (!entry.repos.includes(r.full_name)) entry.repos.push(r.full_name);
      }
    } else return;
    await this.ctx.storage.put("coverage", this.coverage);
  }

  async coverageFor(
    repos: string[],
    tokenHash: string,
  ): Promise<{ covered: Record<string, boolean>; verdicts: Record<string, boolean> }> {
    const covered: Record<string, boolean> = {};
    const verdicts: Record<string, boolean> = {};
    for (const repo of repos) {
      const entry = this.coverage[repo.split("/")[0]];
      covered[repo] = entry !== undefined && (entry.all || entry.repos.includes(repo));
      const verdict = this.cachedVerdict(tokenHash, repo);
      if (verdict !== undefined) verdicts[repo] = verdict;
    }
    return { covered, verdicts };
  }

  async list(
    since: number | null,
    tokenHash: string,
  ): Promise<{ latest: number; events: Marker[]; verdicts: Record<string, boolean> }> {
    if (since === null || since > this.seq) return { latest: this.seq, events: [], verdicts: {} };
    const events = this.events.filter((e) => e.seq > since).slice(0, PAGE);
    const verdicts: Record<string, boolean> = {};
    for (const e of events) {
      const verdict = this.cachedVerdict(tokenHash, e.repo);
      if (verdict !== undefined) verdicts[e.repo] = verdict;
    }
    return { latest: this.seq, events, verdicts };
  }

  async putVerdicts(tokenHash: string, verdicts: Record<string, boolean>): Promise<void> {
    for (const [repo, readable] of Object.entries(verdicts)) {
      this.access.set(`${tokenHash}:${repo}`, { readable, expires: Date.now() + ACCESS_TTL_MS });
    }
  }

  private cachedVerdict(tokenHash: string, repo: string): boolean | undefined {
    const key = `${tokenHash}:${repo}`;
    const entry = this.access.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.access.delete(key);
      return undefined;
    }
    return entry.readable;
  }
}

async function validSignature(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const claimed = header.slice("sha256=".length);
  if (claimed.length !== mac.length * 2) return false;
  const claimedBytes = new Uint8Array(mac.length);
  for (let i = 0; i < mac.length; i++) {
    const byte = parseInt(claimed.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return false;
    claimedBytes[i] = byte;
  }
  return crypto.subtle.timingSafeEqual(mac, claimedBytes);
}

function prNumber(payload: any): number | null {
  return (
    payload.pull_request?.number ??
    payload.issue?.number ??
    payload.check_run?.pull_requests?.[0]?.number ??
    payload.check_suite?.pull_requests?.[0]?.number ??
    null
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function repoReadable(token: string, repo: string): Promise<boolean | "bad-token"> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pr-cockpit-relay",
    },
  });
  if (res.status === 401) return "bad-token";
  return res.status === 200;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.EVENTS.get(env.EVENTS.idFromName("events"));

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method === "POST" && url.pathname === "/github") {
      const body = await request.arrayBuffer();
      const ok = await validSignature(env.WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256"));
      if (!ok) return new Response("bad signature", { status: 401 });
      const payload = JSON.parse(new TextDecoder().decode(body));
      const event = request.headers.get("X-GitHub-Event") ?? "unknown";
      if (event === "installation" || event === "installation_repositories") {
        await stub.installation(event, payload);
        return new Response("ok");
      }
      const repo = payload.repository?.full_name;
      if (!repo) return new Response("no repository", { status: 202 });
      await stub.append({
        ts: Date.now(),
        repo,
        number: prNumber(payload),
        event,
      });
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/events") {
      const auth = request.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
      const token = auth.slice("Bearer ".length);
      const tokenHash = await sha256Hex(token);
      const raw = url.searchParams.get("since");
      const since = raw === null || !/^\d+$/.test(raw) ? null : Number(raw);
      const { latest, events, verdicts } = await stub.list(since, tokenHash);
      const unverified = [...new Set(events.map((e) => e.repo))].filter((r) => !(r in verdicts));
      if (unverified.length > 0) {
        const fresh: Record<string, boolean> = {};
        for (const repo of unverified) {
          const readable = await repoReadable(token, repo);
          if (readable === "bad-token") return new Response("unauthorized", { status: 401 });
          fresh[repo] = readable;
        }
        await stub.putVerdicts(tokenHash, fresh);
        Object.assign(verdicts, fresh);
      }
      return Response.json({ latest, events: events.filter((e) => verdicts[e.repo]) });
    }

    if (request.method === "GET" && url.pathname === "/coverage") {
      const auth = request.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
      const token = auth.slice("Bearer ".length);
      const tokenHash = await sha256Hex(token);
      const repos = (url.searchParams.get("repos") ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
        .slice(0, 50);
      const { covered, verdicts } = await stub.coverageFor(repos, tokenHash);
      const unverified = [...new Set(repos)].filter((r) => covered[r] && !(r in verdicts));
      if (unverified.length > 0) {
        const fresh: Record<string, boolean> = {};
        for (const repo of unverified) {
          const readable = await repoReadable(token, repo);
          if (readable === "bad-token") return new Response("unauthorized", { status: 401 });
          fresh[repo] = readable;
        }
        await stub.putVerdicts(tokenHash, fresh);
        Object.assign(verdicts, fresh);
      }
      return Response.json({
        repos: Object.fromEntries(repos.map((r) => [r, Boolean(verdicts[r] && covered[r])])),
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
