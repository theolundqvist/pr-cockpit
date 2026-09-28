import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAllowedImage } from "./imageproxy.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("native image fetch follows only allowed GitHub redirects", async () => {
  const seen: string[] = [];
  const bytes = await fetchAllowedImage("https://github.com/owner/repo/blob/main/image.png?raw=true", async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("github.com/")) {
      return new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/owner/repo/main/image.png" } });
    }
    return new Response(png);
  });
  expect(bytes).toEqual(png);
  expect(seen).toEqual([
    "https://github.com/owner/repo/blob/main/image.png?raw=true",
    "https://raw.githubusercontent.com/owner/repo/main/image.png",
  ]);

  expect(await fetchAllowedImage("https://github.com/owner/repo/blob/main/image.png?raw=true", async () => (
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })
  ))).toBeNull();
});

test("a token reaches only github.com and unlocks its signed attachment redirect", async () => {
  const seen: Array<[string, string | null]> = [];
  const asset = "https://github-production-user-asset-6210df.s3.amazonaws.com/1/2.png?X-Amz-Signature=abc";
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push([url, new Headers(init?.headers).get("authorization")]);
    return url.startsWith("https://github.com/")
      ? new Response(null, { status: 302, headers: { location: asset } })
      : new Response(png);
  };
  const raw = "https://github.com/user-attachments/assets/0000aaaa-0000-0000-0000-000000000001";
  expect(await fetchAllowedImage(raw, fetcher as typeof fetch, "secret")).toEqual(png);
  expect(seen).toEqual([[raw, "Bearer secret"], [asset, null]]);
  // The bucket is reachable only through a github.com redirect, never as a requested URL.
  expect(await fetchAllowedImage(asset, fetcher as typeof fetch, "secret")).toBeNull();
});

