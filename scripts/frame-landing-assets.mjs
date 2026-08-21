import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/screenshots");
const MANIFEST = resolve(OUTPUT, "landing-assets.json");
const SHOT = { width: 1200, height: 900 };
const PADDING = 40;
const CANVAS = { width: SHOT.width + PADDING * 2, height: SHOT.height + PADDING * 2 };
// Same saturated desktop the search recording paints behind the palette, so every landing
// visual sits on one wallpaper instead of a duller per-image gradient.
const WALLPAPER = `
  radial-gradient(78% 82% at 6% 8%, rgba(255,42,120,.95), rgba(255,42,120,0) 62%),
  radial-gradient(58% 62% at 97% 10%, rgba(255,150,32,.9), rgba(255,150,32,0) 60%),
  radial-gradient(85% 75% at 74% 100%, rgba(0,224,255,.75), rgba(0,224,255,0) 62%),
  linear-gradient(155deg,#2a0b62 0%,#0d2f8f 26%,#0b62c4 52%,#06356f 78%,#041c4a 100%)`;

const assets = [
  { name: "landing-inbox.png", source: ".scratch/landing-real/inbox-light.png", scenario: "microsoft/vscode frozen inbox" },
  { name: "landing-editor.png", source: ".scratch/landing-real/editing-light.png", scenario: "microsoft/vscode#331804 editor at changed line 192" },
  { name: "landing-agent-prompt.png", source: ".scratch/landing-agent/1200x900/light/detail-agent-prompt.png", scenario: "fixture/cockpit#101 actual p prompt" },
  { name: "landing-file-history.png", source: ".scratch/landing-real/history-light.png", scenario: "microsoft/vscode#331804 file history" },
  { name: "landing-revert-menu.png", source: ".scratch/landing-real/revert-menu-light.png", scenario: "microsoft/vscode#331771 clean unified hunk context menu", fit: "cover" },
  { name: "landing-hide-tests-cockpit.png", source: ".scratch/landing-real/hide-tests-react-light.png", scenario: "react/react#36134 unified diff with 2 test files folded away", fit: "cover", position: "top", contentHeight: 390 },
  { name: "landing-hide-tests-github.png", source: ".scratch/landing-real/github-files-36134.png", scenario: "real GitHub react/react#36134 files view", raw: true },
];

function mime(path) {
  return path.endsWith(".webp") ? "image/webp" : "image/png";
}

async function dataUrl(path) {
  const bytes = await readFile(path);
  return `data:${mime(path)};base64,${bytes.toString("base64")}`;
}

const only = new Set(process.argv.slice(2).flatMap((arg, index, argv) => (argv[index - 1] === "--only" ? arg.split(",") : [])));
const selected = only.size ? assets.filter((asset) => only.has(asset.name)) : assets;
if (only.size !== 0 && selected.length !== only.size) throw new Error(`unknown asset in --only: ${[...only].join(",")}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1, colorScheme: "light" });
const entries = new Map(
  only.size ? JSON.parse(await readFile(MANIFEST, "utf8")).assets.map((entry) => [entry.path, entry]) : [],
);

for (const asset of selected) {
  const source = resolve(ROOT, asset.source);
  const image = await dataUrl(source);
  const background = asset.raw ? "#fff" : WALLPAPER;
  const frame = asset.raw ? "border-radius:0;box-shadow:none" : "border-radius:16px;box-shadow:0 30px 64px rgba(0,10,30,.28),0 4px 16px rgba(0,10,30,.18)";
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden}
body{display:grid;place-items:center;background:${background}}
.content{display:block;width:${SHOT.width}px;height:${asset.contentHeight ?? SHOT.height}px;object-fit:${asset.fit ?? "fill"};object-position:${asset.position ?? "center"};background:#fff;${frame}}
</style></head><body><img class="content" src="${image}" alt=""></body></html>`, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const path = resolve(OUTPUT, asset.name);
  await page.screenshot({ path, type: "png", animations: "disabled" });
  entries.set(`docs/screenshots/${asset.name}`, { path: `docs/screenshots/${asset.name}`, width: CANVAS.width, height: CANVAS.height, shotWidth: SHOT.width, shotHeight: asset.contentHeight ?? SHOT.height, padding: PADDING, theme: "light", treatment: asset.raw ? "raw GitHub screenshot on white" : "macOS wallpaper", source: asset.source, scenario: asset.scenario });
  console.log(path);
}

await browser.close();
await writeFile(MANIFEST, `${JSON.stringify({ assets: [...entries.values()] }, null, 2)}\n`);
