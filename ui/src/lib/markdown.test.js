import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
const uiRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const videoUrl = "https://github.com/user-attachments/assets/e41894cd-359c-4a6f-917a-f16736996969";

async function renderSamples() {
  const server = await createServer({
    root: uiRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [uiRoot, repoRoot] } },
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const base = server.resolvedUrls.local[0];
    await page.route("**/blank.html", (route) => route.fulfill({ contentType: "text/html", body: `<base href="${base}">` }));
    await page.goto(`${base}blank.html`);
    return await page.evaluate(async ({ videoUrl }) => {
      const { renderMarkdown } = await import("/src/lib/markdown.js");
      const render = (source) => {
        const doc = new DOMParser().parseFromString(renderMarkdown(source), "text/html");
        return {
          players: doc.querySelectorAll("media-controller").length,
          links: [...doc.querySelectorAll("a")].map((a) => a.href),
          images: [...doc.querySelectorAll("img")].map((img) => img.dataset.originalSrc),
          html: doc.body.innerHTML,
        };
      };
      return {
        labelAndUrl: render(`Before behavior:\n${videoUrl}`),
        betweenText: render(`Before behavior:\n${videoUrl}\nAfter behavior`),
        twoVideos: render(`Before behavior:\n${videoUrl}\nAfter behavior:\n${videoUrl}`),
        alone: render(videoUrl),
        sentence: render(`Watch ${videoUrl} now`),
        trailingText: render(`Before behavior:\n${videoUrl} trailing`),
        image: render(`![image](${videoUrl})`),
        imageAndVideo: render(`![image](${videoUrl}) ${videoUrl}`),
      };
    }, { videoUrl });
  } finally {
    await browser.close();
    await server.close();
  }
}

test("embeds only video attachments that occupy a whole line", { timeout: 30_000 }, async () => {
  const rendered = await renderSamples();

  expect(rendered.labelAndUrl.players).toBe(1);
  expect(rendered.labelAndUrl.links).toEqual([]);
  expect(rendered.labelAndUrl.html).toContain("Before behavior:<br>");

  expect(rendered.betweenText.players).toBe(1);
  expect(rendered.betweenText.links).toEqual([]);
  expect(rendered.betweenText.html).toContain("</media-controller>After behavior");

  expect(rendered.twoVideos.players).toBe(2);
  expect(rendered.twoVideos.links).toEqual([]);

  expect(rendered.alone.players).toBe(1);
  expect(rendered.alone.links).toEqual([]);

  expect(rendered.sentence.players).toBe(0);
  expect(rendered.sentence.links).toEqual([videoUrl]);

  expect(rendered.trailingText.players).toBe(0);
  expect(rendered.trailingText.links).toEqual([videoUrl]);

  expect(rendered.image.players).toBe(0);
  expect(rendered.image.links).toEqual([]);
  expect(rendered.image.images).toEqual([videoUrl]);
  expect(rendered.imageAndVideo.players).toBe(0);
  expect(rendered.imageAndVideo.links).toEqual([videoUrl]);
  expect(rendered.imageAndVideo.images).toEqual([videoUrl]);
});
