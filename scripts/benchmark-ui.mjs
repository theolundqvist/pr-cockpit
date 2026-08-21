import { writeFile, readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
// Run the fixture open/diff pass with Bun; run the authenticated Origin and private-search passes with Node because Bun 1.3.14 hangs in Playwright connectOverCDP.

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
    cockpit: { ...cockpit, definition: cockpitDefinition, samples: cockpitSamples.map((sample) => Math.round(sample * 10) / 10) },
    github: { ...github, definition: githubDefinition, samples: githubSamples.map((sample) => Math.round(sample * 10) / 10) },
    speedup: Math.round((github.p50 / cockpit.p50) * 10) / 10,
  };
}

const SEARCH_WORDS = "remove  harness efficiency";
const SEARCH_REPO = "scape-app/scape";
const SEARCH_RESULT_PR = 8133;
const SEARCH_RESULTS_URL = `https://github.com/${SEARCH_REPO}/pulls?q=${encodeURIComponent(`is:pr is:open ${SEARCH_WORDS}`)}`;
const SEARCH_COCKPIT_URL = process.env.COCKPIT_URL ?? "http://127.0.0.1:4825";

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

async function benchmarkPrSearch(page, searchWords, repo, prNumber) {
  const samples = [];
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.locator(".inbox-layout .row").first().waitFor();
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    const duration = await page.evaluate(async ({ searchQuery, expectedKey, expectedRef }) => {
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
          const words = searchQuery.toLowerCase().split(/\s+/);
          const result = [...document.querySelectorAll(".palette-result")].find((candidate) => {
            const text = candidate.textContent.toLowerCase();
            const reference = candidate.querySelector(".pr-ref")?.textContent.trim();
            return candidate.dataset.prKey === expectedKey
              && reference === expectedRef
              && words.every((word) => text.includes(word));
          });
          if (result) return resolve();
          if (performance.now() > deadline) return reject(new Error("timed out searching PRs"));
          requestAnimationFrame(check);
        };
        check();
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - startedAt;
    }, { searchQuery: searchWords, expectedKey: `${repo}#${prNumber}`, expectedRef: `${repo.split("/").at(-1)}#${prNumber}` });
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

async function benchmarkGithubPrSearch(page, repo, prNumber, resultsURL) {
  const samples = [];
  for (let iteration = 0; iteration < RUNS + WARMUPS; iteration++) {
    await page.goto("about:blank");
    const startedAt = performance.now();
    await page.goto(resultsURL, { waitUntil: "commit" });
    await page.waitForFunction(
      ({ repository, number }) => {
        const link = document.querySelector(`a[href="/${repository}/pull/${number}"]`);
        return Boolean(link?.textContent.trim() && link.getBoundingClientRect().width > 0);
      },
      { repository: repo, number: prNumber },
      { timeout: 30_000 },
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const duration = performance.now() - startedAt;
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
const CURSOR_PR_NUMBER = 8105;

function cursorMeasurement(definition, samples) {
  return {
    available: true,
    ...summarizeSamples(samples),
    definition,
    samples: samples.map((sample) => Math.round(sample * 10) / 10),
  };
}

async function connectCursorPage(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 90_000 });
  const page = browser.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("cursor.com/codebase/scape/scape"));
  if (!page) throw new Error(`Cursor Origin page unavailable at ${endpoint}; open ${CURSOR_ORIGIN_URL} in the authenticated browser`);
  return { browser, page };
}

async function waitForCursorList(page) {
  await page.goto("https://cursor.com/codebase/scape/scape/pulls");
  await page.waitForFunction(
    () => document.readyState !== "loading" && location.pathname.endsWith("/pulls"),
    undefined,
    { timeout: 90_000 },
  );
  const url = await page.evaluate(() => location.href);
  if (url.startsWith("https://authenticator.cursor.sh/") || url.startsWith("https://accounts.google.com/")) {
    throw new Error(`Cursor Origin authentication unavailable: ${url}`);
  }
  await page.waitForFunction(
    (prNumber) => {
      const shell = document.querySelector('[data-testid="cursor-review-pulls-page"]');
      const row = [...document.querySelectorAll(`a[href$="/github/pull/${prNumber}"]`)]
        .find((element) => element.getBoundingClientRect().width > 0);
      return Boolean(shell && row);
    },
    CURSOR_PR_NUMBER,
    { timeout: 90_000 },
  );
}

