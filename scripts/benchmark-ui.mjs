import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const SNAPSHOT_DIR = resolve(ROOT, "server/mockData/microsoft-vscode");
const VIEWPORT = { width: 1100, height: 800 };
const RUNS = 20;
const WARMUPS = 3;

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

function summarizeSamples(samples) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    unit: "ms",
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
  };
}

function compare(id, label, cockpitDefinition, githubDefinition, cockpitSamples, githubSamples) {
  const cockpit = summarizeSamples(cockpitSamples);
  const github = summarizeSamples(githubSamples);
  return {
    id,
    label,
    cockpit: { ...cockpit, definition: cockpitDefinition },
    github: { ...github, definition: githubDefinition },
    speedup: Math.round((github.p50 / cockpit.p50) * 10) / 10,
  };
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
          if (location.hash === targetHref && document.querySelector(".detail .tabs")) return resolve();
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
    }, { searchQuery: String(pr.number), title: pr.title });
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
          if (location.hash === targetHref && document.querySelector(".files-layout .line[data-new-line], .files-layout .binary")) return resolve();
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
async function afterPaint(page, startedAt) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate((started) => performance.timeOrigin + performance.now() - started, startedAt);
}

async function benchmarkGithubPrOpen(page, repo, prs) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const pr = prs[iteration % prs.length];
    const href = `/${repo}/pull/${pr.number}`;
    await page.goto(`https://github.com/${repo}/pulls?q=${encodeURIComponent(`is:pr ${pr.number}`)}`, { waitUntil: "domcontentloaded" });
    const result = page.locator(`a[href="${href}"]`).first();
    await result.waitFor();
    const startedAt = await page.evaluate((targetHref) => {
      const link = [...document.querySelectorAll("a")].find(
        (candidate) => candidate.getAttribute("href") === targetHref && candidate.textContent.trim(),
      );
      if (!link) throw new Error(`missing GitHub PR result ${targetHref}`);
      const started = performance.timeOrigin + performance.now();
      link.click();
      return started;
    }, href);
    await page.waitForURL((url) => url.pathname === href);
    await page.locator(`a[href="${href}/files"]`).first().waitFor();
    const duration = await afterPaint(page, startedAt);
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

async function benchmarkGithubPrSearch(page, repo, prs) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const pr = prs[iteration % prs.length];
    const searchQuery = String(pr.number);
    const expectedQuery = `is:pr ${searchQuery}`;
    const href = `/${repo}/pull/${pr.number}`;
    await page.goto(`https://github.com/${repo}/pulls?q=is%3Apr`, { waitUntil: "domcontentloaded" });
    await page.locator('input[aria-label="Search all issues"]').waitFor();
    const startedAt = await page.evaluate((query) => {
      const input = document.querySelector('input[aria-label="Search all issues"]');
      if (!input?.form) throw new Error("missing GitHub pull request search");
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const started = performance.timeOrigin + performance.now();
      input.form.requestSubmit();
      return started;
    }, expectedQuery);
    await page.waitForURL((url) => url.pathname === `/${repo}/pulls` && url.searchParams.get("q") === expectedQuery);
    await page.locator(`a[href="${href}"]`).first().waitFor();
    const duration = await afterPaint(page, startedAt);
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

async function benchmarkGithubDiffOpen(page, repo, prs) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const pr = prs[iteration % prs.length];
    const conversationHref = `/${repo}/pull/${pr.number}`;
    const filesHref = `${conversationHref}/files`;
    await page.goto(`https://github.com${conversationHref}`, { waitUntil: "domcontentloaded" });
    await page.locator(`a[href="${filesHref}"]`).first().waitFor();
    const startedAt = await page.evaluate((targetHref) => {
      const link = document.querySelector(`a[href="${targetHref}"]`);
      if (!link) throw new Error(`missing GitHub files tab ${targetHref}`);
      const started = performance.timeOrigin + performance.now();
      link.click();
      return started;
    }, filesHref);
    await page.waitForURL((url) => url.pathname === filesHref);
    await page.locator("table.diff-table .blob-code, table.diff-table [data-line-number]").first().waitFor();
    const duration = await afterPaint(page, startedAt);
    if (iteration >= WARMUPS) samples.push(duration);
  }
  return samples;
}

