import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Exercise the real conversation during a failing draft-review service and live refreshes.
export function commentStabilityScenario() {
  let state;
  async function waitFor(page, predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert(Date.now() < deadline, "pending-review request did not settle");
      await page.waitForTimeout(20);
    }
  }
  return {
    name: "detail-comment-stability",
    route: "#/pr/fixture/cockpit/103",
    ready: ".conversation-thread textarea",
    description: "Published comments and reply drafts survive pending-review retries during scrolling.",
    beforeGoto: async (page, { baseURL }) => {
      state = { socket: null, pending: 0, finished: 0, recover: false, changed: false };
      const current = state;
      const detail = await fetch(`${baseURL}/api/pr/fixture/cockpit/103`).then((r) => r.json());
      const template = detail.reviewThreads.nodes.find((t) => !t.isResolved);
      assert(template, "fixture needs an unresolved thread");
      detail.reviewThreads.nodes = Array.from({ length: 60 }, (_, i) => ({
        ...structuredClone(template), id: `stable-thread-${i}`, path: `src/module-${i}.ts`,
        comments: { nodes: [{ ...structuredClone(template.comments.nodes[0]), id: `stable-comment-${i}`, databaseId: 80000 + i }] },
      }));
      await page.route("**/api/settings", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), pending_reviews_enabled: true } });
      });
      await page.route((url) => url.pathname === "/api/pr/fixture/cockpit/103", (route) => {
        const next = structuredClone(detail);
        next.title += ` refresh ${current.pending}`;
        if (current.changed) next.reviewThreads.nodes[0].comments.nodes[0].body += "\n\nUpdated published comment.";
        return route.fulfill({ json: next });
      });
      await page.route("**/pending-review", async (route) => {
        current.pending++;
        await new Promise((done) => setTimeout(done, 350));
        await route.fulfill(current.recover
          ? { json: { review: null } }
          : { status: 503, json: { error: "Draft review temporarily unavailable" } });
        current.finished++;
      });
      await page.routeWebSocket("**/api/events", (socket) => { current.socket = socket; });
      // Optional scratch build for exact before/after comparisons without deploying it.
      if (process.env.COMMENT_STABILITY_STATIC) {
        await page.route((url) => url.origin === baseURL && !url.pathname.startsWith("/api/"), (route) => {
          const path = new URL(route.request().url()).pathname;
          return route.fulfill({ path: resolve(process.env.COMMENT_STABILITY_STATIC, `.${path === "/" ? "/index.html" : path}`) });
        });
      }
    },
    interact: async (page) => {
      await page.waitForFunction(() => document.querySelectorAll(".conversation-thread").length === 60);
      await page.waitForTimeout(800);
      const reply = page.locator(".conversation-thread textarea").first();
      await reply.fill("Keep this reply while background requests retry.");
      await page.evaluate(() => {
        window.stableCards = [...document.querySelectorAll(".conversation-thread")];
        window.removedCards = 0;
        window.commentBodyChanges = 0;
        window.stableFrames = [];
        let lastFrame;
        const frame = (now) => {
          if (lastFrame) window.stableFrames.push(now - lastFrame);
          lastFrame = now;
          window.stableFrame = requestAnimationFrame(frame);
        };
        window.stableFrame = requestAnimationFrame(frame);
        window.stableObserver = new MutationObserver((records) => {
          for (const record of records) if (record.target.parentElement?.closest(".conversation-thread .md")) window.commentBodyChanges++;
          for (const record of records) for (const node of record.removedNodes) {
            if (node.nodeType === 1 && (node.matches(".conversation-thread") || node.querySelector(".conversation-thread"))) window.removedCards++;
          }
        });
        window.stableObserver.observe(document.querySelector(".detail"), { childList: true, subtree: true });
      });
      for (let i = 0; i < 3; i++) {
        const pending = state.pending;
        state.socket.send(JSON.stringify({ type: "pr", repo: "fixture/cockpit", number: 103 }));
        await waitFor(page, () => state.pending > pending);
        await page.waitForTimeout(50);
        if (i === 0 && process.env.COMMENT_STABILITY_OUT) {
          await mkdir(process.env.COMMENT_STABILITY_OUT, { recursive: true });
          await page.screenshot({ path: resolve(process.env.COMMENT_STABILITY_OUT, "retry.png") });
        }
        assert.equal(await page.locator(".conversation-thread").count(), 60, "retry removed published comment cards");
        await page.mouse.move(650, 700);
        for (let step = 0; step < 12; step++) {
          await page.mouse.wheel(0, i % 2 ? -100 : 100);
          await page.waitForTimeout(16);
        }
        await waitFor(page, () => state.finished >= state.pending);
      }
      assert.equal(await reply.inputValue(), "Keep this reply while background requests retry.");
      assert(await page.evaluate(() => window.stableCards.every((card) => card.isConnected)), "refresh replaced cards");
      assert.equal(await page.evaluate(() => window.removedCards), 0);
      assert.equal(await page.evaluate(() => window.commentBodyChanges), 0, "unchanged comment bodies rerendered during scrolling");
      console.log("comment-stability scroll:", await page.evaluate(() => {
        cancelAnimationFrame(window.stableFrame);
        const frames = window.stableFrames.sort((a, b) => a - b);
        return { frames: frames.length, p95Ms: frames[Math.floor(frames.length * .95)], removedCards: window.removedCards, commentBodyChanges: window.commentBodyChanges };
      }));
      assert(await page.locator(".page").first().evaluate((node) => node.scrollTop > 0), "scroll did not move");
      state.recover = true;
      state.changed = true;
      state.socket.send(JSON.stringify({ type: "pr", repo: "fixture/cockpit", number: 103 }));
      await page.getByText("Updated published comment.", { exact: true }).waitFor();
      assert.equal(await reply.inputValue(), "Keep this reply while background requests retry.");
      assert.equal(await page.evaluate(() => window.removedCards), 0);
      await reply.scrollIntoViewIfNeeded();
      console.log("comment-stability: 60 cards retained through 3 failing refreshes, scrolling, recovery and a published comment edit; reply preserved");
    },
  };
}
