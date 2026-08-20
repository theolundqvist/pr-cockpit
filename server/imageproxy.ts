import { accessSync, constants, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mockGithub } from "./mockGithub.ts";
import { mockScreenshotSvg } from "./mockImages.ts";

const ALLOWED_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
]);

const IMAGE_CACHE_BYTES = 256 * 1024 * 1024;

const ghImgBin =
  Bun.env.COCKPIT_GH_IMG ??
  [`${Bun.env.HOME}/dev/gh-img/gh-img`, `${Bun.env.HOME}/.local/share/gh/extensions/gh-img/gh-img`].find((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ??
  "gh-img";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const cacheDir = `${dataDir}/images`;

function sniffContentType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function ghImgAvailable(): boolean {
  if (!ghImgBin.includes("/")) return Bun.which(ghImgBin) !== null;
  try {
    accessSync(ghImgBin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function serveBytes(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: {
      "content-type": sniffContentType(bytes),
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": "attachment",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

function evictOverCap(): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  const files = names.flatMap((name) => {
    const path = `${cacheDir}/${name}`;
    try {
      const stat = statSync(path);
      return [{ path, size: stat.size, mtime: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= IMAGE_CACHE_BYTES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= IMAGE_CACHE_BYTES) break;
    try {
      rmSync(f.path);
      total -= f.size;
    } catch {}
  }
}

type ImageResult = { bytes: Uint8Array } | { error: string; status: number };

async function getImage(raw: string): Promise<ImageResult> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { error: "invalid url", status: 400 };
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.host)) {
    return { error: "host not allowed", status: 400 };
  }

  const key = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  const cachePath = `${cacheDir}/${key}`;
  const cached = Bun.file(cachePath);
  if (await cached.exists()) {
    return { bytes: new Uint8Array(await cached.arrayBuffer()) };
  }

  if (!ghImgAvailable()) {
    return { error: "gh-img get unavailable", status: 501 };
  }

  const proc = Bun.spawn([ghImgBin, "get", raw], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    return { error: stderr || `gh-img get exited ${code}`, status: 502 };
  }

  const bytes = new Uint8Array(stdout);
  mkdirSync(cacheDir, { recursive: true });
  await Bun.write(cachePath, bytes);
  evictOverCap();
  return { bytes };
}

export async function handleImage(url: URL): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("url query param required", { status: 400 });
  const result = await getImage(raw);
  if ("error" in result) return new Response(result.error, { status: result.status });
  return serveBytes(result.bytes);
}

export function handleMockImage(url: URL): Response {
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("url query param required", { status: 400 });
  const captured = mockGithub?.image?.(raw);
  if (captured) return serveBytes(captured);
  return serveBytes(new TextEncoder().encode(mockScreenshotSvg(raw)));
}

const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g;
const HTML_IMAGE_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

export function extractGithubImageUrls(text: string): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  for (const re of [MD_IMAGE_RE, HTML_IMAGE_RE]) {
    for (const match of text.matchAll(re)) {
      const raw = match[1];
      if (!raw) continue;
      try {
        const target = new URL(raw);
        if (target.protocol === "https:" && ALLOWED_HOSTS.has(target.host)) urls.add(raw);
      } catch {}
    }
  }
  return [...urls];
}

export async function prefetchImages(urls: string[]): Promise<void> {
  if (mockGithub || !ghImgAvailable()) return;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) await getImage(queue.shift()!).catch(() => {});
  };
  await Promise.allSettled([worker(), worker(), worker()]);
}
