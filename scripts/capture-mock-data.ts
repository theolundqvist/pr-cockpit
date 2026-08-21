// Capture exact open PRs into an offline mock snapshot:
// bun scripts/capture-mock-data.ts microsoft/vscode --numbers 1,2 --conversation-pr 1 --files-pr 2 --editing-pr 2 --history-pr 2 --palette-pr 1
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  fetchDiff,
  fetchFileContents,
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
  numbers: number[];
  conversationPr: number;
  filesPr: number;
  editingPr: number;
  editingPath: string;
  historyPr: number;
  historyPath: string;
  palettePr: number;
}

function parseArgs(argv: string[]): Args {
  const [repo, ...rest] = argv;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error("usage: capture-mock-data.ts <owner/repo> --numbers N,N --conversation-pr N --files-pr N --editing-pr N [--editing-path P] --history-pr N [--history-path P] --palette-pr N");
  }
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (!key || rest[i + 1] === undefined) throw new Error(`missing value for ${rest[i]}`);
    opts[key] = rest[i + 1]!;
  }
  const numbers = (opts.numbers ?? "").split(",").map((value) => Number(value.trim())).filter(Number.isInteger);
  const requiredNumber = (key: string): number => {
    const value = Number(opts[key]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${key} must be a positive PR number`);
    return value;
  };
  if (!numbers.length || numbers.some((number) => number <= 0)) throw new Error("--numbers must contain exact positive PR numbers");
  const args = {
    repo,
    numbers: [...new Set(numbers)],
    conversationPr: requiredNumber("conversation-pr"),
    filesPr: requiredNumber("files-pr"),
    editingPr: requiredNumber("editing-pr"),
    editingPath: opts["editing-path"] ?? "",
    historyPr: requiredNumber("history-pr"),
    historyPath: opts["history-path"] ?? "",
    palettePr: requiredNumber("palette-pr"),
  };
  for (const number of [args.conversationPr, args.filesPr, args.editingPr, args.historyPr, args.palettePr]) {
    if (!args.numbers.includes(number)) throw new Error(`role PR #${number} is not present in --numbers`);
  }
  return args;
}

const ghImgBin = Bun.env.COCKPIT_GH_IMG ?? `${Bun.env.HOME}/dev/gh-img/gh-img`;

function avatarUrls(detail: PrDetail): string[] {
  const urls = new Set<string>();
  const add = (url: string | undefined) => {
    if (url) urls.add(url);
  };
  add(detail.author?.avatarUrl);
  for (const review of detail.reviews.nodes) add(review.author?.avatarUrl);
  for (const comment of detail.comments.nodes) add(comment.author?.avatarUrl);
  for (const thread of detail.reviewThreads.nodes) {
    for (const comment of thread.comments.nodes) add(comment.author?.avatarUrl);
  }
  for (const commit of detail.commitList.nodes) add(commit.commit.author?.user?.avatarUrl);
  for (const request of detail.reviewRequests.nodes) add(request.requestedReviewer?.avatarUrl);
  return [...urls];
}