const CURSOR_ORIGIN_URL = "https://cursor.com/codebase/scape/scape/tree/staging";
const CURSOR_PR_NUMBER = 8110;

function cursorMetric(id, label, definition, samples) {
  const seconds = samples.map((sample) => Math.round(sample) / 1000);
  return {
    id,
    label,
    unit: "s",
    p50: percentile(seconds, 0.5),
    p95: percentile(seconds, 0.95),
    definition,
    samples: seconds,
  };
}

class CursorCdpPage {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolveConnection, reject) => {
      const timeout = setTimeout(() => reject(new Error("Cursor Origin CDP connection timed out")), 10_000);
      this.socket.onopen = () => {
        clearTimeout(timeout);
        resolveConnection();
      };
      this.socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Cursor Origin CDP connection failed"));
      };
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 90_000);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolveCommand(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(fn, argument) {
    const expression = typeof fn === "function"
      ? `(${fn.toString()})(${argument === undefined ? "" : JSON.stringify(argument)})`
      : fn;
    const response = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async goto(url) {
    await this.send("Page.navigate", { url });
  }

  async waitForFunction(fn, { timeout = 90_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(fn)) return;
      } catch {}
      await delay(50);
    }
    throw new Error("Cursor Origin render-state selector unavailable");
  }

  async bringToFront() {
    await this.send("Page.bringToFront");
  }

  async setViewportSize(viewport) {
    await this.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  }

  close() {
    this.socket.close();
  }
}

async function connectCursorPage(endpoint) {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes("cursor.com/codebase/scape/scape"));
  if (!target) throw new Error(`Cursor Origin page unavailable at ${endpoint}; open ${CURSOR_ORIGIN_URL} in the authenticated browser`);
  return new CursorCdpPage(target).connect();
}


async function waitForCursorCodePage(page) {
  await page.goto(CURSOR_ORIGIN_URL);
  await page.waitForFunction(
    () => document.readyState !== "loading" && location.pathname.endsWith("/tree/staging"),
    { timeout: 90_000 },
  );
  const url = await page.evaluate(() => location.href);
  if (url.startsWith("https://authenticator.cursor.sh/") || url.startsWith("https://accounts.google.com/")) {
    throw new Error(`Cursor Origin authentication unavailable: ${url}`);
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('a[href$="/pulls"]')].some((element) => element.getBoundingClientRect().width > 0),
    { timeout: 90_000 },
  );
}


async function measureCursorList(page) {
  return page.evaluate(async () => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const link = [...document.querySelectorAll('a[href$="/pulls"]')].find(visible);
    if (!link) throw new Error("Cursor Origin Pull Requests link selector unavailable");
    const startedAt = performance.now();
    const result = {};
    let firstPending = false;
    let fullPending = false;
    const afterPaint = (key) => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (result[key] === undefined) result[key] = performance.now() - startedAt;
    }));
    link.click();
    const deadline = startedAt + 30_000;
    while ((result.firstUseful === undefined || result.full === undefined) && performance.now() < deadline) {
      const shell = document.querySelector('[data-testid="cursor-review-pulls-page"]');
      const rows = [...document.querySelectorAll('a[class*="rowTitleLink"][href*="/github/pull/"]')];
      if (result.firstUseful === undefined && !firstPending && visible(shell) && rows.some(visible)) {
        firstPending = true;
        afterPaint("firstUseful");
      }
      const openText = [...document.querySelectorAll("a,button")]
        .map((element) => element.innerText?.trim())
        .find((text) => /^Open\n\d+$/.test(text ?? ""));
      const expectedRows = Number(openText?.split("\n")[1]);
      const loading = [...document.querySelectorAll('[role="progressbar"],svg.animate-spin')].some(visible);
      if (result.full === undefined && !fullPending && expectedRows > 0 && rows.length === expectedRows && !loading) {
        fullPending = true;
        afterPaint("full");
      }
      await new Promise(requestAnimationFrame);
    }
    if (result.firstUseful === undefined) throw new Error("Cursor Origin PR-list first-useful selector unavailable");
    if (result.full === undefined) throw new Error("Cursor Origin PR-list full-render selector unavailable");
    return result;
  });
}

