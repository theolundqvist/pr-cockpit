import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "docs/screenshots");
const MANIFEST = resolve(OUTPUT, "landing-assets.json");
const SHOT = { width: 1200, height: 900 };
// The landing page owns the corner radius and the drop shadow on .shot-shell, so these assets are
// the bare app window: no wallpaper border, nothing baked that a responsive layout would then scale.
// The .scratch captures below have drifted from the compositions that shipped (the revert-menu one
// lost its cursor and zoom level), so a re-run replaces content, not just framing. Diff against
// git HEAD before publishing anything this script overwrites.

const assets = [
  { name: "landing-inbox.png", source: ".scratch/landing-real/inbox-light.png", scenario: "microsoft/vscode frozen inbox" },
  { name: "landing-editor.png", source: ".scratch/landing-real/editing-light.png", scenario: "microsoft/vscode#331804 editor at changed line 192" },
  { name: "landing-agent-prompt.png", source: ".scratch/landing-agent/1200x900/light/detail-agent-prompt.png", scenario: "fixture/cockpit#101 actual p prompt" },
  { name: "landing-file-history.png", source: ".scratch/landing-real/history-light.png", scenario: "microsoft/vscode#331804 file history" },
  { name: "landing-revert-menu.png", source: ".scratch/landing-real/revert-menu-light.png", scenario: "microsoft/vscode#331771 clean unified hunk context menu", fit: "cover" },
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
const page = await browser.newPage({ viewport: SHOT, deviceScaleFactor: 1, colorScheme: "light" });
const entries = new Map(
  only.size ? JSON.parse(await readFile(MANIFEST, "utf8")).assets.map((entry) => [entry.path, entry]) : [],
);

for (const asset of selected) {
  const source = resolve(ROOT, asset.source);
  const image = await dataUrl(source);
  await page.setViewportSize({ width: SHOT.width, height: asset.contentHeight ?? SHOT.height });
  const background = asset.raw ? "#fff" : "transparent";
  await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${SHOT.width}px;height:${asset.contentHeight ?? SHOT.height}px;overflow:hidden}
body{display:grid;place-items:center;background:${background}}
.content{display:block;width:${SHOT.width}px;height:${asset.contentHeight ?? SHOT.height}px;object-fit:${asset.fit ?? "fill"};object-position:${asset.position ?? "center"};background:#fff}
</style></head><body><img class="content" src="${image}" alt=""></body></html>`, { waitUntil: "load" });
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  const path = resolve(OUTPUT, asset.name);
  await page.screenshot({ path, type: "png", animations: "disabled" });
  entries.set(`docs/screenshots/${asset.name}`, { path: `docs/screenshots/${asset.name}`, width: SHOT.width, height: asset.contentHeight ?? SHOT.height, theme: "light", treatment: asset.raw ? "raw GitHub screenshot on white" : "bare app window, radius and shadow applied by the page", source: asset.source, scenario: asset.scenario });
  console.log(path);
}

await browser.close();
await writeFile(MANIFEST, `${JSON.stringify({ assets: [...entries.values()] }, null, 2)}\n`);
