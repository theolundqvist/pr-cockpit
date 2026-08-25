import { createServer } from "node:net";
import { inflateSync } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { mockAvatarSvg } from "../server/mockImages.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXED_NOW = Date.parse("2026-07-15T10:00:00.000Z");
const DEFAULT_SIZES = ["1600x1200"];
const DEFAULT_OUT = "screenshots";
const REPO = "fixture/cockpit";

function mockAvatarLogin(url) {
  if (url.host !== "github.com") return null;
  return url.pathname.match(/^\/([^/]+)\.png$/)?.[1] ?? null;
}

const scenarios = [
  {
    name: "inbox-populated",
    route: "#/",
    description: "Populated inbox with mixed ownership, CI, review, and merge states.",
    ready: ".inbox-layout .queue-group",
    verify: async (page) => page.locator(".current-branch-badge").getByText("current", { exact: true }).waitFor(),
  },
  {
    name: "inbox-palette",
    route: "#/",
    description: "Inline pull request palette with appearance-aware modal material and scrim.",
    beforeGoto: async (page, { baseURL }) => {
      const settings = await requestJson(`${baseURL}/api/settings`);
      await page.route("**/api/settings", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...settings, font_ui: "alacritty" }),
      }));
    },
    ready: ".inbox-layout .queue-group",
    interact: async (page) => page.getByRole("button", { name: /Find a pull request/ }).click(),
    verify: async (page) => {
      const palette = page.locator(".palette:not(.standalone)");
      await palette.waitFor();
      if (new URL(page.url()).hash !== "#/") throw new Error(`quick action navigated away from the inbox: ${page.url()}`);
      const material = await palette.evaluate((node) => ({
        theme: document.documentElement.dataset.theme,
        scrim: getComputedStyle(node.parentElement).backgroundColor,
        panel: getComputedStyle(node).backgroundColor,
      }));
      if (material.theme === "dark") {
        const channels = material.scrim.match(/[\d.]+/g)?.map(Number) ?? [];
        if (channels.slice(0, 3).some((channel) => channel > 2) || (channels[3] ?? 0) < 0.5) {
          throw new Error(`dark palette scrim is washing out the app: ${material.scrim}`);
        }
      }
      if (material.panel === "rgba(0, 0, 0, 0)") throw new Error("palette material is transparent");
      await palette.locator(".pr-ref").first().waitFor();
      const typography = await palette.evaluate((node) => ({
        input: getComputedStyle(node.querySelector(".palette-input")).fontFamily,
        ref: getComputedStyle(node.querySelector(".pr-ref")).fontFamily,
        sans: getComputedStyle(document.documentElement).getPropertyValue("--sans").trim(),
        mono: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      }));
      if (typography.input === typography.ref || typography.sans === typography.mono) {
        throw new Error(`ordinary palette copy still inherits the technical font: ${JSON.stringify(typography)}`);
      }
    },
  },
  {
    name: "inbox-update-ready",
    route: "#/",
    description: "Update action aligned with the live push and full-sync status group.",
    beforeGoto: async (page) => page.route("**/api/version", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ updateAvailable: true }),
    })),
    ready: ".head-right .update",
    verify: async (page) => {
      await page.getByRole("button", { name: "Install update", exact: true }).waitFor();
      await page.locator(".sync-status").waitFor();
    },
  },
  {
    name: "inbox-api-quota",
    route: "#/",
    sidebar: true,
    description: "Sidebar shows GitHub API health without exposing the unexplained 5,000-point ceiling as the primary label.",
    beforeGoto: async (page, { baseURL }) => {
      const settings = await requestJson(`${baseURL}/api/settings`);
      await page.route("**/api/settings", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...settings, hide_sidebar: false }),
      }));
      await quotaRoutes(page, { graphql: 3990, rest: 5000 });
    },
    ready: ".app-sidebar .quota-status",
    verify: async (page) => {
      await page.getByText("API healthy", { exact: true }).waitFor();
      await page.getByText("80% available", { exact: true }).waitFor();
    },
  },
  {
    name: "inbox-empty",
    route: "#/",
    description: "Inbox after every active fixture PR has been archived.",
    prepare: archiveActivePrs,
    ready: ".inbox-layout",
    verify: async (page) => page.getByText("No open pull requests", { exact: true }).waitFor(),
  },
  {
    name: "inbox-error",
    route: "#/",
    description: "Inbox error state after its API request fails.",
    beforeGoto: async (page) => page.route("**/api/inbox", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture inbox failure" }) })),
    ready: ".inbox-layout .empty",
    verify: async (page) => page.getByText("Error: inbox 500", { exact: true }).waitFor(),
  },
  {
    name: "inbox-archived",
    route: "#/",
    description: "Inbox with the archived queue expanded, including a closed PR.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.keyboard.press("Shift+A");
      await page.locator(".archived-group .row").first().waitFor();
    },
  },
  {
    name: "inbox-recently-merged",
    route: "#/",
    description: "Recently finished pull requests with merged and closed results.",
    beforeGoto: async (page, { baseURL }) => {
      const { prs } = await requestJson(`${baseURL}/api/inbox`);
      const terminalAt = new Date(FIXED_NOW - 1_800_000).toISOString();
      const closed = [
        { ...prs[0], state: "MERGED", mergedAt: terminalAt, closedAt: terminalAt, terminalAt },
        { ...prs[1], state: "CLOSED", mergedAt: null, closedAt: terminalAt, terminalAt },
      ];
      await page.route("**/api/closed", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ prs: closed }),
      }));
    },
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.getByRole("tab", { name: /Recently merged/ }).click();
      await page.locator(".queue-group .row").first().waitFor();
    },
    verify: async (page) => page.getByText("Recently finished", { exact: true }).waitFor(),
  },
  {
    name: "inbox-filter",
    route: "#/",
    description: "Inbox filtered to draft pull requests.",
    ready: ".inbox-layout .queue-group",
    interact: async (page) => {
      await page.keyboard.press("/");
      await page.locator(".filter-row input").fill("author:octocat");
    },
    verify: async (page) => {
      const value = await page.locator(".filter-row input").inputValue();
      if (value !== "author:octocat") throw new Error(`unexpected inbox filter: ${value}`);
      await page.locator(".queue-group .row").first().waitFor();
    },
  },
  {
    ...detail("detail-conversation", 101, "Green PR conversation with approvals, threads, comments, and successful checks."),
    verify: async (page) => {
      await page.locator(".current-branch-badge").getByText("current", { exact: true }).waitFor();
      const backArrow = page.locator(".app-history").getByRole("button", { name: /Back/ });
      await backArrow.waitFor();
      if (await backArrow.isDisabled()) throw new Error("PR back arrow should retain an inbox fallback");
      if (await page.locator(".detail .back").count()) throw new Error("PR view still renders a duplicate inline back control");
      const detailUrl = page.url();
      await backArrow.click();
      await page.waitForFunction(() => location.hash === "#/");
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
      await page.locator(".detail .pr-head").waitFor();
    },
  },
  {
    name: "detail-fetching-spinner",
    route: `#/pr/${REPO}/101`,
    description: "Uncached pull request while GitHub detail is pending, with its indexed header and spinner but no placeholder skeletons.",
    ready: ".app-history",
    beforeGoto: async (page) => page.route((url) => url.pathname === `/api/pr/${REPO}/101`, async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      await route.continue();
    }),
    interact: async (page) => page.waitForTimeout(350),
    verify: async (page) => {
      await page.locator(".loading-detail .pr-head h1").waitFor();
      if (!(await page.locator(".loading-detail .pr-head h1").innerText()).trim()) throw new Error("PR fetching state did not render the indexed title");
      const loadingHeader = await page.locator(".loading-detail .pr-head").boundingBox();
      const loadingDetail = await page.locator(".loading-detail").boundingBox();
      if (!loadingHeader || !loadingDetail || Math.abs(loadingHeader.x - loadingDetail.x) > 1 || Math.abs(loadingHeader.width - loadingDetail.width) > 1) {
        throw new Error(`PR fetching header is not aligned to the detail column: ${JSON.stringify({ loadingHeader, loadingDetail })}`);
      }
      await page.getByText("Fetching live GitHub details…", { exact: true }).waitFor();
      await page.locator(".loading-spinner").waitFor();
      if (await page.locator(".loading-card, .loading-line, .loading-title-placeholder").count()) throw new Error("PR fetching state rendered placeholder skeletons");
    },
  },
  {
    name: "detail-loading-transition",
    route: `#/pr/${REPO}/101`,
    description: "The indexed PR header keeps the same geometry when full GitHub details replace it.",
    beforeGoto: async (page) => page.route((url) => url.pathname === `/api/pr/${REPO}/101`, async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
      await route.continue();
    }),
    ready: ".loading-detail .pr-head",
    verify: async (page) => {
      const loadingHeader = await page.locator(".loading-detail .pr-head").boundingBox();
      const loadedHeaderNode = page.locator(".detail-frame:not(.loading-frame) .pr-head");
      await loadedHeaderNode.waitFor();
      const loadedHeader = await loadedHeaderNode.boundingBox();
      if (!loadingHeader || !loadedHeader) throw new Error("PR header was not measurable across the loading transition");
      for (const property of ["x", "y", "width", "height"]) {
        if (Math.abs(loadingHeader[property] - loadedHeader[property]) > 1) {
          throw new Error(`PR header shifted on load: ${property} ${loadingHeader[property]} -> ${loadedHeader[property]}`);
        }
      }
    },
  },
  {
    ...detail("detail-title-rename", 101, "Inline pull request title rename with its queued optimistic state."),
    beforeGoto: async (page) => {
      let submitted = false;
      await page.route("**/api/mutations**", async (route) => {
        const request = route.request();
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          const expected = { repo: REPO, number: 101, payload: { kind: "edit-title", title: "Ship the rename feature" } };
          if (JSON.stringify(body) !== JSON.stringify(expected)) throw new Error(`unexpected rename payload: ${JSON.stringify(body)}`);
          submitted = true;
          return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: 9_001 }) });
        }
        const mutations = submitted
          ? [{ id: 9_001, repo: REPO, number: 101, kind: "edit-title", payload: { kind: "edit-title", title: "Ship the rename feature" }, state: "pending", error: null, createdAt: new Date(FIXED_NOW).toISOString() }]
          : [];
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mutations }) });
      });
    },
    interact: async (page) => {
      await page.getByRole("button", { name: "Rename pull request", exact: true }).click();
      const input = page.getByRole("textbox", { name: "Pull request title", exact: true });
      await input.fill("Ship the rename feature");
      await input.press("Enter");
    },
    verify: async (page) => {
      await page.getByRole("heading", { name: "Ship the rename feature", exact: true }).waitFor();
      await page.getByText("SAVING…", { exact: true }).waitFor();
    },
  },
  {
    ...detail("detail-description-edit", 101, "Pull request description editor with a deterministic visible draft."),
    interact: async (page) => {
      await page.locator(".body-edit").click();
      const editor = page.locator(".body-editor textarea");
      await editor.fill("## Release plan\n\nShip the deterministic capture matrix with every interactive state visible.");
      await editor.scrollIntoViewIfNeeded();
    },
    verify: async (page) => {
      const value = await page.locator(".body-editor textarea").inputValue();
      if (!value.includes("deterministic capture matrix")) throw new Error("description draft was not rendered");
    },
  },
  {
    ...detail("detail-comment-compose", 101, "Conversation comment composer with a deterministic draft."),
    interact: async (page) => {
      const composer = page.locator("#composer-input");
      await composer.fill("The release notes now explain the state transition and rollback behavior.");
      await composer.scrollIntoViewIfNeeded();
    },
    verify: async (page) => page.getByRole("button", { name: "Comment", exact: true }).waitFor(),
  },
  {
    ...detail("detail-thread-reply", 103, "Open review thread with a deterministic reply draft."),
    interact: async (page) => {
      const reply = page.getByPlaceholder("Reply…").first();
      await reply.fill("I moved the conflict handling to the navigation state boundary.");
      await reply.scrollIntoViewIfNeeded();
    },
    verify: async (page) => page.getByRole("button", { name: "Reply", exact: true }).first().waitFor(),
  },
  {
    ...detail("detail-review-submission", 102, "Review submission controls prepared with a request-changes verdict."),
    interact: async (page) => {
      await page.locator("#verdict-control").selectOption("REQUEST_CHANGES");
      const body = page.getByPlaceholder("Optional body…");
      await body.fill("Please resolve the branch-protection blocker before merging.");
      await body.scrollIntoViewIfNeeded();
    },
    verify: async (page) => page.getByRole("button", { name: "Submit review", exact: true }).waitFor(),
  },
  {
    ...detail("detail-review-timeline", 115, "Compact approval activity followed by a substantive automated review summary."),
    interact: async (page) => page.locator(".greptile-event").scrollIntoViewIfNeeded(),
    verify: async (page) => {
      const approvals = page.locator(".activity-event");
      if (await approvals.count() !== 2) throw new Error(`expected 2 compact approvals, found ${await approvals.count()}`);
      if (await approvals.locator(".event-body").count()) throw new Error("bodyless approval rendered an empty event body");
      await page.locator(".greptile-event").getByRole("heading", { name: "Greptile Summary", exact: true }).waitFor();
      await page.locator(".greptile-event").getByText("Confidence Score: 5/5", { exact: true }).waitFor();
    },
  },
  {
    ...detail("detail-reviewer-picker", 102, "Reviewer picker populated with deterministic repository users."),
    interact: async (page) => {
      await page.keyboard.press("q");
      await page.getByRole("dialog", { name: "Request review from" }).waitFor();
      await page.getByPlaceholder("Filter people…").fill("reviewer");
    },
  },
  {
    ...detail("detail-assignee-picker", 101, "Assignee picker populated with deterministic repository users."),
    interact: async (page) => {
      await page.keyboard.press("s");
      await page.getByRole("dialog", { name: "Assign people" }).waitFor();
      await page.getByPlaceholder("Filter people…").fill("reviewer");
    },
  },
  {
    ...detail("detail-merge-confirmation", 101, "Ordinary merge confirmation without submitting the merge."),
    beforeGoto: async (page) => page.route("**/api/mutations**", (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: 9_101 }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mutations: [] }) });
    }),
    interact: async (page) => {
      await page.keyboard.press("m");
      await page.getByRole("alertdialog", { name: "Merge pull request #101?" }).waitFor();
    },
    verify: async (page) => {
      const dialog = page.getByRole("alertdialog", { name: "Merge pull request #101?" });
      await dialog.getByText("fixture/pr-101", { exact: true }).waitFor();
      await dialog.getByLabel("fixture/pr-101 into main").getByText("main", { exact: true }).waitFor();
      const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (focusedLabel !== "Merge pull request") throw new Error(`unexpected initial merge-dialog focus: ${focusedLabel}`);
      await page.keyboard.press("Tab");
      const wrappedLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (wrappedLabel !== "Cancel merge") throw new Error(`merge-dialog focus did not wrap to cancel: ${wrappedLabel}`);
      await page.keyboard.press("Shift+Tab");
      const restoredLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (restoredLabel !== "Merge pull request") throw new Error(`merge-dialog reverse focus did not wrap: ${restoredLabel}`);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await page.keyboard.press("m");
      await page.getByRole("alertdialog", { name: "Merge pull request #101?" }).waitFor();
      const mergeRequestPending = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/mutations"));
      await page.keyboard.press("Enter");
      const mergeRequest = await mergeRequestPending;
      const expectedPayload = { repo: REPO, number: 101, payload: { kind: "merge", force: false, baseRef: "main", method: "squash", source: "default" } };
      if (JSON.stringify(mergeRequest.postDataJSON()) !== JSON.stringify(expectedPayload)) {
        throw new Error(`unexpected keyboard merge payload: ${JSON.stringify(mergeRequest.postDataJSON())}`);
      }
      await dialog.waitFor({ state: "detached" });
      await page.keyboard.press("m");
      await page.getByRole("alertdialog", { name: "Merge pull request #101?" }).waitFor();
    },
  },
  {
    ...detail("detail-close-confirmation", 101, "Close confirmation without closing the pull request."),
    interact: async (page) => {
      await page.keyboard.press("x");
      await page.locator(".close-confirm").waitFor();
    },
    verify: async (page) => page.getByText("close PR #101?", { exact: true }).waitFor(),
  },
  {
    ...detail("detail-find-bar", 101, "Find-in-page bar with deterministic matches highlighted."),
    interact: async (page) => {
      await page.keyboard.press("Meta+f");
      await page.getByPlaceholder("Find").fill("fixture");
    },
    verify: async (page) => page.locator(".find-bar .count").getByText(/\d+\/\d+/).waitFor(),
  },
  {
    ...detail("detail-image-lightbox", 101, "Markdown image opened in the deterministic image lightbox."),
    interact: async (page) => {
      const image = page.locator(".body-card .md img").first();
      await image.waitFor();
      await image.click();
      await page.locator(".lightbox img").waitFor();
    },
  },
  detail("detail-conversation-blocked", 102, "PR blocked by branch protection without an admin bypass."),
  {
    ...detail("detail-conversation-blocked-admin", 112, "Branch-protection block with the admin force-merge confirmation visible.", "fixture/admin-cockpit"),
    interact: async (page) => {
      await page.keyboard.press("Shift+M");
      await page.getByRole("alertdialog", { name: "Force-merge pull request #112?" }).waitFor();
    },
    verify: async (page) => {
      const dialog = page.getByRole("alertdialog", { name: "Force-merge pull request #112?" });
      await dialog.getByText("Source", { exact: true }).waitFor();
      if (await dialog.getByText("Bypass approval rule", { exact: true }).count()) throw new Error("force-merge eyebrow is still visible");
      if (await dialog.getByText("Required approvals will be bypassed.", { exact: false }).count()) throw new Error("force-merge explanation is still visible");
    },
  },
  {
    ...detail("detail-conversation-conflicts", 103, "PR with exact conflict paths and an agent resolution action."),
    ready: ".conflict-alert",
    verify: async (page) => {
      const paths = await page.locator(".conflict-file-list li").allTextContents();
      const expected = ["ui/navigation.ts", "ui/src/lib/router/state.ts", "server/navigation.ts"];
      if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`unexpected conflict paths: ${JSON.stringify(paths)}`);
      await page.locator(".conflict-alert").getByRole("button", { name: "Copy fix prompt", exact: true }).waitFor();
      await page.locator(".conflict-alert").getByRole("button", { name: "Fix with agent", exact: true }).waitFor();
      const attentionLabels = await page.locator(".attention-label").allTextContents();
      if (attentionLabels.length !== 2 || attentionLabels.some((label) => label !== "Action required")) {
        throw new Error(`status cards do not clearly identify required action: ${JSON.stringify(attentionLabels)}`);
      }
      const surfaces = await page.locator(".conflict-alert").evaluate((alert) => {
        const resolvedColor = (value) => {
          const probe = document.createElement("span");
          probe.style.color = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return {
          alert: getComputedStyle(alert).backgroundColor,
          panel: resolvedColor("var(--panel)"),
          action: getComputedStyle(alert.querySelector(".conflict-primary")).backgroundColor,
          accent: resolvedColor("var(--native-accent)"),
          shadow: getComputedStyle(alert).boxShadow,
        };
      });
      if (surfaces.alert !== surfaces.panel) throw new Error(`conflict alert still uses a tinted surface: ${JSON.stringify(surfaces)}`);
      if (surfaces.action !== surfaces.accent) throw new Error(`constructive conflict action is not using the system accent: ${JSON.stringify(surfaces)}`);
      if (surfaces.shadow === "none") throw new Error("conflict alert has no design-system elevation");
      if (surfaces.shadow.includes("inset")) throw new Error(`conflict alert uses an inset status stripe: ${surfaces.shadow}`);
      const alignment = await page.locator(".ci-failure-alert, .conflict-alert").evaluateAll((alerts) => alerts.map((alert) => {
        const card = alert.getBoundingClientRect();
        const title = alert.querySelector("strong").getBoundingClientRect();
        return { x: card.x, width: card.width, titleX: title.x };
      }));
      if (alignment.length !== 2 || alignment.some((item) => Math.abs(item.x - alignment[0].x) > 1 || Math.abs(item.width - alignment[0].width) > 1 || Math.abs(item.titleX - alignment[0].titleX) > 1)) {
        throw new Error(`status cards do not share the same outer and title alignment: ${JSON.stringify(alignment)}`);
      }
    },
  },
  {
    ...detail("detail-unstable", 104, "UNSTABLE PR with failing non-required checks."),
    ready: ".ci-failure-alert",
    verify: async (page) => {
      await page.locator(".ci-failure-list").getByText("CI / preview deploy", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Open logs ↗", exact: true }).waitFor();
      await page.getByRole("button", { name: "Copy fix prompt", exact: true }).waitFor();
      await page.getByRole("button", { name: "Fix with agent", exact: true }).waitFor();
      const surfaces = await page.locator(".ci-failure-alert").evaluate((alert) => {
        const resolvedColor = (value) => {
          const probe = document.createElement("span");
          probe.style.color = value;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return {
          alert: getComputedStyle(alert).backgroundColor,
          panel: resolvedColor("var(--panel)"),
          action: getComputedStyle(alert.querySelector(".ci-agent-button")).backgroundColor,
          accent: resolvedColor("var(--native-accent)"),
          shadow: getComputedStyle(alert).boxShadow,
        };
      });
      if (surfaces.alert !== surfaces.panel) throw new Error(`failure alert still uses a tinted surface: ${JSON.stringify(surfaces)}`);
      if (surfaces.action !== surfaces.accent) throw new Error(`constructive failure action is not using the system accent: ${JSON.stringify(surfaces)}`);
      if (surfaces.shadow === "none") throw new Error("failure alert has no design-system elevation");
      if (surfaces.shadow.includes("inset")) throw new Error(`failure alert still uses an inset side stripe: ${surfaces.shadow}`);
    },
  },
  detail("detail-draft", 105, "Draft PR conversation."),
  detail("detail-merged", 106, "Merged PR conversation."),
  detail("detail-closed", 111, "Closed PR conversation from the archived fixture set."),
  detail("detail-no-checks", 113, "Open PR with no checks, no description, and no changed files."),
  detail("detail-checks-pending", 114, "PR with queued and in-progress required checks."),
  {
    name: "detail-files",
    route: `#/pr/${REPO}/101/files`,
    description: "Files tab with an ordinary three-file diff and inline threads.",
    ready: ".files-layout .diff",
    verify: async (page) => {
      const file = page.locator(".diff .file").first();
      const expanded = await file.evaluate((node) => ({
        border: getComputedStyle(node).borderTopWidth,
        firstHunkBorder: getComputedStyle(node.querySelector(".hunk-head")).borderTopWidth,
        shadow: getComputedStyle(node).boxShadow,
      }));
      if (expanded.border !== "0px") throw new Error(`diff card has a border in addition to its elevation: ${JSON.stringify(expanded)}`);
      if (expanded.firstHunkBorder !== "0px") throw new Error(`first hunk duplicates the header divider: ${JSON.stringify(expanded)}`);
      if (expanded.shadow === "none") throw new Error("diff card lost its design-system elevation");

      await file.locator(".file-head").click();
      await file.evaluate((node) => {
        if (!node.classList.contains("collapsed")) throw new Error("file did not enter its collapsed state");
        const divider = getComputedStyle(node.querySelector(".file-head-row")).borderBottomWidth;
        if (divider !== "0px") throw new Error(`collapsed header keeps a duplicate bottom divider: ${divider}`);
      });
      await file.locator(".file-head").click();
      await file.locator(".hunks").waitFor();
    },
  },
  {
    name: "detail-range-picker",
    route: `#/pr/${REPO}/101/files`,
    description: "Changed-range picker opened over a multi-commit pull request.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      await page.locator(".rp-trigger").click();
      await page.locator(".rp-popover").waitFor();
    },
    verify: async (page) => page.getByText("Drag, or press Space + J/K, to select a range", { exact: true }).waitFor(),
  },
  {
    name: "detail-inline-comment-compose",
    route: `#/pr/${REPO}/101/files`,
    description: "Inline diff comment composer with a deterministic draft.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      await page.locator(".add-comment:not([disabled])").first().evaluate((button) => button.click());
      const composer = page.locator(".inline-compose textarea");
      await composer.fill("This boundary should preserve the previous scheduling mode.");
      await composer.scrollIntoViewIfNeeded();
    },
    verify: async (page) => page.locator(".inline-compose").getByRole("button", { name: "Comment", exact: true }).waitFor(),
  },
  {
    name: "detail-file-editing",
    route: `#/pr/${REPO}/101/files`,
    description: "Full-file editor with a legible deterministic edit in progress.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      const file = page.locator(".diff .file").filter({ hasText: "src/flight.ts" });
      await file.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "Edit src/flight.ts" });
      await editor.fill("export function launch(mode = \"automatic\") {\n  return `launch:${mode}`;\n}\n\nexport const fixtureNumber = 101;\n");
      await file.locator(".file-editor").scrollIntoViewIfNeeded();
    },
    verify: async (page) => page.getByRole("button", { name: "Review changes", exact: true }).waitFor(),
  },
  {
    name: "detail-file-edit-review",
    route: `#/pr/${REPO}/101/files`,
    description: "Modified editor automatically enters review with a diff, commit message, and explicit ignore action.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      const file = page.locator(".diff .file").filter({ hasText: "src/flight.ts" });
      const edit = file.getByRole("button", { name: "Edit", exact: true });
      await edit.click();
      let editor = page.getByRole("textbox", { name: "Edit src/flight.ts" });
      await editor.fill("export function launch(mode = \"automatic\") {\n  return `launch:${mode}`;\n}\n\nexport const fixtureNumber = 101;\n");
      await editor.blur();
      await page.getByRole("button", { name: "Ignore changes", exact: true }).click();
      await edit.click();
      editor = page.getByRole("textbox", { name: "Edit src/flight.ts" });
      await editor.fill("export function launch(mode = \"automatic\") {\n  return `launch:${mode}`;\n}\n\nexport const fixtureNumber = 101;\n");
      await editor.blur();
      await page.getByLabel("Commit message").fill("Make launch mode explicit");
      await file.locator(".file-edit-review").scrollIntoViewIfNeeded();
    },
    verify: async (page) => {
      await page.locator(".file-edit-preview").getByText("+  return `launch:${mode}`;", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Commit to PR", exact: true }).waitFor();
      await page.getByRole("button", { name: "Ignore changes", exact: true }).waitFor();
    },
  },
  {
    name: "detail-files-large-diff",
    route: `#/pr/${REPO}/107/files`,
    description: "Files tab with 50+ files, binary and renamed files, and a giant single-file diff.",
    ready: ".files-layout .diff",
    interact: async (page) => {
      await page.locator(".tree .file").filter({ hasText: "client.ts" }).click();
      const client = page.locator(".diff .file").filter({ hasText: "src/generated/client.ts" });
      const header = client.locator(".file-head-row");
      await header.getByText("+701", { exact: true }).waitFor();
      await client.locator(".hunks").waitFor();
      await header.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "detail-files-empty",
    route: `#/pr/${REPO}/113/files`,
    description: "Zero-file PR showing the empty diff state.",
    ready: ".files-layout .diff-status",
    verify: async (page) => page.getByText("No changes in this range.", { exact: true }).waitFor(),
  },
  {
    name: "detail-files-error",
    route: `#/pr/${REPO}/101/files`,
    description: "Files tab after its diff request fails, with retry visible.",
    beforeGoto: async (page) => page.route((url) => url.pathname === "/api/pr/fixture/cockpit/101/diff", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "fixture diff failure" })),
    ready: ".files-layout .diff-status",
    verify: async (page) => {
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      const status = await page.locator(".diff-status").innerText();
      if (!status.includes("Couldn’t load this diff.")) throw new Error(`unexpected diff error state: ${status}`);
    },
  },
  {
    name: "detail-file-history",
    route: `#/pr/${REPO}/101/files`,
    description: "Base-branch history and diff for a selected file.",
    ready: ".files-layout .tree .file",
    interact: async (page) => {
      await page.locator(".tree .file").first().click();
      await page.keyboard.press("h");
      await page.locator(".fh-view .fh-row").first().waitFor();
      await page.locator(".fh-detail").waitFor();
    },
  },
  {
    name: "detail-agents",
    route: `#/pr/${REPO}/110/agents`,
    description: "Agents tab with completed, failed, killed, and running fixture runs.",
    ready: ".agents-layout .run-row",
    interact: async (page) => {
      await page.locator(".run-row").first().click();
      await page.locator(".run-detail-head").waitFor();
    },
  },
  {
    name: "detail-agent-run-detail",
    route: `#/pr/${REPO}/110/agents`,
    description: "Successful agent run detail with structured turns expanded.",
    ready: ".agents-layout .run-row",
    interact: async (page) => {
      await page.locator(".run-row").nth(1).click();
      await page.locator(".run-detail-head").waitFor();
      const turn = page.locator(".turn-toggle").first();
      if (await turn.count()) await turn.click();
    },
    verify: async (page) => page.locator(".run-turns").waitFor(),
  },
  {
    ...detail("detail-agent-prompt", 101, "Agent prompt dialog with a deterministic task instruction."),
    interact: async (page) => {
      await page.keyboard.press("p");
      await page.getByPlaceholder("e.g. remove the comments you just added").fill("make it render images at 1080p and then merge it");
    },
    verify: async (page) => page.getByText("prompt an agent on #101", { exact: true }).waitFor(),
  },
  {
    name: "detail-agents-empty",
    route: `#/pr/${REPO}/101/agents`,
    description: "Agents tab before any runs exist.",
    ready: ".agents-layout",
    verify: async (page) => page.getByText("No agent runs yet", { exact: true }).waitFor(),
  },
  {
    ...detail("detail-long-markdown", 108, "Huge Markdown description with a table, code block, and embedded image."),
    ready: ".body-card .md",
  },
  {
    ...detail("detail-failed-mutation", 109, "Failed mutation with retry and discard actions."),
    verify: async (page) => {
      const failed = page.getByText("FAILED", { exact: true }).first();
      await failed.waitFor();
      await page.getByRole("button", { name: "Retry", exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Discard", exact: true }).first().waitFor();
      await failed.scrollIntoViewIfNeeded();
    },
  },
  {
    ...detail("detail-pending-mutation", 114, "Pending comment mutation rendered alongside queued CI."),
    verify: async (page) => {
      const pending = page.getByText("POSTING…", { exact: true }).first();
      await pending.waitFor();
      await pending.scrollIntoViewIfNeeded();
    },
  },
  settings("settings", "General settings and workspace configuration.", "general"),
  {
    ...settings("settings-scrolled", "Sticky settings header after the form has scrolled beneath it.", "general"),
    interact: async (page) => {
      await page.locator(".page").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
    },
    verify: async (page) => {
      const scrollTop = await page.locator(".page").evaluate((node) => node.scrollTop);
      if (scrollTop <= 0) throw new Error(`settings page did not scroll: ${scrollTop}`);
      const positions = await page.locator(".page").evaluate((node) => ({
        pageTop: node.getBoundingClientRect().top,
        headTop: node.querySelector(".head")?.getBoundingClientRect().top,
      }));
      if (positions.headTop == null || Math.abs(positions.headTop - positions.pageTop) > 1) {
        throw new Error(`sticky settings header left a ${positions.headTop - positions.pageTop}px gap`);
      }
      const headerSurface = await page.locator(".head").evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backdropFilter: style.backdropFilter,
        };
      });
      if (headerSurface.backgroundImage !== "none" || headerSurface.backdropFilter !== "none") {
        throw new Error(`sticky settings header is translucent: ${JSON.stringify(headerSurface)}`);
      }
      const alpha = Number(headerSurface.backgroundColor.match(/[\d.]+/g)?.[3] ?? 1);
      if (alpha < 1) throw new Error(`sticky settings header background is not opaque: ${headerSurface.backgroundColor}`);
      await page.locator('.app-nav a[href="#/settings/general"][aria-current="page"]').waitFor();
    },
  },
  settings("settings-keybinds", "Global and in-app keyboard shortcuts.", "keybinds"),
  settings("settings-agents", "Built-in and custom agent configuration.", "automerge"),
  settings("settings-diff-tests", "Diff rendering and test-file preferences.", "tests"),
  {
    name: "palette",
    route: "#/",
    description: "PR jump palette populated from the fixture inbox and index.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.keyboard.press("Meta+k");
      await page.locator(".palette .palette-result").first().waitFor();
    },
  },
  {
    name: "palette-standalone",
    route: "#/palette",
    description: "Standalone PR search palette opened outside the dashboard shell.",
    ready: ".palette.standalone .palette-result",
  },
  {
    name: "cheatsheet",
    route: "#/",
    description: "Keyboard shortcuts overlay.",
    ready: ".inbox-layout",
    interact: async (page) => {
      await page.keyboard.press("?");
      await page.locator(".sheet").waitFor();
    },
  },
  {
    name: "onboarding",
    route: "#/",
    description: "First-run repository picker.",
    prepare: clearConfiguredRepos,
    beforeGoto: onboardingFixtureRoutes,
    ready: ".onb-page",
    interact: async (page) => advanceOnboarding(page, 2),
    verify: async (page) => page.getByText("Step 2 of 4", { exact: true }).waitFor(),
  },
  onboardingStep("onboarding-step-1-connect", 1, "Successful GitHub authentication step."),
  onboardingStep("onboarding-step-2-repositories", 2, "Successful repository selection step."),
  onboardingStep("onboarding-step-3-live-updates", 3, "Hosted GitHub App installation guidance."),
  onboardingStep("onboarding-step-4-ready", 4, "Successful initial inbox sync step."),
  {
    name: "quota-exhausted",
    route: "#/",
    description: "Both GitHub quota pools empty, with the degradation banner above the inbox.",
    beforeGoto: (page) => quotaRoutes(page, { graphql: 0, rest: 0 }),
    ready: ".quota-banner",
    verify: async (page) => page.getByText("GitHub GraphQL and REST quota exhausted", { exact: true }).waitFor(),
  },
  {
    name: "quota-reserved",
    route: "#/",
    description: "GraphQL below the polling reserve, so only background refresh is degraded.",
    beforeGoto: (page) => quotaRoutes(page, { graphql: 120, rest: 4800 }),
    ready: ".quota-banner",
    verify: async (page) => page.getByText("GitHub GraphQL quota nearly exhausted", { exact: true }).waitFor(),
  },
  {
    ...detail("detail-merge-quota-blocked", 101, "Merge refused while the REST quota is empty, offering GitHub's own merge button."),
    beforeGoto: (page) => quotaRoutes(page, { graphql: 4800, rest: 0 }),
    interact: async (page) => {
      await page.getByRole("button", { name: /^merge \(/ }).click();
      await page.locator(".qm").waitFor();
    },
    verify: async (page) => page.getByRole("button", { name: "Merge on GitHub", exact: true }).waitFor(),
  },
  {
    name: "detail-not-found",
    route: `#/pr/${REPO}/999`,
    description: "Stable detail error for a PR absent from the fixture set.",
    ready: ".page .load",
    verify: async (page) => {
      const text = await page.locator(".page .load").innerText();
      if (text === "Loading…") throw new Error("detail error never replaced its loading state");
    },
  },
];