async function measureCursorDetail(page) {
  return page.evaluate(async (prNumber) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const link = [...document.querySelectorAll(`a[href$="/github/pull/${prNumber}"]`)].find(visible);
    if (!link) throw new Error(`Cursor Origin representative PR #${prNumber} selector unavailable`);
    const startedAt = performance.now();
    const result = {};
    let firstPending = false;
    let completePending = false;
    const afterPaint = (key) => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (result[key] === undefined) result[key] = performance.now() - startedAt;
    }));
    link.click();
    const deadline = startedAt + 30_000;
    while ((result.firstUseful === undefined || result.complete === undefined) && performance.now() < deadline) {
      const shell = document.querySelector('[data-testid="cursor-review-pr-shell"]');
      const heading = [...document.querySelectorAll("h1")].find((element) => element.getAttribute("aria-label")?.includes(`#${prNumber}`));
      if (
        result.firstUseful === undefined
        && !firstPending
        && location.pathname.endsWith(`/pull/${prNumber}`)
        && visible(shell)
        && visible(heading)
      ) {
        firstPending = true;
        afterPaint("firstUseful");
      }
      const timeline = [...document.querySelectorAll('[data-testid="timeline-activity-group"]')]
        .find((element) => visible(element) && element.innerText.trim());
      const mergeBox = document.querySelector('[data-testid="merge-box"]');
      const loading = [...document.querySelectorAll('[role="progressbar"],svg.animate-spin')].some(visible);
      if (result.complete === undefined && !completePending && timeline && visible(mergeBox) && !loading) {
        completePending = true;
        afterPaint("complete");
      }
      await new Promise(requestAnimationFrame);
    }
    if (result.firstUseful === undefined) throw new Error("Cursor Origin PR-detail first-useful selector unavailable");
    if (result.complete === undefined) throw new Error("Cursor Origin PR-detail complete-render selector unavailable");
    return result;
  }, CURSOR_PR_NUMBER);
}

