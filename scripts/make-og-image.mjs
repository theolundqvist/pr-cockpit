// Renders docs/og.png, the 1200x630 card unfurled by Slack, X, iMessage, and Discord.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const browser = await chromium.launch();
const landing = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 3 });
await landing.goto(`file://${resolve(ROOT, "docs/index.html")}`, { waitUntil: "load" });
const card = landing.locator("#benchmark-grid .benchmark-card").first();
await card.waitFor();
const shot = await card.screenshot({ omitBackground: true });
const shotUrl = `data:image/png;base64,${shot.toString("base64")}`;

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 56px;
    padding: 64px;
    background: radial-gradient(circle at 50% -10%, rgba(94,210,141,0.16), transparent 30rem), #111110;
    color: #f4f4f1; font-family: "SF Pro Display", -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 64px; line-height: 1.05; letter-spacing: -0.03em; font-weight: 600; }
  img { width: 620px; display: block; filter: drop-shadow(0 30px 70px rgba(0,0,0,0.55)); }
</style>
<h1>GitHub PRs at local speed.</h1>
<img src="${shotUrl}">`;

const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: resolve(ROOT, "docs/og.png") });
await browser.close();
console.log("wrote docs/og.png");