function detail(name, number, description, repo = REPO) {
  return { name, route: `#/pr/${repo}/${number}`, description, ready: ".page .detail" };
}

function quotaRoutes(page, { graphql, rest }) {
  const resetAt = new Date(FIXED_NOW + 41 * 60_000).toISOString();
  const pool = (remaining) => ({ limit: 5000, used: 5000 - remaining, remaining, resetAt });
  const body = JSON.stringify({ graphql: pool(graphql), rest: pool(rest), fetchedAt: new Date(FIXED_NOW).toISOString() });
  return page.route("**/api/quota", (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
}

function settings(name, description, section) {
  return {
    name,
    route: `#/settings/${section}`,
    description,
    sidebar: true,
    ready: ".settings-panel",
    verify: async (page) => {
      await page.locator(`.app-nav a[href="#/settings/${section}"][aria-current="page"]`).waitFor();
    },
  };
}
function onboardingStep(name, step, description) {
  return {
    name,
    route: "#/",
    description,
    prepare: clearConfiguredRepos,
    beforeGoto: (page) => onboardingFixtureRoutes(page, { relayCovered: step < 3 }),
    ready: ".onb-page",
    interact: step === 1 ? undefined : async (page) => advanceOnboarding(page, step),
    verify: async (page) => {
      await page.getByText(`Step ${step} of 4`, { exact: true }).waitFor();
      if (step === 1) await page.getByText("Connected as", { exact: false }).waitFor();
      if (step === 3) {
        await page.getByRole("button", { name: "Install GitHub App", exact: true }).waitFor();
        await page.getByRole("button", { name: "Use polling instead", exact: true }).waitFor();
        await page.getByRole("link", { name: "Source", exact: true }).waitFor();
        await page.getByRole("link", { name: "Self-hosting guide", exact: true }).waitFor();
      }
      if (step === 4) await page.getByText("Your inbox is ready.", { exact: true }).waitFor();
    },
  };
}

async function onboardingFixtureRoutes(page, { relayCovered = true } = {}) {
  await page.route("**/api/auth/status", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, login: "theolundqvist" }),
  }));
  await page.route("**/api/onboarding/repos", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      { nameWithOwner: REPO, isPrivate: false, pushedAt: new Date(FIXED_NOW - 3_600_000).toISOString() },
      { nameWithOwner: "fixture/relay", isPrivate: false, pushedAt: new Date(FIXED_NOW - 86_400_000).toISOString() },
    ]),
  }));
  await page.route("**/api/relay/coverage**", (route) => {
    const repos = new URL(route.request().url()).searchParams.get("repos")?.split(",") ?? [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ repos: Object.fromEntries(repos.map((repo) => [repo, relayCovered])), installUrl: "https://github.com/apps/pr-cockpit" }),
    });
  });
  await page.route("**/api/refresh", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
}