async function mainCursorOrigin() {
  const smoke = process.argv.includes("--smoke");
  const runs = smoke ? 1 : RUNS;
  const warmups = smoke ? 0 : WARMUPS;
  const endpoint = process.env.CURSOR_CDP_URL ?? "http://127.0.0.1:9334";
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const page = await connectCursorPage(endpoint);
  try {
    await page.bringToFront();
    await page.setViewportSize(VIEWPORT);
    if (await page.evaluate(() => document.visibilityState) !== "visible") {
      throw new Error("Cursor Origin page is not visibly rendered");
    }
    const listFirstUseful = [];
    const listFull = [];
    const detailFirstUseful = [];
    const detailComplete = [];
    for (let iteration = 0; iteration < runs + warmups; iteration++) {
      await waitForCursorCodePage(page);
      const list = await measureCursorList(page);
      const detail = await measureCursorDetail(page);
      if (iteration >= warmups) {
        listFirstUseful.push(list.firstUseful);
        listFull.push(list.full);
        detailFirstUseful.push(detail.firstUseful);
        detailComplete.push(detail.complete);
      }
    }
    const result = {
      measuredAt: new Date().toISOString(),
      environment: {
        machine: cpus()[0]?.model ?? "unknown CPU",
        browser: version.Browser,
        viewport: `${VIEWPORT.width}×${VIEWPORT.height}`,
        runs,
        warmups,
        dataset: `Authenticated scape-app/scape staging; representative PR #${CURSOR_PR_NUMBER}`,
        cache: "Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs",
        sourceURL: CURSOR_ORIGIN_URL,
      },
      selectors: {
        listStart: 'visible a[href$="/pulls"]',
        listFirstUseful: '[data-testid="cursor-review-pulls-page"] plus first visible a[class*="rowTitleLink"]',
        listFull: 'rendered rowTitleLink count equals the visible Open count, with no visible progressbar or animate-spin',
        detailStart: `visible a[href$="/github/pull/${CURSOR_PR_NUMBER}"]`,
        detailFirstUseful: `[data-testid="cursor-review-pr-shell"] plus visible h1 aria-label containing #${CURSOR_PR_NUMBER}`,
        detailComplete: '[data-testid="timeline-activity-group"] with content plus visible [data-testid="merge-box"], with no visible progressbar or animate-spin',
      },
      metrics: [
        cursorMetric("pr-list-first-useful", "PR list first useful paint", "Pull Requests navigation to first painted PR row", listFirstUseful),
        cursorMetric("pr-list-full", "PR list full render", "Pull Requests navigation to all Open rows painted", listFull),
        cursorMetric("pr-detail-first-useful", "PR detail first useful paint", `PR #${CURSOR_PR_NUMBER} click to painted detail shell and heading`, detailFirstUseful),
        cursorMetric("pr-detail-complete", "PR detail complete render", `PR #${CURSOR_PR_NUMBER} click to painted activity timeline and merge box`, detailComplete),
      ],
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes("--write")) {
      const path = join(ROOT, "docs/benchmark-results.js");
      const existing = await readFile(path, "utf8");
      const shared = JSON.parse(existing.slice(existing.indexOf("=") + 1).trim().replace(/;$/, ""));
      shared.cursorOrigin = result;
      await writeFile(path, `window.PR_COCKPIT_BENCHMARKS = ${JSON.stringify(shared, null, 2)};\n`);
      console.log("wrote docs/benchmark-results.js");
    }
  } finally {
    page.close();
  }
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
    const localContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await localContext.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseURL || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      return route.abort("blockedbyclient");
    });
    const localPage = await localContext.newPage();
    await localPage.goto(`${baseURL}/#/`, { waitUntil: "domcontentloaded" });
    await localPage.locator(".inbox-layout .row").first().waitFor();

    const cockpitOpenSamples = await benchmarkPrOpen(localPage, repo, prs);
    const cockpitSearchSamples = await benchmarkPrSearch(localPage, prs);
    const cockpitDiffSamples = await benchmarkDiffOpen(localPage, repo, diffPrs);
    await localContext.close();

    const githubContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const githubPage = await githubContext.newPage();
    const githubOpenSamples = await benchmarkGithubPrOpen(githubPage, repo, prs);
    const githubSearchSamples = await benchmarkGithubPrSearch(githubPage, repo, prs);
    const githubDiffSamples = await benchmarkGithubDiffOpen(githubPage, repo, diffPrs);
    await githubContext.close();

    const results = {
      measuredAt: new Date().toISOString(),
      environment: {
        machine: cpus()[0]?.model ?? "unknown CPU",
        browser: `Chromium ${browser.version()}`,
        viewport: `${VIEWPORT.width}×${VIEWPORT.height}`,
        runs: RUNS,
        warmups: WARMUPS,
        dataset: `${prs.length} public microsoft/vscode PRs`,
        cache: "Warm browser cache for both products; PR Cockpit reads its local disk cache while GitHub uses the current network connection",
      },
      metrics: [
        compare("pr-open", "Open a PR", "Inbox row to painted PR detail", "Pull-request result to painted PR detail", cockpitOpenSamples, githubOpenSamples),
        compare("pr-search", "Search PRs", "⌘K PR-number query to painted local result", "Pull-request number query submit to painted result", cockpitSearchSamples, githubSearchSamples),
        compare("diff-open", "Open a diff", "Files click to painted cached diff", "Files changed click to painted GitHub diff", cockpitDiffSamples, githubDiffSamples),
      ],
    };
    console.table(
      results.metrics.map(({ label, cockpit, github, speedup }) => ({
        metric: label,
        "PR Cockpit p50": cockpit.p50,
        "GitHub p50": github.p50,
        "faster ×": speedup,
      })),
    );
    if (process.argv.includes("--write")) {
      const output = `window.PR_COCKPIT_BENCHMARKS = ${JSON.stringify(results, null, 2)};\n`;
      await writeFile(join(ROOT, "docs/benchmark-results.js"), output);
      console.log("wrote docs/benchmark-results.js");
    }
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

(process.argv.includes("--cursor-origin") ? mainCursorOrigin() : main()).catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
