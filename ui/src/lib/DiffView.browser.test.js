import { chromium } from "playwright";
import { createServer } from "vite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const uiRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const path = "backend/db/schema.sql";
const additions = [
  "ALTER TABLE inbox_tab",
  "  ADD CONSTRAINT inbox_tab_owner_check",
  "  CHECK (owner_id IS NOT NULL);",
  "COMMENT ON TABLE inbox_tab IS 'Owned inbox tabs';",
];

// A short Files view has a scroll container but no overflow yet. It must mount
// visible rows before user input, rather than waiting for a scroll that cannot happen.
test("renders a short diff in a non-overflowing scroll container on mount, resize, and remount", { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: uiRoot,
    logLevel: "error",
    plugins: [{
      name: "diff-browser-runtime",
      resolveId(id) { if (id === "virtual:diff-browser-runtime") return id; },
      load(id) { if (id === "virtual:diff-browser-runtime") return 'export { mount, unmount } from "svelte";'; },
    }],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [uiRoot, repoRoot] } },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const base = server.resolvedUrls.local[0];
    await page.route("**/short-diff.html", (route) => route.fulfill({
      contentType: "text/html",
      body: `<base href="${base}"><style>body { margin: 0; } .page { height: calc(100vh - 100px); overflow: auto; }</style><main class="page"><div id="diff-root"></div></main>`,
    }));
    await page.goto(`${base}short-diff.html`);
    await page.evaluate(async ({ path, additions }) => {
      const [{ mount, unmount }, { default: DiffView }, { parseDiff }] = await Promise.all([
        import("/@id/virtual:diff-browser-runtime"),
        import("/src/lib/DiffView.svelte"),
        import("/src/lib/diff.js"),
        import("/src/app.css"),
      ]);
      const files = parseDiff([
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -0,0 +1,4 @@",
        ...additions.map((line) => `+${line}`),
        "",
      ].join("\n"));
      const props = {
        files,
        diffIdentity: "short-diff-regression",
        anchored: new Map(),
        collapsed: new Set(),
        pendingInline: [],
        threadProps: () => ({}),
        onToggleFile: () => {},
        repo: "example/fixture",
        headSha: "fixture-head",
        commentable: false,
        layout: "unified",
      };
      const target = document.getElementById("diff-root");
      let component = mount(DiffView, { target, props });
      window.remountDiff = async () => {
        await unmount(component);
        component = mount(DiffView, { target, props });
      };
    }, { path, additions });

    const assertVisibleDiff = async () => {
      await page.waitForFunction(() => document.querySelectorAll(".file .line.add .code").length === 4, null, { timeout: 5_000 });
      expect(await page.locator(".file-path").textContent()).toBe(path);
      expect(await page.locator(".file .line.add .code").allTextContents()).toEqual(additions);
      expect(await page.locator(".file-head-placeholder").count()).toBe(0);
      expect(await page.locator(".page").evaluate((element) => ({
        overflow: getComputedStyle(element).overflowY,
        fits: element.scrollHeight === element.clientHeight,
        scrollTop: element.scrollTop,
      }))).toEqual({ overflow: "auto", fits: true, scrollTop: 0 });
    };
    await assertVisibleDiff();
    await page.setViewportSize({ width: 1100, height: 900 });
    await assertVisibleDiff();
    await page.evaluate(() => window.remountDiff());
    await assertVisibleDiff();
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.close();
  }
});
