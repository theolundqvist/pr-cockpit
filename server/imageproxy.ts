import { accessSync, constants, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mockGithub } from "./mockGithub.ts";
import { mockScreenshotSvg } from "./mockImages.ts";
import { GITHUB_MEDIA_HOSTS } from "./githubMedia.ts";
import { createConcurrencyLimit } from "./concurrency.ts";
import { ghToken } from "./github.ts";

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
const thumbnailCacheDir = `${dataDir}/thumbnails`;

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

// github.com answers an authenticated attachment request with a signed redirect into its asset bucket.
const GITHUB_ASSET_BUCKET_RE = /^github-production-user-asset-[0-9a-f]+\.s3\.amazonaws\.com$/;

export async function fetchAllowedImage(raw: string, fetcher: typeof fetch = fetch, token: string | null = null): Promise<Uint8Array | null> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  for (let redirect = 0; redirect < 4; redirect++) {
    const allowed = GITHUB_MEDIA_HOSTS.has(target.host) || (redirect > 0 && GITHUB_ASSET_BUCKET_RE.test(target.host));
    if (target.protocol !== "https:" || !allowed) return null;
    // Only github.com gets the token; the signed bucket URL must not carry other credentials.
    const headers: Record<string, string> = token && target.host === "github.com" ? { accept: "image/*", authorization: `Bearer ${token}` } : { accept: "image/*" };
    const response = await fetcher(target, { redirect: "manual", headers });
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

async function serveBody(body: Bun.BunFile | Uint8Array, range: string | null, extra: Record<string, string> = {}): Promise<Response> {
  const head = body instanceof Uint8Array ? body : await body.slice(0, 256).bytes();
  const headers = {
    "content-type": sniffContentType(head),
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": "inline",
    "content-security-policy": "default-src 'none'; sandbox",
    "accept-ranges": "bytes",
    ...extra,
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

// A card or poster is always a still, so `kind` tells the UI what its source was.
type MediaKind = "image" | "gif" | "video";
type ImageResult = { file: Bun.BunFile | Uint8Array; kind?: MediaKind } | { error: string; status: number };
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
  if (target.protocol !== "https:" || !GITHUB_MEDIA_HOSTS.has(target.host)) {
    return { error: "host not allowed", status: 400 };
  }

  const key = cacheKey(raw);
  for (const dir of [imageCacheDir, videoCacheDir]) {
    const cached = Bun.file(`${dir}/${key}`);
    if (await cached.exists()) return { file: cached };
  }

  let fetched = await fetchAllowedImage(raw).catch(() => null);
  // Private attachments answer 404 anonymously; the CLI token opens them wherever GitHub access is allowed.
  if (!fetched) {
    const token = await ghToken().catch(() => null);
    if (token) fetched = await fetchAllowedImage(raw, fetch, token).catch(() => null);
  }
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

// Conversions yield the CPU to the app and its renderer, which usually share this machine, and at most two
// run at once however many rows or viewer steps ask.
const conversionSlots = createConcurrencyLimit(2);
const niced = Bun.which("nice") ? ["nice", "-n", "10"] : [];

const gifConversions = new Map<string, Promise<ImageResult>>();

// The viewer plays GIFs and videos in <video> so they can be paused and scrubbed: a GIF becomes seekable
// H.264, cached beside other videos, and a video attachment plays as is.
async function playableVideo(raw: string, source: Bun.BunFile | Uint8Array): Promise<ImageResult> {
  const type = sniffContentType(source instanceof Uint8Array ? source : await source.slice(0, 256).bytes());
  if (type.startsWith("video/")) return { file: source };
  if (type !== "image/gif") return { error: "not a GIF or video", status: 415 };
  const path = `${videoCacheDir}/${cacheKey(raw)}.mp4`;
  const pending = gifConversions.get(path);
  if (pending) return pending;
  const conversion = convertGif(source, path).finally(() => gifConversions.delete(path));
  gifConversions.set(path, conversion);
  return conversion;
}

async function convertGif(gif: Bun.BunFile | Uint8Array, path: string): Promise<ImageResult> {
  const cached = Bun.file(path);
  if (await cached.exists()) return { file: cached };
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) return { error: "ffmpeg unavailable", status: 501 };
  mkdirSync(videoCacheDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp.mp4`;
  const input = gif instanceof Uint8Array ? `${tmp}.gif` : gif.name!;
  if (gif instanceof Uint8Array) await Bun.write(input, gif);
  const [code, stderr] = await conversionSlots(async () => {
    const proc = Bun.spawn([
      ...niced, ffmpeg, "-loglevel", "error", "-y", "-i", input, "-an", "-threads", "2",
      "-vf", "scale=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp,
    ], { stdout: "ignore", stderr: "pipe" });
    return Promise.all([proc.exited, new Response(proc.stderr).text()]);
  });
  if (gif instanceof Uint8Array) rmSync(input, { force: true });
  if (code !== 0) {
    rmSync(tmp, { force: true });
    return { error: stderr || `ffmpeg exited ${code}`, status: 502 };
  }
  renameSync(tmp, path);
  evictOverCap(videoCacheDir);
  return { file: Bun.file(path) };
}

// Queue rows show media in a 52x32 CSS px card, cover-cropped. Hovering a stack peeks at the whole front
// attachment in its own aspect ratio at 8x the card, 416 CSS px on its long side, from the poster, which is
// also what the viewer shows while an item loads. Each variant is dense enough to stay sharp on Retina without
// shipping originals, and the poster never upscales a small original. Both are the first frame: GIFs and
// videos move only in the viewer. They replaced the animated as=thumb and as=peek, whose immutable responses
// renderers still cache under those URLs.
const THUMB_VARIANTS: Record<string, { name: string; filter: string }> = {
  card: { name: "card208x128", filter: "scale=208:128:force_original_aspect_ratio=increase,crop=208:128" },
  poster: { name: "poster832", filter: "scale='min(832,iw)':'min(832,ih)':force_original_aspect_ratio=decrease" },
};
const thumbnailConversions = new Map<string, Promise<ImageResult>>();

function thumbnail(raw: string, source: Bun.BunFile | Uint8Array, variant: { name: string; filter: string }): Promise<ImageResult> {
  const path = `${thumbnailCacheDir}/${cacheKey(raw)}-${variant.name}.webp`;
  const pending = thumbnailConversions.get(path);
  if (pending) return pending;
  const conversion = convertThumbnail(source, path, variant.filter).finally(() => thumbnailConversions.delete(path));
  thumbnailConversions.set(path, conversion);
  return conversion;
}

async function convertThumbnail(source: Bun.BunFile | Uint8Array, path: string, filter: string): Promise<ImageResult> {
  const type = sniffContentType(source instanceof Uint8Array ? source : await source.slice(0, 256).bytes());
  const kind: MediaKind = type === "image/gif" ? "gif" : type.startsWith("video/") ? "video" : "image";
  const cached = Bun.file(path);
  if (await cached.exists()) return { file: cached, kind };
  // Only a still may stand in at full size: a GIF would animate in the list and a video cannot render in <img>.
  const fallback: ImageResult = kind === "image" ? { file: source, kind } : { error: `${kind} thumbnail unavailable`, status: 502 };
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg || type === "image/svg+xml" || type === "application/octet-stream") return fallback;
  mkdirSync(thumbnailCacheDir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp.webp`;
  const input = source instanceof Uint8Array ? `${tmp}.source` : source.name!;
  if (source instanceof Uint8Array) await Bun.write(input, source);
  const [code, stderr] = await conversionSlots(async () => {
    const proc = Bun.spawn([
      ...niced, ffmpeg, "-loglevel", "error", "-y", "-i", input, "-an", "-threads", "1",
      "-frames:v", "1", "-vf", filter, "-c:v", "libwebp", "-q:v", "85", tmp,
    ], { stdout: "ignore", stderr: "pipe" });
    return Promise.all([proc.exited, new Response(proc.stderr).text()]);
  });
  if (source instanceof Uint8Array) rmSync(input, { force: true });
  if (code !== 0) {
    rmSync(tmp, { force: true });
    console.error(`thumbnail conversion failed: ${stderr.trim() || `ffmpeg exited ${code}`}`);
    return fallback;
  }
  renameSync(tmp, path);
  evictOverCap(thumbnailCacheDir);
  return { file: Bun.file(path), kind };
}

async function serveResult(result: ImageResult, range: string | null): Promise<Response> {
  if ("error" in result) return new Response(result.error, { status: result.status });
  return serveBody(result.file, range, result.kind ? { "x-media-kind": result.kind } : {});
}

// `as=video` plays a GIF or video in the viewer; `as=card` and `as=poster` serve the queue-row card and the
// still for the hover peek and viewer, with `x-media-kind` naming what the still was taken from.
function convertedImage(raw: string, as: string | null, source: Bun.BunFile | Uint8Array): Promise<ImageResult> | null {
  if (as === null) return null;
  if (as === "video") return playableVideo(raw, source);
  const variant = Object.hasOwn(THUMB_VARIANTS, as) ? THUMB_VARIANTS[as] : undefined;
  if (variant) return thumbnail(raw, source, variant);
  // An unknown or retired variant must not fall back to the full-size original a card exists to avoid.
  return Promise.resolve({ error: `unknown image variant: ${as}`, status: 400 });
}

export async function handleImage(url: URL, range: string | null = null): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("url query param required", { status: 400 });
  const result = await getImage(raw);
  const converted = "error" in result ? null : convertedImage(raw, url.searchParams.get("as"), result.file);
  return serveResult(converted ? await converted : result, range);
}

export async function handleMockImage(url: URL, range: string | null = null): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) return new Response("url query param required", { status: 400 });
  const body = mockGithub?.image?.(raw) ?? new TextEncoder().encode(mockScreenshotSvg(raw));
  const converted = convertedImage(raw, url.searchParams.get("as"), body);
  return converted ? serveResult(await converted, range) : serveBody(body, range);
}

export async function prefetchImages(urls: string[]): Promise<void> {
  if (mockGithub) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) await getImage(urls[cursor++]!).catch(() => {});
  };
  await Promise.allSettled([worker(), worker(), worker()]);
}
