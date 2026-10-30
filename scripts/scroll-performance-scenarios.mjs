import assert from "node:assert/strict";

export function hiddenInboxScenario() {
  let state;
  return {
    name: "inbox-background-work",
    route: "#/",
    ready: ".inbox-cache .row",
    description: "The retained inbox stays idle behind a PR and catches up when reopened.",
    beforeGoto: async (page) => {
      state = { requests: 0, changed: false, socket: null };
      await page.routeWebSocket("**/api/events", (socket) => { state.socket = socket; });
      await page.route((url) => url.pathname === "/api/inbox", async (route) => {
        state.requests++;
        const response = await route.fetch();
        const body = await response.json();
        if (state.changed) body.prs.find((pr) => pr.number === 103).title = "Updated while reading a discussion";
        await route.fulfill({ response, json: body });
      });
    },
    interact: async (page) => {
      await page.evaluate(() => { location.hash = "#/pr/fixture/cockpit/103"; });
      await page.locator(".conversation-thread textarea").first().waitFor();
      await page.waitForTimeout(300);
      const requests = state.requests;
      state.changed = true;
      for (let i = 0; i < 3; i++) state.socket.send(JSON.stringify({ type: "inbox" }));
      await page.waitForTimeout(400);
      assert.equal(state.requests, requests, "hidden inbox fetched during discussion scrolling");
      await page.evaluate(() => { history.back(); });
      await page.getByText("Updated while reading a discussion", { exact: true }).waitFor();
      assert.equal(state.requests, requests + 1, "return should refresh the retained inbox once");
    },
  };
}

export function scrollPerformanceScenario() {
  return {
    name: "detail-scroll-running-checks",
    route: "#/pr/fixture/cockpit/114",
    ready: ".status-spinner",
    description: "Running checks keep spinning without laying out the conversation on every frame.",
    beforeGoto: async (page) => {
      // Keep the snapshot stable so the measurement isolates scrolling and animation.
      await page.routeWebSocket("**/api/events", () => {});
      await page.route((url) => url.pathname === "/api/pr/fixture/cockpit/114", async (route) => {
        const response = await route.fetch();
        const detail = await response.json();
        detail.comments.nodes = Array.from({ length: 30 }, (_, i) => ({
          id: `scroll-comment-${i}`, databaseId: 90000 + i,
          author: { login: "reviewer" }, createdAt: "2026-07-15T09:00:00Z", reactions: [],
          body: `Review comment ${i + 1}.\n\nThe running checks should not make this discussion expensive to scroll.`,
        }));
        await route.fulfill({ response, json: detail });
      });
    },
    interact: async (page) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.locator(".conversation-tab .event").last().waitFor();
      await page.locator(".status-icon.wait").first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const session = await page.context().newCDPSession(page);
      await session.send("Performance.enable");
      const metrics = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
      try {
        const before = await metrics();
        await page.evaluate(() => new Promise((resolve) => {
          let frames = 60;
          const step = () => --frames ? requestAnimationFrame(step) : resolve();
          requestAnimationFrame(step);
        }));
        const idle = await metrics();
        await page.mouse.move(700, 600);
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, i < 20 ? 110 : -110);
          await page.waitForTimeout(16);
        }
        const scrolled = await metrics();
        const result = { idleLayouts: idle.LayoutCount - before.LayoutCount, scrollLayouts: scrolled.LayoutCount - idle.LayoutCount };
        console.log("running-check scroll layout:", result);
        assert(result.idleLayouts < 5, `running checks continuously lay out the page: ${JSON.stringify(result)}`);
        assert(result.scrollLayouts < 5, `scrolling continuously lays out the page: ${JSON.stringify(result)}`);
        const rotates = () => page.locator(".status-spinner").first().evaluate((node) => {
          const circle = node.querySelector("circle");
          return [node, circle].some((element) => getComputedStyle(element).animationName !== "none");
        });
        assert(await rotates(), "running check stopped animating");
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await rotates(), false, "spinner ignores reduced motion");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator(".status-icon.wait").first().scrollIntoViewIfNeeded();
      } finally {
        await session.detach();
      }
    },
  };
}
