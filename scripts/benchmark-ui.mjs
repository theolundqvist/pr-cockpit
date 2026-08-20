import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_DIR = resolve(ROOT, "server/mockData/microsoft-vscode");
const VIEWPORT = { width: 1100, height: 800 };
const RUNS = 50;
const WARMUPS = 5;

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(server, baseURL) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try {
      if ((await fetch(`${baseURL}/api/settings`)).ok) return;
    } catch {}
    await delay(75);
  }
  throw new Error("server did not become ready within 15s");
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summarize(id, label, definition, samples) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    id,
    label,
    definition,
    unit: "ms",
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
  };
}

function titleQuery(title) {
  return title.split(/\W+/).filter(Boolean).slice(0, 3).join(" ");
}

async function benchmarkPrOpen(page, repo, prs) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const href = `#/pr/${repo}/${prs[iteration % prs.length].number}`;
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.locator(".inbox-layout .row").first().waitFor();
    const duration = await page.evaluate(async (targetHref) => {
      const row = [...document.querySelectorAll(".inbox-layout .row")].find((candidate) => candidate.getAttribute("href") === targetHref);
      if (!row) throw new Error(`missing inbox row ${targetHref}`);
      const startedAt = performance.now();
      row.click();
      await new Promise((resolve, reject) => {
        const deadline = startedAt + 5_000;
        const check = () => {
          if (location.hash === targetHref && document.querySelector(".detail")) return resolve();
          if (performance.now() > deadline) return reject(new Error("timed out opening PR"));
          requestAnimationFrame(check);
        };
        check();
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - startedAt;
    }, href);
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

async function benchmarkPrSearch(page, prs) {
  const samples = [];
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.locator(".inbox-layout .row").first().waitFor();
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const pr = prs[iteration % prs.length];
    const duration = await page.evaluate(async ({ searchQuery, title }) => {
      const startedAt = performance.now();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      await new Promise((resolve, reject) => {
        const deadline = startedAt + 5_000;
        const check = () => {
          const input = document.querySelector(".palette-input");
          if (input) return resolve(input);
          if (performance.now() > deadline) return reject(new Error("timed out opening palette"));
          requestAnimationFrame(check);
        };
        check();
      }).then((input) => {
        input.value = searchQuery;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await new Promise((resolve, reject) => {
        const deadline = startedAt + 5_000;
        const check = () => {
          const result = [...document.querySelectorAll(".palette-result")].find((candidate) => candidate.textContent.includes(title));
          if (result) return resolve();
          if (performance.now() > deadline) return reject(new Error("timed out searching PRs"));
          requestAnimationFrame(check);
        };
        check();
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - startedAt;
    }, { searchQuery: titleQuery(pr.title), title: pr.title });
    await page.keyboard.press("Escape");
    await page.locator(".palette").waitFor({ state: "detached" });
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

async function benchmarkDiffOpen(page, repo, prs) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const conversationHref = `#/pr/${repo}/${prs[iteration % prs.length].number}`;
    const filesHref = `${conversationHref}/files`;
    await page.evaluate((href) => {
      location.hash = href;
    }, conversationHref);
    await page.locator(".detail .tabs").waitFor();
    const duration = await page.evaluate(async (targetHref) => {
      const tab = [...document.querySelectorAll(".tabs .tab")].find((candidate) => candidate.getAttribute("href") === targetHref);
      if (!tab) throw new Error(`missing files tab ${targetHref}`);
      const startedAt = performance.now();
      tab.click();
      await new Promise((resolve, reject) => {
        const deadline = startedAt + 5_000;
        const check = () => {
          if (location.hash === targetHref && document.querySelector(".files-layout .diff")) return resolve();
          if (performance.now() > deadline) return reject(new Error("timed out opening diff"));
          requestAnimationFrame(check);
        };
        check();
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - startedAt;
    }, filesHref);
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

async function main() {
  const snapshot = JSON.parse(await readFile(join(SNAPSHOT_DIR, "snapshot.json"), "utf8"));
  const repo = snapshot.repo;
  const prs = snapshot.details;
  const diffPrs = prs.filter((pr) => snapshot.diffs?.[pr.number]);
  if (!prs.length || diffPrs.length !== prs.length) throw new Error("benchmark fixture must contain open PRs and a diff for each PR");
  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-benchmark-"));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, "server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_PORT: String(port),
      COCKPIT_MOCK: "1",
      COCKPIT_MOCK_DATA: SNAPSHOT_DIR,
      COCKPIT_REPO_ROOTS: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  let browser;
  try {
    await waitForServer(server, baseURL);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseURL || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}/#/`, { waitUntil: "domcontentloaded" });
    await page.locator(".inbox-layout .row").first().waitFor();

    const openSamples = await benchmarkPrOpen(page, repo, prs);
    const searchSamples = await benchmarkPrSearch(page, prs);
    const diffSamples = await benchmarkDiffOpen(page, repo, diffPrs);
    const results = {
      measuredAt: new Date().toISOString(),
      environment: {
        machine: cpus()[0]?.model ?? "unknown CPU",
        browser: `Chromium ${browser.version()}`,
        viewport: `${VIEWPORT.width}×${VIEWPORT.height}`,
        runs: RUNS,
        warmups: WARMUPS,
        dataset: `${prs.length} public microsoft/vscode PRs`,
      },
      metrics: [
        summarize("pr-open", "Open cached PR", "Inbox click to painted PR detail", openSamples),
        summarize("pr-search", "Search recent PRs", "⌘K to painted local title match", searchSamples),
        summarize("diff-open", "Open cached diff", "Files click to painted cached diff", diffSamples),
      ],
    };
    console.table(results.metrics.map(({ label, p50, p95 }) => ({ metric: label, p50, p95 })));
    if (process.argv.includes("--write")) {
      const output = `window.PR_COCKPIT_BENCHMARKS = ${JSON.stringify(results, null, 2)};\n`;
      await writeFile(join(ROOT, "docs/benchmark-results.js"), output);
      console.log("wrote docs/benchmark-results.js");
    }
    await context.close();
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([server.exited, delay(2_000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
