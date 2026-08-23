// Renders docs/og.png, the 1200x630 card unfurled by Slack, X, iMessage, and Discord.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shot = await readFile(resolve(ROOT, "docs/screenshots/landing-inbox.png"));
const shotUrl = `data:image/png;base64,${shot.toString("base64")}`;

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden; display: flex; flex-direction: column;
    padding: 56px 56px 0;
    background: radial-gradient(circle at 50% -20%, rgba(94,210,141,0.16), transparent 30rem), #111110;
    color: #f4f4f1; font-family: "SF Pro Display", -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-size: 60px; line-height: 1.05; letter-spacing: -0.025em; font-weight: 600; }
  p { margin-top: 16px; font-size: 25px; color: #b9b9b4; letter-spacing: -0.01em; }
  b { color: #5ed28d; font-weight: 600; }
  .shot {
    margin-top: 42px; border-radius: 16px 16px 0 0; overflow: hidden;
    border: 1px solid #343432; border-bottom: none;
    box-shadow: 0 -2px 60px rgba(0,0,0,0.55);
  }
  .shot img { width: 100%; display: block; }
</style>
<h1>GitHub PRs at local speed.</h1>
<p>Keyboard-first macOS review cockpit &middot; opens a PR in <b>0.09 s</b></p>
<div class="shot"><img src="${shotUrl}"></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: resolve(ROOT, "docs/og.png") });
await browser.close();
console.log("wrote docs/og.png");