async function imageScenario(scenario: string): Promise<Record<string, any>> {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-images-"));
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", `
      import { handleImage, prefetchImages } from ${JSON.stringify(new URL("./imageproxy.ts", import.meta.url).href)};
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const raw = "https://raw.githubusercontent.com/acme/app/main/image.png";
      const url = new URL("http://localhost/api/image?url=" + encodeURIComponent(raw));
      ${scenario}
    `], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_GH_IMG: join(dataDir, "missing-gh-img"), COCKPIT_GH_BIN: join(dataDir, "missing-gh"), COCKPIT_MOCK: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("simultaneous image requests share one download and serve intact cached bytes", async () => {
  const result = await imageScenario(`
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response(png); };
    const responses = await Promise.all(Array.from({ length: 20 }, () => handleImage(url)));
    const bodies = await Promise.all(responses.map(async (response) => Array.from(new Uint8Array(await response.arrayBuffer()))));
    const cached = await handleImage(url);
    console.log(JSON.stringify({ fetches, bodies, cached: Array.from(new Uint8Array(await cached.arrayBuffer())) }));
  `);
  expect(result.fetches).toBe(1);
  expect(result.bodies).toEqual(Array.from({ length: 20 }, () => Array.from(png)));
  expect(result.cached).toEqual(Array.from(png));
});

test("native image prefetch works without gh-img", async () => {
  const result = await imageScenario(`
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return new Response(png); };
    await prefetchImages([raw]);
    const prefetched = fetches;
    globalThis.fetch = async () => { throw new Error("image should already be cached"); };
    const response = await handleImage(url);
    console.log(JSON.stringify({ prefetched, status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) }));
  `);
  expect(result).toEqual({ prefetched: 1, status: 200, bytes: Array.from(png) });
});

test("failed image requests do not poison subsequent downloads", async () => {
  const result = await imageScenario(`
    globalThis.fetch = async () => new Response(null, { status: 404 });
    const failed = await handleImage(url);
    globalThis.fetch = async () => new Response(png);
    const recovered = await handleImage(url);
    console.log(JSON.stringify({ failed: failed.status, recovered: recovered.status, bytes: Array.from(new Uint8Array(await recovered.arrayBuffer())) }));
  `);
  expect(result).toEqual({ failed: 501, recovered: 200, bytes: Array.from(png) });
});

test("GitHub video attachments are proxied with a playable content type", async () => {
  const result = await imageScenario(`
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    globalThis.fetch = async () => new Response(mp4);
    const response = await handleImage(url);
    console.log(JSON.stringify({ status: response.status, type: response.headers.get("content-type") }));
  `);
  expect(result).toEqual({ status: 200, type: "video/mp4" });
});

test("image proxy serves byte ranges so video players do not download the whole file", async () => {
  const result = await imageScenario(`
    const mp4 = new Uint8Array(1000).map((_, i) => i % 256);
    mp4.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    globalThis.fetch = async () => new Response(mp4);
    const response = await handleImage(url, "bytes=100-199");
    const body = new Uint8Array(await response.arrayBuffer());
    console.log(JSON.stringify({ status: response.status, range: response.headers.get("content-range"), length: body.length, first: body[0] }));
  `);
  expect(result).toEqual({ status: 206, range: "bytes 100-199/1000", length: 100, first: 100 });
});

test.skipIf(!Bun.which("ffmpeg"))("GIFs requested as video are transcoded to seekable MP4, videos play as is, and stills are refused", async () => {
  const result = await imageScenario(`
    const gifPath = ${JSON.stringify(join(tmpdir(), `pr-cockpit-${process.pid}.gif`))};
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=33x17:rate=10:duration=1", gifPath]);
    const gif = new Uint8Array(await Bun.file(gifPath).arrayBuffer());
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    globalThis.fetch = async (input) => new Response(String(input).endsWith(".gif") ? gif : String(input).endsWith(".mp4") ? mp4 : png);
    const asVideo = (raw) => handleImage(new URL("http://localhost/api/image?as=video&url=" + encodeURIComponent(raw)), "bytes=0-");
    const video = await asVideo("https://raw.githubusercontent.com/acme/app/main/flow.gif");
    const original = await asVideo("https://raw.githubusercontent.com/acme/app/main/demo.mp4");
    const still = await asVideo(raw);
    console.log(JSON.stringify({
      video: [video.status, video.headers.get("content-type")],
      original: [original.status, (await original.arrayBuffer()).byteLength],
      still: still.status,
    }));
  `);
  expect(result).toEqual({ video: [206, "video/mp4"], original: [206, 12], still: 415 });
});

// Looping cards kept the compositor redrawing an idle list, so every card and poster is one frame, and the
// retired animated variants never fall back to the full-size original.
test.skipIf(!Bun.which("ffmpeg"))("row cards and posters of a GIF are single-frame stills that name their source", async () => {
  const result = await imageScenario(`
    const gifPath = ${JSON.stringify(join(tmpdir(), `pr-cockpit-card-${process.pid}.gif`))};
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1", gifPath]);
    const gif = new Uint8Array(await Bun.file(gifPath).arrayBuffer());
    const pngPath = ${JSON.stringify(join(tmpdir(), `pr-cockpit-card-${process.pid}.png`))};
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180", "-frames:v", "1", pngPath]);
    const still = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    globalThis.fetch = async (input) => new Response(String(input).endsWith(".gif") ? gif : still);
    const variant = async (as, name) => {
      const response = await handleImage(new URL("http://localhost/api/image?as=" + as + "&url=" + encodeURIComponent("https://raw.githubusercontent.com/acme/app/main/" + name)));
      const head = new TextDecoder("latin1").decode(new Uint8Array(await response.arrayBuffer()).subarray(0, 64));
      return [response.status, response.headers.get("content-type"), response.headers.get("x-media-kind"), head.includes("ANIM")];
    };
    console.log(JSON.stringify({
      card: await variant("card", "flow.gif"),
      poster: await variant("poster", "flow.gif"),
      cachedCard: await variant("card", "flow.gif"),
      image: await variant("card", "shot.png"),
      retired: (await variant("thumb", "flow.gif"))[0],
    }));
  `);
  expect(result).toEqual({
    card: [200, "image/webp", "gif", false],
    poster: [200, "image/webp", "gif", false],
    cachedCard: [200, "image/webp", "gif", false],
    image: [200, "image/webp", "image", false],
    retired: 400,
  });
});
