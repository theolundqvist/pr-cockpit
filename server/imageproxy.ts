import { accessSync, constants, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mockGithub } from "./mockGithub.ts";
import { mockScreenshotSvg } from "./mockImages.ts";

const ALLOWED_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
]);

const CACHE_BYTES_PER_KIND = 2 * 1024 * 1024 * 1024;

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
const imageCacheDir = `${dataDir}/images`;
const videoCacheDir = `${dataDir}/videos`;

function sniffContentType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return bytes[8] === 0x71 && bytes[9] === 0x74 ? "video/quicktime" : "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
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

export async function fetchAllowedImage(raw: string, fetcher: typeof fetch = fetch): Promise<Uint8Array | null> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  for (let redirect = 0; redirect < 4; redirect++) {
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.host)) return null;
    const response = await fetcher(target, { redirect: "manual", headers: { accept: "image/*" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return sniffContentType(bytes) === "application/octet-stream" ? null : bytes;
  }
  return null;
}

async function serveBody(body: Bun.BunFile | Uint8Array, range: string | null): Promise<Response> {
  const head = body instanceof Uint8Array ? body : await body.slice(0, 256).bytes();
  const headers = {
    "content-type": sniffContentType(head),
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; sandbox",
    "accept-ranges": "bytes",
  };
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return new Response(body, { headers });
  const size = body instanceof Uint8Array ? body.byteLength : body.size;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
  });
}

function evictOverCap(cacheDir: string): void {
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
  if (total <= CACHE_BYTES_PER_KIND) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_BYTES_PER_KIND) break;
    try {
      rmSync(f.path);
      total -= f.size;
    } catch {}
  }
}

function cacheKey(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

type ImageResult = { file: Bun.BunFile } | { error: string; status: number };
const imageRequests = new Map<string, Promise<ImageResult>>();

function getImage(raw: string): Promise<ImageResult> {
  const pending = imageRequests.get(raw);
  if (pending) return pending;
  const request = loadImage(raw).finally(() => imageRequests.delete(raw));
  imageRequests.set(raw, request);
  return request;
}

async function loadImage(raw: string): Promise<ImageResult> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { error: "invalid url", status: 400 };
  }
  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.host)) {
    return { error: "host not allowed", status: 400 };
  }

  const key = cacheKey(raw);
  for (const dir of [imageCacheDir, videoCacheDir]) {
    const cached = Bun.file(`${dir}/${key}`);
    if (await cached.exists()) return { file: cached };
  }

  const fetched = await fetchAllowedImage(raw).catch(() => null);
  if (fetched) return { file: await storeCached(key, fetched) };

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

  return { file: await storeCached(key, new Uint8Array(stdout)) };
}

// Videos keep their own budget so one large recording cannot evict every cached image.
async function storeCached(key: string, bytes: Uint8Array): Promise<Bun.BunFile> {
  const dir = sniffContentType(bytes).startsWith("video/") ? videoCacheDir : imageCacheDir;
  mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}/${key}`, bytes);
  evictOverCap(dir);
  return Bun.file(`${dir}/${key}`);
}

const gifConversions = new Map<string, Promise<ImageResult>>();

// GIFs become seekable H.264 so the player can scrub them; the conversion is cached beside other videos.
function gifAsVideo(raw: string, gif: Bun.BunFile | Uint8Array): Promise<ImageResult> {
  const path = `${videoCacheDir}/${cacheKey(raw)}.mp4`;
  const pending = gifConversions.get(path);
  if (pending) return pending;
  const conversion = convertGif(gif, path).finally(() => gifConversions.delete(path));
  gifConversions.set(path, conversion);
  return conversion;
}

async function convertGif(gif: Bun.BunFile | Uint8Array, path: string): Promise<ImageResult> {
  const cached = Bun.file(path);
  if (await cached.exists()) return { file: cached };
  const head = gif instanceof Uint8Array ? gif : await gif.slice(0, 16).bytes();
  if (sniffContentType(head) !== "image/gif") return { error: "not a GIF", status: 415 };
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) return { error: "ffmpeg unavailable", status: 501 };
  mkdirSync(videoCacheDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp.mp4`;
  const input = gif instanceof Uint8Array ? `${tmp}.gif` : gif.name!;
  if (gif instanceof Uint8Array) await Bun.write(input, gif);
  const proc = Bun.spawn([
    ffmpeg, "-loglevel", "error", "-y", "-i", input, "-an", "-threads", "2",
    "-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp,
  ], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (gif instanceof Uint8Array) rmSync(input, { force: true });
  if (code !== 0) {
    rmSync(tmp, { force: true });
    return { error: stderr || `ffmpeg exited ${code}`, status: 502 };
  }
  renameSync(tmp, path);
  evictOverCap(videoCacheDir);
  return { file: Bun.file(path) };
}

async function serveResult(result: ImageResult, range: string | null): Promise<Response> {
  if ("error" in result) return new Response(result.error, { status: result.status });
  return serveBody(result.file, range);
}

export async function handleImage(url: URL, range: string | null = null): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("url query param required", { status: 400 });
  const result = await getImage(raw);
  if (url.searchParams.get("as") !== "video" || "error" in result) return serveResult(result, range);
  return serveResult(await gifAsVideo(raw, result.file), range);
}

export function handleMockImage(url: URL, range: string | null = null): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) return Promise.resolve(new Response("url query param required", { status: 400 }));
  const body = mockGithub?.image?.(raw) ?? new TextEncoder().encode(mockScreenshotSvg(raw));
  if (url.searchParams.get("as") === "video") return gifAsVideo(raw, body).then((result) => serveResult(result, range));
  return serveBody(body, range);
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
  if (mockGithub) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) await getImage(urls[cursor++]!).catch(() => {});
  };
  await Promise.allSettled([worker(), worker(), worker()]);
}