function bodyImageUrls(detail: PrDetail): string[] {
  const bodies = [detail.body];
  for (const review of detail.reviews.nodes) bodies.push(review.body);
  for (const comment of detail.comments.nodes) bodies.push(comment.body);
  for (const thread of detail.reviewThreads.nodes) {
    for (const comment of thread.comments.nodes) bodies.push(comment.body);
  }
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

async function editableFile(repo: string, detail: PrDetail, requestedPath: string): Promise<{ path: string; content: string }> {
  const candidates = requestedPath
    ? [requestedPath]
    : detail.files.nodes
      .filter((file) => /\.(?:[cm]?[jt]sx?|css|svelte|rs)$/.test(file.path) && !/(?:^|\/)(?:test|tests|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(file.path))
      .sort((left, right) => {
        const leftSource = left.path.includes("/src/") || left.path.startsWith("src/") ? 1 : 0;
        const rightSource = right.path.includes("/src/") || right.path.startsWith("src/") ? 1 : 0;
        return rightSource - leftSource || (right.additions + right.deletions) - (left.additions + left.deletions) || left.path.localeCompare(right.path);
      })
      .map((file) => file.path);

  for (const path of candidates) {
    try {
      const result = await fetchFileContents(repo, path, detail.headRefOid);
      if ("tooLarge" in result) continue;
      const lines = result.content.split(/\r?\n/).length;
      if (lines >= 30 && lines <= 800 && result.content.length >= 1_000 && result.content.length <= 80_000) {
        return { path, content: result.content };
      }
    } catch {
      if (requestedPath) throw new Error(`unable to capture requested editable file ${requestedPath}`);
    }
  }
  throw new Error(`no moderate editable source file found in ${repo}#${detail.number}`);
}

function installSnapshot(tempDir: string, outDir: string): void {
  const backupDir = `${outDir}.previous-${process.pid}-${Date.now()}`;
  const hadPrevious = existsSync(outDir);
  if (hadPrevious) renameSync(outDir, backupDir);
  try {
    renameSync(tempDir, outDir);
  } catch (error) {
    if (hadPrevious) renameSync(backupDir, outDir);
    throw error;
  }
  if (hadPrevious) rmSync(backupDir, { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const viewer = await getViewerLogin();
  const outDir = resolve(import.meta.dirname, "..", "server", "mockData", args.repo.replace("/", "-"));
  const tempDir = mkdtempSync(join(dirname(outDir), `.${args.repo.replace("/", "-")}-`));
  const blobsDir = join(tempDir, "blobs");
  mkdirSync(blobsDir);
  let installed = false;

  try {
    const details: PrDetail[] = [];
    const diffs: Record<number, string> = {};
    for (const number of args.numbers) {
      const detail = await fetchPrDetail(args.repo, number);
      if (detail.state !== "OPEN") throw new Error(`${args.repo}#${number} is ${detail.state}, expected OPEN`);
      details.push(detail);
      diffs[number] = await fetchDiff(args.repo, number);
      console.log(`captured #${number} [${detail.author?.login}] ${detail.title}`);
    }
    const detailFor = (number: number): PrDetail => details.find((detail) => detail.number === number)!;

    const assets: Record<string, string> = {};
    const writeAsset = async (url: string, fetcher: (assetUrl: string) => Promise<Uint8Array>) => {
      if (assets[url]) return;
      const bytes = await fetcher(url);
      const name = new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 16) + ext(bytes);
      writeFileSync(join(blobsDir, name), bytes);
      assets[url] = name;
    };
    const imageUrls = [...new Set(details.flatMap(bodyImageUrls))];
    const avatarSet = [...new Set(details.flatMap(avatarUrls))];
    for (const url of imageUrls) await writeAsset(url, ghImgBytes);
    for (const url of avatarSet) await writeAsset(url, httpsBytes);
    console.log(`captured ${Object.keys(assets).length} assets (${imageUrls.length} images, ${avatarSet.length} avatars)`);

    const editingDetail = detailFor(args.editingPr);
    const editing = await editableFile(args.repo, editingDetail, args.editingPath);
    const fileContents = { [`${editingDetail.headRefOid}:${editing.path}`]: editing.content };
    console.log(`captured editable file ${editing.path} at ${editingDetail.headRefOid} (${editing.content.length} bytes)`);

    const historyDetail = detailFor(args.historyPr);
    const historyPath = args.historyPath || editing.path;
    const history = {
      repo: args.repo,
      path: historyPath,
      base: historyDetail.baseRefName,
      commits: await fetchFileHistory(args.repo, historyPath, historyDetail.baseRefName),
    };
    if (!history.commits.length) throw new Error(`no file history captured for ${historyPath}`);
    const historyDiffs: Record<string, FileHistoryDiff> = {};
    for (const commit of history.commits) {
      const diff = await fetchFileHistoryDiff(args.repo, commit.sha, historyPath);
      if (!diff) throw new Error(`no history diff for ${historyPath} at ${commit.sha}`);
      historyDiffs[commit.sha] = diff;
    }
    console.log(`captured file history for ${historyPath}: ${history.commits.length} commits`);

    const roles = {
      inbox: { numbers: args.numbers },
      conversation: { number: args.conversationPr },
      files: { number: args.filesPr },
      editing: { number: args.editingPr, path: editing.path, headSha: editingDetail.headRefOid },
      history: { number: args.historyPr, path: historyPath },
      palette: { number: args.palettePr },
    };
    const snapshot = {
      repo: args.repo,
      viewer,
      capturedAt: new Date().toISOString(),
      roles,
      details,
      diffs,
      history,
      historyDiffs,
      assets,
      fileContents,
    };
    const snapshotPath = join(tempDir, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    JSON.parse(readFileSync(snapshotPath, "utf8"));
    for (const name of Object.values(assets)) {
      if (!existsSync(join(blobsDir, name))) throw new Error(`missing captured asset ${name}`);
    }

    installSnapshot(tempDir, outDir);
    installed = true;
    console.log(`\nwrote snapshot to ${outDir}`);
  } finally {
    if (!installed) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