async function advanceOnboarding(page, targetStep) {
  await page.getByText("Connected as", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".repo-list").waitFor();
  if (targetStep === 2) return;
  await page.locator(".repo-row input").first().check();
  await page.getByRole("button", { name: "Continue with 1", exact: true }).click();
  if (targetStep === 3) return;
  await page.getByRole("button", { name: "Use polling instead", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Your inbox is ready.", { exact: true }).waitFor();
}

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, filter: "", sizes: DEFAULT_SIZES, themes: ["light", "dark"] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--out") options.out = value;
    else if (arg === "--filter") options.filter = value;
    else if (arg === "--sizes") options.sizes = value.split(",").map((size) => size.trim()).filter(Boolean);
    else if (arg === "--theme") {
      if (!new Set(["light", "dark", "both"]).has(value)) throw new Error("--theme must be light, dark, or both");
      options.themes = value === "both" ? ["light", "dark"] : [value];
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.sizes.length) throw new Error("--sizes must include at least one WIDTHxHEIGHT value");
  options.viewports = options.sizes.map((label) => {
    const match = label.match(/^(\d+)x(\d+)$/);
    if (!match) throw new Error(`invalid size: ${label}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 320 || height < 240) throw new Error(`size is too small: ${label}`);
    return { label, width, height };
  });
  options.out = resolve(ROOT, options.out);
  return options;
}

function usage() {
  console.log(`Usage: bun scripts/shoot-views.mjs [options]

  --out DIR                 Output directory (default: ${DEFAULT_OUT})
  --filter substring        Shoot scenario names containing substring
  --sizes WxH,WxH           Viewports (default: ${DEFAULT_SIZES.join(",")})
  --theme light|dark|both   Color theme (default: both)`);
}

async function validateStatic() {
  const indexPath = join(ROOT, "static", "index.html");
  const missing = `Static UI is missing or stale. Run \`cd ui && bun run build\` before the screenshot harness.`;
  try {
    await access(indexPath);
    const html = await readFile(indexPath, "utf8");
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((path) => path.startsWith("/assets/"));
    if (!assets.length) throw new Error(missing);
    await Promise.all(assets.map((path) => access(join(ROOT, "static", path))));
    if (!(await readdir(join(ROOT, "static", "assets"))).length) throw new Error(missing);
  } catch (error) {
    if (error.message === missing) throw error;
    throw new Error(missing, { cause: error });
  }
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function collect(stream, lines) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    lines.push(...decoder.decode(value, { stream: true }).split("\n").filter(Boolean));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  }
}

async function waitForServer(process, baseURL, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const exited = await Promise.race([process.exited.then((code) => ({ code })), delay(75).then(() => null)]);
    if (exited) throw new Error(`server exited with code ${exited.code}\n${logs.join("\n")}`);
    try {
      const response = await fetch(`${baseURL}/api/settings`);
      if (response.ok) return;
    } catch {}
  }
  throw new Error(`server did not become ready within 15s\n${logs.join("\n")}`);
}

async function stopServer(process) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const stopped = await Promise.race([process.exited.then(() => true), delay(2_000).then(() => false)]);
  if (!stopped) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function setArchived(baseURL, rows, archived) {
  const results = await Promise.allSettled(rows.map((row) => requestJson(`${baseURL}/api/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: row.repo, number: row.number, archived }),
  })));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), `could not ${archived ? "archive" : "restore"} ${failures.length} PRs`);
}

async function archiveActivePrs({ baseURL }) {
  const { prs } = await requestJson(`${baseURL}/api/inbox`);
  await setArchived(baseURL, prs, true);
  return () => setArchived(baseURL, prs, false);
}

async function clearConfiguredRepos({ baseURL }) {
  const settings = await requestJson(`${baseURL}/api/settings`);
  await requestJson(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repos: "" }),
  });
  return () => requestJson(`${baseURL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repos: settings.repos, default_repo: settings.default_repo }),
  });
}

async function settle(page, theme) {
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.complete
      ? undefined
      : new Promise((done) => {
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
        })));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

function inspectPng(buffer, expectedWidth, expectedHeight) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("screenshot is not a PNG");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (width !== expectedWidth || height !== expectedHeight) throw new Error(`PNG is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`);
  if (bitDepth !== 8 || !new Set([2, 6]).has(colorType) || interlace !== 0) throw new Error(`unsupported PNG format: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  let previous = Buffer.alloc(stride);
  let position = 0;
  let darkest = 255;
  let lightest = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position++];
    const row = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[position++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 0) row[x] = value;
      else if (filter === 1) row[x] = value + left;
      else if (filter === 2) row[x] = value + up;
      else if (filter === 3) row[x] = value + Math.floor((left + up) / 2);
      else if (filter === 4) row[x] = value + paeth(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter: ${filter}`);
    }
    for (let x = 0; x < stride; x += channels * Math.max(1, Math.floor(width / 200))) {
      const lightness = Math.round((row[x] + row[x + 1] + row[x + 2]) / 3);
      darkest = Math.min(darkest, lightness);
      lightest = Math.max(lightest, lightness);
    }
    previous = row;
  }
  if (lightest - darkest < 8) throw new Error(`PNG appears blank: sampled pixel range is ${darkest}–${lightest}`);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function clearManifestScreenshots(out) {
  const manifestPath = join(out, "manifest.json");
  let previous;
  try {
    previous = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    await rm(manifestPath, { force: true });
    return;
  }

  const realOut = await realpath(out);
  const entries = previous && typeof previous === "object" ? Object.values(previous) : [];
  const files = new Set(entries.flatMap((entry) => Array.isArray(entry?.files) ? entry.files : []));
  for (const file of files) {
    if (typeof file !== "string" || isAbsolute(file) || normalize(file) !== file || !file.endsWith(".png")) continue;
    const target = resolve(out, file);
    let realTarget;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const fromOut = relative(realOut, realTarget);
    if (!fromOut || fromOut === ".." || fromOut.startsWith(`..${sep}`) || isAbsolute(fromOut)) continue;
    await rm(target);
  }
  await rm(manifestPath, { force: true });
}
async function pngFiles(out, directory = out) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await pngFiles(out, path));
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(relative(out, path).split(sep).join("/"));
  }
  return files.sort();
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  await validateStatic();
  const selected = scenarios.filter((scenario) => scenario.name.includes(options.filter));
  if (!selected.length) throw new Error(`no scenarios match --filter ${JSON.stringify(options.filter)}`);
  await clearManifestScreenshots(options.out);

  const dataDir = await mkdtemp(join(tmpdir(), "pr-cockpit-shots-"));
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const logs = [];
  const server = Bun.spawn([process.execPath, "server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_PORT: String(port),
      COCKPIT_MOCK: "1",
      COCKPIT_REPO_ROOTS: "",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const outputDone = Promise.allSettled([collect(server.stdout, logs), collect(server.stderr, logs)]);
  let browser;
  const failures = [];
  const manifest = {};
  const summary = selected.map((scenario) => ({ scenario: scenario.name, route: scenario.route, shots: 0, localAvatars: 0, status: "ok" }));

  try {
    await waitForServer(server, baseURL, logs);
    await requestJson(`${baseURL}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hide_sidebar: true }),
    });
    browser = await chromium.launch({ headless: true });
    for (const viewport of options.viewports) {
      for (const theme of options.themes) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await context.addInitScript((now) => {
          Date.now = () => now;
        }, FIXED_NOW);
        const externalRequests = [];
        const localAvatarRequests = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          const avatarLogin = mockAvatarLogin(url);
          if (url.protocol === "data:" || url.protocol === "blob:" || url.origin === baseURL) await route.continue();
          else if (avatarLogin) {
            localAvatarRequests.push(url.href);
            await route.fulfill({ status: 200, contentType: "image/svg+xml", body: mockAvatarSvg(avatarLogin) });
          }
          else {
            externalRequests.push(url.href);
            await route.abort("blockedbyclient");
          }
        });

        for (let index = 0; index < selected.length; index++) {
          const scenario = selected[index];
          const row = summary[index];
          externalRequests.length = 0;
          localAvatarRequests.length = 0;
          const page = await context.newPage();
          const pageErrors = [];
          page.on("pageerror", (error) => pageErrors.push(error));
          let cleanup;
          try {
            cleanup = await scenario.prepare?.({ baseURL });
            await scenario.beforeGoto?.(page, { baseURL });
            await page.goto(`${baseURL}/${scenario.route}`, { waitUntil: "domcontentloaded" });
            await page.locator(scenario.ready).first().waitFor({ state: "visible", timeout: 15_000 });
            await scenario.interact?.(page);
            await scenario.verify?.(page);
            const sidebar = page.locator(".app-sidebar");
            if (await sidebar.count() && !scenario.sidebar) await sidebar.waitFor({ state: "hidden" });
            await settle(page, theme);
            if (externalRequests.length) throw new Error(`external network request blocked: ${externalRequests.join(", ")}`);
            if (pageErrors.length) throw new AggregateError(pageErrors, "uncaught browser error");

            const relativeFile = `${viewport.label}/${theme}/${scenario.name}.png`;
            const file = join(options.out, relativeFile);
            await mkdir(resolve(file, ".."), { recursive: true });
            const png = await page.screenshot({ type: "png", animations: "disabled" });
            inspectPng(png, viewport.width, viewport.height);
            await writeFile(file, png);
            row.shots++;
            row.localAvatars += localAvatarRequests.length;
            manifest[scenario.name] ??= { route: scenario.route, description: scenario.description, localAvatarHrefs: [], files: [] };
            manifest[scenario.name].localAvatarHrefs = [...new Set([...manifest[scenario.name].localAvatarHrefs, ...localAvatarRequests])];
            manifest[scenario.name].files.push(relativeFile);
          } catch (error) {
            row.status = "failed";
            failures.push({ scenario: scenario.name, size: viewport.label, theme, error });
          } finally {
            try {
              await cleanup?.();
            } catch (error) {
              row.status = "failed";
              failures.push({ scenario: scenario.name, size: viewport.label, theme, error: new Error(`cleanup failed: ${error.message}`, { cause: error }) });
            }
            await page.close();
          }
        }
        await context.close();
      }
    }

    const expected = options.viewports.length * options.themes.length;
    for (const row of summary) {
      if (row.shots !== expected) row.status = "failed";
    }
    await mkdir(options.out, { recursive: true });
    await writeFile(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (Object.keys(manifest).length !== selected.length && !failures.length) throw new Error("manifest scenario count does not match the selected catalog");
    console.table(summary);
    if (failures.length) {
      for (const failure of failures) console.error(`\n${failure.scenario} ${failure.size} ${failure.theme}:\n${failure.error.stack ?? failure.error}`);
      throw new Error(`${failures.length} screenshot variant${failures.length === 1 ? "" : "s"} failed`);
    }
    const manifestFiles = Object.values(manifest).flatMap((entry) => entry.files).sort();
    const outputFiles = await pngFiles(options.out);
    if (JSON.stringify(outputFiles) !== JSON.stringify(manifestFiles)) {
      throw new Error(`manifest files do not match output files: manifest=${manifestFiles.length}, output=${outputFiles.length}`);
    }
    console.log(`\nWrote ${summary.reduce((total, row) => total + row.shots, 0)} screenshots and manifest.json to ${options.out}`);
  } finally {
    await browser?.close();
    await stopServer(server);
    await outputDone;
    await rm(dataDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
