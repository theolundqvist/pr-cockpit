import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const uiRoot = fileURLToPath(new URL("../..", import.meta.url));

test("destroying removed thumbnails does not retain their rows in Chromium", { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: uiRoot,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const base = server.resolvedUrls.local[0];
    await page.route("**/row-media-test.html", (route) => route.fulfill({
      contentType: "text/html",
      body: '<main id="rows"></main>',
    }));
    await page.goto(`${base}row-media-test.html`);
    await page.evaluate(async () => {
      window.thumbnail = (await import("/src/lib/rowMedia.js")).lazyThumbnail;
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Memory.getDOMCounters");
    await page.evaluate(async () => {
      const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      for (let batch = 0; batch < 10; batch++) {
        const mounted = [];
        for (let index = 0; index < 20; index++) {
          const row = document.createElement("a");
          const img = document.createElement("img");
          img.src = pixel;
          row.append(img, document.createTextNode("PR thumbnail"));
          document.querySelector("#rows").append(row);
          row.addEventListener("click", () => row.textContent);
          mounted.push({ row, action: window.thumbnail(img, pixel) });
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        for (const { row, action } of mounted) {
          row.remove();
          action.destroy();
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Memory.getDOMCounters");
    expect(after.nodes - before.nodes).toBeLessThan(100);
    expect(after.jsEventListeners - before.jsEventListeners).toBeLessThan(10);
  } finally {
    await browser?.close();
    await server.close();
  }
});