async function measureCursorDiff(page) {
  return page.evaluate(async () => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((element) => element.innerText.trim().startsWith("Changes") && visible(element));
    if (!tab) throw new Error("Cursor Origin Changes tab selector unavailable");
    const startedAt = performance.now();
    tab.click();
    const deadline = startedAt + 30_000;
    while (performance.now() < deadline) {
      const panel = document.querySelector('[class*="changesTabPanel"]');
      const line = [...document.querySelectorAll('[class*="changesTabPanel"] [class*="lineContainer"]')].find(visible);
      if (location.pathname.endsWith("/changes") && visible(panel) && line) {
        await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
        return performance.now() - startedAt;
      }
      await new Promise(requestAnimationFrame);
    }
    throw new Error("Cursor Origin diff-painted selector unavailable");
  });
}

async function measureCursorOpen(page) {
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

const RENDER_REPO = "scape-app/scape";
const RENDER_PR = 8132;
const RENDER_RUNS = 100;
const RENDER_GITHUB_LIST_URL = `https://github.com/${RENDER_REPO}/pulls?q=${encodeURIComponent(`is:pr ${RENDER_PR}`)}`;
const RENDER_CURSOR_LIST_URL = "https://cursor.com/codebase/scape/scape/pulls";
const RENDER_BOUNDARY = `Pull-request list row for #${RENDER_PR} to painted detail: title, first conversation body, no loading indicator`;

function summarizeRender(samples) {
  const round = (value) => Math.round(value * 10) / 10;
  return {
    unit: "ms",
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
    p99: round(percentile(samples, 0.99)),
  };
}

function renderMeasurement(definition, samples) {
  return {
    available: true,
    ...summarizeRender(samples),
    definition,
    samples: samples.map((sample) => Math.round(sample * 10) / 10),
  };
}

async function measureCockpitRender(page) {
  await page.evaluate(() => {
    location.hash = "#/";
  });
  await page.locator(".inbox-layout .row").first().waitFor();
  return page.evaluate(async (target) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const row = [...document.querySelectorAll(".inbox-layout .row")].find((candidate) => candidate.getAttribute("href") === target.href);
    if (!row) throw new Error(`missing inbox row ${target.href}`);
    const startedAt = performance.now();
    row.click();
    const deadline = startedAt + 60_000;
    while (performance.now() < deadline) {
      const detail = document.querySelector(".detail:not(.loading-detail)");
      const eyebrow = detail?.querySelector(".pr-title-copy .ui-eyebrow");
      const heading = detail?.querySelector(".pr-title-row h1");
      const body = detail?.querySelector(".cols .left .body-card .md");
      const loading = document.querySelector(".loading-detail, .loading-spinner");
      if (
        location.hash === target.href
        && visible(heading) && heading.innerText.trim()
        && eyebrow?.innerText.includes(`#${target.number}`)
        && visible(body) && body.innerText.trim()
        && !loading
      ) {
        await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
        return performance.now() - startedAt;
      }
      await new Promise(requestAnimationFrame);
    }
    throw new Error("PR Cockpit detail-painted selector unavailable");
  }, { href: `#/pr/${RENDER_REPO}/${RENDER_PR}`, number: RENDER_PR });
}

async function measureGithubRender(page) {
  const href = `/${RENDER_REPO}/pull/${RENDER_PR}`;
  await page.goto(RENDER_GITHUB_LIST_URL, { waitUntil: "domcontentloaded" });
  await page.locator(`a[href="${href}"]`).first().waitFor();
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
  await page.waitForFunction((prNumber) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const heading = [...document.querySelectorAll("h1")].find((element) => visible(element) && element.innerText.includes(`#${prNumber}`));
    const comment = [...document.querySelectorAll(".js-timeline-item .comment-body, .timeline-comment .comment-body")]
      .find((element) => visible(element) && element.innerText.trim());
    const loading = [...document.querySelectorAll('[role="progressbar"],.js-comment-loading,svg.anim-rotate')].some(visible);
    return Boolean(heading && comment && !loading);
  }, RENDER_PR, { timeout: 60_000 });
  return afterPaint(page, startedAt);
}

