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
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_GH_IMG: join(dataDir, "missing-gh-img"), COCKPIT_MOCK: "" },
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
