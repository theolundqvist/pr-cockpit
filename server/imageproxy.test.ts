import { expect, test } from "bun:test";
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
