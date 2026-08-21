import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/screenshots");
const SHOT = { width: 1200, height: 900 };
const PADDING = 40;
const CANVAS = { width: SHOT.width + PADDING * 2, height: SHOT.height + PADDING * 2 };

const assets = [
  { name: "landing-inbox.png", source: ".scratch/landing-real/inbox-light.png", scenario: "microsoft/vscode frozen inbox" },
  { name: "landing-editor.png", source: ".scratch/landing-real/editing-light.png", scenario: "microsoft/vscode#331804 editor at changed line 192" },
  { name: "landing-agent-prompt.png", source: ".scratch/landing-agent/1200x900/light/detail-agent-prompt.png", scenario: "fixture/cockpit#101 actual p prompt" },
  { name: "landing-file-history.png", source: ".scratch/landing-real/history-light.png", scenario: "microsoft/vscode#331804 file history" },
  { name: "landing-revert-menu.png", source: ".scratch/landing-real/revert-menu-light.png", scenario: "microsoft/vscode#331804 right-click Revert hunk context menu" },
  { name: "landing-hide-tests-before.png", source: ".scratch/landing-real/hide-tests-all-light.png", scenario: "microsoft/vscode#331771 all 75 changed files" },
  { name: "landing-hide-tests-cockpit.png", source: ".scratch/landing-real/hide-tests-light.png", scenario: "microsoft/vscode#331771 after hiding 9 test files" },
  { name: "landing-hide-tests-github.png", source: ".scratch/landing-real/github-files-331771.webp", scenario: "real GitHub microsoft/vscode#331771 files view" },
];

function mime(path) {
  return path.endsWith(".webp") ? "image/webp" : "image/png";
}

async function dataUrl(path) {
  const bytes = await readFile(path);
  return `data:${mime(path)};base64,${bytes.toString("base64")}`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1, colorScheme: "light" });
const manifest = [];

for (const asset of assets) {
  const source = resolve(ROOT, asset.source);
  const image = await dataUrl(source);
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden}
body{display:grid;place-items:center;background:radial-gradient(980px 620px at 12% -10%,rgba(255,255,255,.9),transparent 62%),linear-gradient(135deg,#b8c9dc 0%,#d8dce5 46%,#cdd3dd 100%)}
.content{display:block;width:${SHOT.width}px;height:${SHOT.height}px;object-fit:fill;border-radius:16px;background:#fff;box-shadow:0 30px 64px rgba(43,50,64,.24),0 4px 16px rgba(43,50,64,.14)}
</style></head><body><img class="content" src="${image}" alt=""></body></html>`, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const path = resolve(OUTPUT, asset.name);
  await page.screenshot({ path, type: "png", animations: "disabled" });
  manifest.push({ path: `docs/screenshots/${asset.name}`, width: CANVAS.width, height: CANVAS.height, shotWidth: SHOT.width, shotHeight: SHOT.height, padding: PADDING, theme: "light", source: asset.source, scenario: asset.scenario });
  console.log(path);
}

await browser.close();
await writeFile(resolve(OUTPUT, "landing-assets.json"), `${JSON.stringify({ assets: manifest }, null, 2)}\n`);
