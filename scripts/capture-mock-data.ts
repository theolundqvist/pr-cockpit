// Capture a repo's open PRs into an offline mock snapshot: bun scripts/capture-mock-data.ts microsoft/vscode --count 15 --history-path src/vs/code/electron-main/app.ts --history-pr 326431
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchDiff,
  fetchFileHistory,
  fetchFileHistoryDiff,
  fetchPrDetail,
  getViewerLogin,
  type FileHistoryDiff,
  type PrDetail,
} from "../server/github.ts";
import { extractGithubImageUrls } from "../server/imageproxy.ts";

interface Args {
  repo: string;
  count: number;
  historyPath: string;
  historyPr: number;
  include: number[];
}

function parseArgs(argv: string[]): Args {
  const [repo, ...rest] = argv;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error("usage: capture-mock-data.ts <owner/repo> [--count N] [--history-path P] [--history-pr N]");
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (!key || rest[i + 1] === undefined) throw new Error(`missing value for ${rest[i]}`);
    opts[key] = rest[i + 1]!;
  }
  return {
    repo,
    count: Number(opts.count ?? 15),
    historyPath: opts["history-path"] ?? "",
    historyPr: Number(opts["history-pr"] ?? 0),
    include: (opts.include ?? "").split(",").map((n) => Number(n.trim())).filter(Boolean),
  };
}

const ghImgBin = Bun.env.COCKPIT_GH_IMG ?? `${Bun.env.HOME}/dev/gh-img/gh-img`;

async function openPrNumbers(repo: string, count: number): Promise<number[]> {
  // custom search, deliberately WITHOUT involves:@me so it works on any public repo
  const proc = Bun.spawn(["gh", "pr", "list", "-R", repo, "--state", "open", "--limit", String(count), "--search", "sort:updated-desc", "--json", "number"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`gh pr list failed: ${err}`);
  return (JSON.parse(out) as Array<{ number: number }>).map((r) => r.number);
}

function avatarUrls(detail: PrDetail): string[] {
  const urls = new Set<string>();
  const add = (u: string | undefined) => { if (u) urls.add(u); };
  add(detail.author?.avatarUrl);
  for (const r of detail.reviews.nodes) add(r.author?.avatarUrl);
  for (const c of detail.comments.nodes) add(c.author?.avatarUrl);
  for (const t of detail.reviewThreads.nodes) for (const c of t.comments.nodes) add(c.author?.avatarUrl);
  for (const c of detail.commitList.nodes) add(c.commit.author?.user?.avatarUrl);
  for (const r of detail.reviewRequests.nodes) add(r.requestedReviewer?.avatarUrl);
  return [...urls];
}

function bodyImageUrls(detail: PrDetail): string[] {
  const bodies = [detail.body];
  for (const r of detail.reviews.nodes) bodies.push(r.body);
  for (const c of detail.comments.nodes) bodies.push(c.body);
  for (const t of detail.reviewThreads.nodes) for (const c of t.comments.nodes) bodies.push(c.body);
  return [...new Set(bodies.flatMap(extractGithubImageUrls))];
}

function ext(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return ".gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return ".webp";
  return ".bin";
}

async function ghImgBytes(url: string): Promise<Uint8Array> {
  const proc = Bun.spawn([ghImgBin, "get", url], { stdout: "pipe", stderr: "pipe" });
  const [buf, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`gh-img get ${url}: ${err}`);
  return new Uint8Array(buf);
}

async function httpsBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const viewer = await getViewerLogin();
  const outDir = resolve(import.meta.dirname, "..", "server", "mockData", args.repo.replace("/", "-"));
  const blobsDir = `${outDir}/blobs`;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(blobsDir, { recursive: true });

  const recent = await openPrNumbers(args.repo, args.count);
  const numbers = [...new Set([...args.include, ...recent])].slice(0, args.count);
  const details: PrDetail[] = [];
  const diffs: Record<number, string> = {};
  for (const number of numbers) {
    const detail = await fetchPrDetail(args.repo, number);
    details.push(detail);
    diffs[number] = await fetchDiff(args.repo, number);
    console.log(`captured #${number} [${detail.author?.login}] ${detail.title.slice(0, 55)}`);
  }

  const assets: Record<string, string> = {};
  const writeAsset = async (url: string, fetcher: (u: string) => Promise<Uint8Array>) => {
    if (assets[url]) return;
    try {
      const bytes = await fetcher(url);
      const name = new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 16) + ext(bytes);
      writeFileSync(`${blobsDir}/${name}`, bytes);
      assets[url] = name;
    } catch (err) {
      console.error(`  skip asset ${url}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const imageUrls = [...new Set(details.flatMap(bodyImageUrls))];
  const avatarSet = [...new Set(details.flatMap(avatarUrls))];
  for (const url of imageUrls) await writeAsset(url, ghImgBytes);
  for (const url of avatarSet) await writeAsset(url, httpsBytes);
  console.log(`captured ${Object.keys(assets).length} assets (${imageUrls.length} images, ${avatarSet.length} avatars)`);

  let history = { repo: args.repo, path: args.historyPath, base: "main", commits: [] as Awaited<ReturnType<typeof fetchFileHistory>> };
  const historyDiffs: Record<string, FileHistoryDiff> = {};
  if (args.historyPath && args.historyPr) {
    const base = details.find((d) => d.number === args.historyPr)?.baseRefName ?? "main";
    history = { repo: args.repo, path: args.historyPath, base, commits: await fetchFileHistory(args.repo, args.historyPath, base) };
    for (const commit of history.commits) {
      const diff = await fetchFileHistoryDiff(args.repo, commit.sha, args.historyPath).catch(() => null);
      if (diff) historyDiffs[commit.sha] = diff;
    }
    console.log(`captured file history for ${args.historyPath}: ${history.commits.length} commits`);
  }

  const snapshot = { repo: args.repo, viewer, capturedAt: new Date().toISOString(), details, diffs, history, historyDiffs, assets };
  writeFileSync(`${outDir}/snapshot.json`, JSON.stringify(snapshot, null, 2));
  console.log(`\nwrote snapshot to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
