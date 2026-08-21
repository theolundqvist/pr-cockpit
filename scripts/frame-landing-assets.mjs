import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/screenshots");
const ICON = resolve(ROOT, "assets/icon.png");
const CANVAS = { width: 1280, height: 960 };
const WINDOW = { width: 1200, height: 900 };

const assets = [
  { name: "landing-inbox.png", title: "PR Cockpit · Review queue", source: ".scratch/landing-real/inbox-light.png", scenario: "microsoft/vscode frozen inbox" },
  { name: "landing-editor.png", title: "PR Cockpit · Edit at the changed line", source: ".scratch/landing-real/editing-light.png", scenario: "microsoft/vscode#331804 editor at changed line 192" },
  { name: "landing-agent-prompt.png", title: "PR Cockpit · Prompt an agent", source: ".scratch/landing-agent/1200x900/light/detail-agent-prompt.png", scenario: "fixture/cockpit#101 actual p prompt" },
  { name: "landing-file-history.png", title: "PR Cockpit · File history", source: ".scratch/landing-real/history-light.png", scenario: "microsoft/vscode#331804 file history" },
  { name: "landing-hide-tests-cockpit.png", title: "PR Cockpit · Tests hidden", source: ".scratch/landing-real/hide-tests-light.png", scenario: "microsoft/vscode#331804 after hide tests" },
  { name: "landing-hide-tests-github.png", title: "GitHub · All changed files", source: ".scratch/landing-real/github-files.webp", scenario: "real GitHub microsoft/vscode#331804 files", icon: false },
];

function mime(path) {
  return path.endsWith(".webp") ? "image/webp" : "image/png";
}

async function dataUrl(path) {
  const bytes = await readFile(path);
  return `data:${mime(path)};base64,${bytes.toString("base64")}`;
}

const icon = await dataUrl(ICON);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1, colorScheme: "light" });
const manifest = [];

for (const asset of assets) {
  const source = resolve(ROOT, asset.source);
  const image = await dataUrl(source);
  const appMark = asset.icon === false ? "" : `<img class="app-icon" src="${icon}" alt="">`;
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden}body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:radial-gradient(900px 540px at 9% -8%,rgba(255,255,255,.92),transparent 62%),radial-gradient(620px 500px at 92% 22%,rgba(246,208,197,.72),transparent 70%),linear-gradient(135deg,#b8c9dc 0%,#d8dce5 42%,#cfc0c5 100%)}
body:before,body:after{content:"";position:absolute;border-radius:999px;filter:blur(2px);opacity:.55}body:before{width:300px;height:300px;left:-70px;bottom:-110px;background:#8da8c7}body:after{width:250px;height:250px;right:-50px;top:-80px;background:#dfb1a6}
.window{position:absolute;left:39px;top:8px;width:1202px;height:944px;border:1px solid rgba(58,64,72,.22);border-radius:18px;overflow:hidden;background:#fff;box-shadow:0 32px 70px rgba(43,50,64,.26),0 5px 18px rgba(43,50,64,.18)}
.chrome{position:relative;width:1200px;height:42px;display:flex;align-items:center;justify-content:center;background:linear-gradient(#fbfbfc,#eceef1);border-bottom:1px solid #d6d8dc;color:#50545b;font-size:12px;font-weight:600;letter-spacing:.01em}.lights{position:absolute;left:15px;display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;display:block;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}.lights i:nth-child(1){background:#ff5f57}.lights i:nth-child(2){background:#febc2e}.lights i:nth-child(3){background:#28c840}.title{display:flex;align-items:center;gap:8px}.app-icon{width:22px;height:22px;object-fit:contain}.content{display:block;width:${WINDOW.width}px;height:${WINDOW.height}px;object-fit:fill;background:#fff}
</style></head><body><div class="window"><div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="title">${appMark}<span>${asset.title}</span></span></div><img class="content" src="${image}" alt=""></div></body></html>`, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const path = resolve(OUTPUT, asset.name);
  await page.screenshot({ path, type: "png", animations: "disabled" });
  manifest.push({ path: `docs/screenshots/${asset.name}`, width: CANVAS.width, height: CANVAS.height, appWindowWidth: WINDOW.width, theme: "light", source: asset.source, scenario: asset.scenario });
  console.log(path);
}

await browser.close();
await writeFile(resolve(OUTPUT, "landing-assets.json"), `${JSON.stringify({ frameIcon: "assets/icon.png", assets: manifest }, null, 2)}\n`);