async function measureCursorRender(page, listURL) {
  await page.goto(listURL, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction((prNumber) => {
      const shell = document.querySelector('[data-testid="cursor-review-pulls-page"]');
      const row = [...document.querySelectorAll(`a[href$="/github/pull/${prNumber}"]`)].find((element) => element.getBoundingClientRect().width > 0);
      return Boolean(shell && row);
    }, RENDER_PR, { timeout: 90_000 });
  } catch (error) {
    const url = page.url();
    if (url.startsWith("https://authenticator.cursor.sh/") || url.startsWith("https://accounts.google.com/")) {
      throw new Error(`Cursor Origin authentication unavailable: ${url}`);
    }
    throw error;
  }
  const startedAt = await page.evaluate((prNumber) => {
    const link = [...document.querySelectorAll(`a[href$="/github/pull/${prNumber}"]`)]
      .find((element) => element.getBoundingClientRect().width > 0);
    if (!link) throw new Error(`Cursor Origin row for #${prNumber} unavailable`);
    const started = performance.timeOrigin + performance.now();
    setTimeout(() => link.click());
    return started;
  }, RENDER_PR);
  await page.waitForFunction((prNumber) => {
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const heading = [...document.querySelectorAll("h1")].find((element) => visible(element)
      && `${element.getAttribute("aria-label") ?? ""}${element.innerText}`.includes(`#${prNumber}`));
    const timeline = [...document.querySelectorAll('[data-testid="timeline-activity-group"]')]
      .find((element) => visible(element) && element.innerText.trim());
    const loading = [...document.querySelectorAll('[role="progressbar"],svg.animate-spin')].some(visible);
    return Boolean(location.pathname.endsWith(`/pull/${prNumber}`) && heading && timeline && !loading);
  }, RENDER_PR, { timeout: 90_000 });
  return afterPaint(page, startedAt);
}

const TRANSIENT_NAVIGATION = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED/;
const RENDER_TRANSIENT_LIMIT = 25;
const CHECKPOINT_DIR = join(ROOT, ".scratch/render-p99");

async function collectRenderSamples(measure, page, runs, warmups) {
  const samples = [];
  let discarded = 0;
  for (let iteration = 0; iteration < runs + warmups; iteration++) {
    let duration;
    try {
      duration = await measure(page);
    } catch (error) {
      if (!TRANSIENT_NAVIGATION.test(String(error)) || discarded >= RENDER_TRANSIENT_LIMIT) throw error;
      discarded += 1;
      iteration -= 1;
      await delay(5_000);
      continue;
    }
    if (iteration >= warmups) samples.push(duration);
  }
  return { samples, discarded };
}

async function readCheckpoint(key, identity) {
  const stored = await readFile(join(CHECKPOINT_DIR, `${key}.json`), "utf8").catch(() => null);
  if (!stored) return null;
  const checkpoint = JSON.parse(stored);
  const matches = Object.entries(identity).every(([field, value]) => checkpoint[field] === value);
  if (!matches || checkpoint.samples.length !== identity.runs) return null;
  return checkpoint;
}

async function writeCheckpoint(key, checkpoint) {
  await mkdir(CHECKPOINT_DIR, { recursive: true });
  await writeFile(join(CHECKPOINT_DIR, `${key}.json`), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

async function writeResults(update) {
  const path = join(ROOT, "docs/benchmark-results.js");
  const existing = await readFile(path, "utf8");
  const previous = JSON.parse(existing.slice(existing.indexOf("=") + 1).trim().replace(/;$/, ""));
  await writeFile(path, `window.PR_COCKPIT_BENCHMARKS = ${JSON.stringify(update(previous), null, 2)};\n`);
  console.log("wrote docs/benchmark-results.js");
}

async function mainPrivateSearch() {
  const endpoint = process.env.CURSOR_CDP_URL ?? "http://127.0.0.1:9334";
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 90_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error(`no browser context at ${endpoint}; open a tab in the authenticated browser first`);
  const cockpitPage = await context.newPage();
  const githubPage = await context.newPage();
  try {
    await cockpitPage.goto(`${SEARCH_COCKPIT_URL}/#/`, { waitUntil: "domcontentloaded" });
    await cockpitPage.locator(".inbox-layout .row").first().waitFor({ timeout: 30_000 });
    await githubPage.goto(SEARCH_RESULTS_URL, { waitUntil: "domcontentloaded" });
    const signedIn = await githubPage.evaluate(() => Boolean(document.querySelector('meta[name="user-login"]')?.content));
    if (!signedIn) throw new Error(`the browser at ${endpoint} is signed out of GitHub; ${SEARCH_REPO} results are unreachable`);
    const viewport = await githubPage.evaluate(() => `${innerWidth}×${innerHeight}`);

    const cockpitSamples = await benchmarkPrSearch(cockpitPage, SEARCH_WORDS, SEARCH_REPO, SEARCH_RESULT_PR);
    const githubSamples = await benchmarkGithubPrSearch(githubPage, SEARCH_REPO, SEARCH_RESULT_PR, SEARCH_RESULTS_URL);
    const metric = compare(
      "pr-search",
      "Search PRs",
      `⌘K palette open, query applied, to painted ${SEARCH_REPO.split("/").at(-1)}#${SEARCH_RESULT_PR} result`,
      "Load the repo-scoped pull-request search URL for the same query to first painted result",
      cockpitSamples,
      githubSamples,
    );
    console.table([{
      metric: metric.label,
      "PR Cockpit p50": metric.cockpit.p50,
      "GitHub p50": metric.github.p50,
      "faster ×": metric.speedup,
    }]);
    if (process.argv.includes("--write")) {
      await writeResults((previous) => {
        const index = previous.metrics.findIndex((entry) => entry.id === "pr-search");
        if (index < 0) throw new Error("existing results are missing the pr-search metric");
        previous.metrics[index] = { ...metric, cursorOrigin: previous.metrics[index].cursorOrigin };
        previous.searchEnvironment = {
          measuredAt: new Date().toISOString(),
          machine: cpus()[0]?.model ?? "unknown CPU",
          browser: version.Browser,
          viewport,
          runs: RUNS,
          warmups: WARMUPS,
          auth: "One signed-in visible Chromium drives both products",
          dataset: `PR Cockpit global cache and GitHub's ${SEARCH_REPO} pull-request list receive the query "${SEARCH_WORDS.replace(/\s+/g, " ")}"; Cockpit requires ${SEARCH_REPO}#${SEARCH_RESULT_PR}`,
          cache: "Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs",
          cockpitURL: SEARCH_COCKPIT_URL,
          resultsURL: SEARCH_RESULTS_URL,
          cdp: endpoint,
          paintBoundary: `PR Cockpit: palette shortcut and programmatic query application to painted ${SEARCH_REPO}#${SEARCH_RESULT_PR}; GitHub: repo-scoped query URL navigation to first painted result; both followed by two requestAnimationFrame callbacks`,
        };
        return previous;
      });
    }
  } finally {
    await cockpitPage.close();
    await githubPage.close();
    await browser.close();
  }
}

  const smoke = process.argv.includes("--smoke");
  if (smoke && process.argv.includes("--write")) {
    throw new Error("--smoke is diagnostic only and cannot publish benchmark results");
  }

async function mainRenderP99() {
  const endpoint = process.env.CURSOR_CDP_URL ?? "http://127.0.0.1:9334";
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 90_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error(`no browser context at ${endpoint}; open a tab in the authenticated browser first`);
  const cockpitPage = await context.newPage();
  const githubPage = await context.newPage();
  const cursorPage = await context.newPage();
  try {
    await cockpitPage.goto(`${SEARCH_COCKPIT_URL}/#/`, { waitUntil: "domcontentloaded" });
    await cockpitPage.locator(".inbox-layout .row").first().waitFor({ timeout: 30_000 });
    await githubPage.goto(RENDER_GITHUB_LIST_URL, { waitUntil: "domcontentloaded" });
    const signedIn = await githubPage.evaluate(() => Boolean(document.querySelector('meta[name="user-login"]')?.content));
    if (!signedIn) throw new Error(`the browser at ${endpoint} is signed out of GitHub; ${RENDER_REPO}#${RENDER_PR} is unreachable`);
    const viewport = await githubPage.evaluate(() => `${innerWidth}×${innerHeight}`);

    await cursorPage.goto(RENDER_CURSOR_LIST_URL, { waitUntil: "domcontentloaded" });
    await cursorPage.waitForFunction(() => Boolean(document.querySelector('[data-testid="cursor-review-pulls-page"]')), undefined, { timeout: 90_000 });
    const cursorListURL = cursorPage.url();

    const runs = smoke ? 3 : RENDER_RUNS;
    const warmups = smoke ? 0 : WARMUPS;
    const identity = {
      target: `${RENDER_REPO}#${RENDER_PR}`,
      runs,
      warmups,
      boundary: RENDER_BOUNDARY,
      session: version.webSocketDebuggerUrl,
    };
    const phases = [
      { key: "github", product: "GitHub", definition: `Pull-request list row to painted detail of #${RENDER_PR}`, page: githubPage, measure: measureGithubRender },
      { key: "cursorOrigin", product: "Cursor Origin", definition: `Origin pull-request row to painted detail of #${RENDER_PR}`, page: cursorPage, measure: (page) => measureCursorRender(page, cursorListURL) },
      { key: "cockpit", product: "PR Cockpit", definition: `Inbox row to painted detail of #${RENDER_PR}`, page: cockpitPage, measure: measureCockpitRender },
    ];
    const measurements = {};
    for (const phase of phases) {
      const reused = smoke ? null : await readCheckpoint(phase.key, identity);
      const collected = reused ?? await collectRenderSamples(phase.measure, phase.page, runs, warmups);
      if (!reused && !smoke) await writeCheckpoint(phase.key, { ...identity, ...collected, measuredAt: new Date().toISOString() });
      measurements[phase.key] = {
        ...renderMeasurement(phase.definition, collected.samples),
        discardedIterations: collected.discarded,
      };
      console.log(`${phase.product}: ${collected.samples.length} samples${reused ? " reused from checkpoint" : ""}, ${collected.discarded} discarded after a transient network error`);
    }

    const { cockpit, github, cursorOrigin } = measurements;
    const benchmark = {
      id: "pr-render",
      label: "Render a huge PR",
      boundary: RENDER_BOUNDARY,
      cockpit,
      github,
      cursorOrigin,
      p99Speedup: Math.round((github.p99 / cockpit.p99) * 10) / 10,
      originP99Speedup: Math.round((cursorOrigin.p99 / cockpit.p99) * 10) / 10,
    };
    console.table(phases.map((phase) => ({
      product: phase.product,
      p50: measurements[phase.key].p50,
      p95: measurements[phase.key].p95,
      p99: measurements[phase.key].p99,
      samples: measurements[phase.key].samples.length,
    })));
    if (process.argv.includes("--write")) {
      await writeResults((previous) => ({
        ...previous,
        renderBenchmark: benchmark,
        renderEnvironment: {
          measuredAt: new Date().toISOString(),
          machine: cpus()[0]?.model ?? "unknown CPU",
          browser: version.Browser,
          viewport,
          runs,
          warmups,
          auth: "One signed-in visible Chromium drives all three products",
          dataset: `${RENDER_REPO}#${RENDER_PR}, a large open pull request`,
          cache: "Warm browser cache and warm PR Cockpit disk cache; neither is cleared between warmups or measured runs",
          cockpitURL: `${SEARCH_COCKPIT_URL}/#/pr/${RENDER_REPO}/${RENDER_PR}`,
          githubListURL: RENDER_GITHUB_LIST_URL,
          cursorListURL,
          cdp: endpoint,
          paintBoundary: `${RENDER_BOUNDARY}, followed by two requestAnimationFrame callbacks`,
          percentiles: `p99 is the 99th of ${runs} measured samples per product, not an interpolated estimate`,
          transientRetries: "Iterations lost to a transient network error are retried and never recorded as samples",
        },
      }));
      await rm(CHECKPOINT_DIR, { recursive: true, force: true });
    }
  } finally {
    await cockpitPage.close();
    await githubPage.close();
    await cursorPage.close();
    await browser.close();
  }
}

async function mainCursorOrigin() {
  const smoke = process.argv.includes("--smoke");
  const runs = smoke ? 1 : RUNS;
  const warmups = smoke ? 0 : WARMUPS;
  const endpoint = process.env.CURSOR_CDP_URL ?? "http://127.0.0.1:9334";
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const { browser, page } = await connectCursorPage(endpoint);
  try {
    await page.bringToFront();
    await page.setViewportSize(VIEWPORT);
    if (await page.evaluate(() => document.visibilityState) !== "visible") {
      throw new Error("Cursor Origin page is not visibly rendered");
    }
    const openSamples = [];
    const diffSamples = [];
    for (let iteration = 0; iteration < runs + warmups; iteration++) {
      await waitForCursorList(page);
      const open = await measureCursorOpen(page);
      const diff = await measureCursorDiff(page);
      if (iteration >= warmups) {
        openSamples.push(open.firstUseful);
        diffSamples.push(diff);
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
        auth: "Authenticated isolated Chromium profile",
        dataset: `scape-app/scape staging; representative open PR #${CURSOR_PR_NUMBER}`,
        cache: "Warm authenticated browser profile and HTTP cache; cache is not cleared between warmups or measured runs",
        sourceURL: CURSOR_ORIGIN_URL,
        cdp: endpoint,
        paintBoundary: "Visible selector followed by two requestAnimationFrame callbacks",
      },
      selectors: {
        openStart: `visible PR-list a[href$="/github/pull/${CURSOR_PR_NUMBER}"]`,
        openPainted: `[data-testid="cursor-review-pr-shell"] plus visible h1 aria-label containing #${CURSOR_PR_NUMBER}`,
        diffStart: 'visible [role="tab"] whose text starts with Changes',
        diffPath: `/codebase/scape/scape/pull/${CURSOR_PR_NUMBER}/changes`,
        diffPainted: 'visible [class*="changesTabPanel"] plus first visible descendant [class*="lineContainer"]',
      },
      metrics: {
        "pr-open": cursorMeasurement(`Origin PR #${CURSOR_PR_NUMBER} list row to first painted PR detail`, openSamples),
        "pr-search": {
          available: false,
          reason: "Cursor Origin exposes PR filters but no comparable PR word-search interaction",
        },
        "diff-open": cursorMeasurement(`Origin PR #${CURSOR_PR_NUMBER} Changes tab to first painted diff line`, diffSamples),
      },
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes("--write")) {
      await writeResults((shared) => {
        shared.cursorOriginEnvironment = {
          measuredAt: result.measuredAt,
          ...result.environment,
          selectors: result.selectors,
        };
        for (const metric of shared.metrics) metric.cursorOrigin = result.metrics[metric.id];
        return shared;
      });
    }
  } finally {
    await browser.close();
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
    const cockpitDiffSamples = await benchmarkDiffOpen(localPage, repo, diffPrs);
    await localContext.close();

    const githubContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: "reduce" });
    const githubPage = await githubContext.newPage();
    const githubOpenSamples = await benchmarkGithubPrOpen(githubPage, repo, prs);
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
        cache: `${prs.length} PRs rotated through ${RUNS} measured runs after ${WARMUPS} initial warmups, so this sample mixes first visits and revisits; PR Cockpit reads its warm local disk cache while GitHub uses the current network connection`,
        note: "The search metric is measured separately; see searchEnvironment",
      },
      metrics: [
        compare("pr-open", "Open a PR", "Inbox row to painted PR detail", "Pull-request result to painted PR detail", cockpitOpenSamples, githubOpenSamples),
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
      await writeResults((previous) => {
        const search = previous.metrics.find((metric) => metric.id === "pr-search");
        if (!search) throw new Error("existing results are missing the pr-search metric; run --private-search first");
        const previousOrigin = new Map(previous.metrics.map((metric) => [metric.id, metric.cursorOrigin]));
        for (const metric of results.metrics) metric.cursorOrigin = previousOrigin.get(metric.id);
        results.metrics.splice(1, 0, search);
        results.searchEnvironment = previous.searchEnvironment;
        results.cursorOriginEnvironment = previous.cursorOriginEnvironment;
        return results;
      });
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

const mode = process.argv.includes("--cursor-origin")
  ? mainCursorOrigin()
  : process.argv.includes("--private-search")
    ? mainPrivateSearch()
    : process.argv.includes("--render-p99")
      ? mainRenderP99()
      : main();

mode.catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
