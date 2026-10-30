import assert from "node:assert/strict";

export function historyGestureScenario() {
  return {
    name: "detail-history-gesture",
    route: "#/",
    ready: ".inbox .row",
    description: "Trackpad history preview, release, cancellation, and protected scrolling surfaces.",
    beforeGoto: async (page) => {
      await page.addInitScript(() => {
        window.cockpitShell = {
          trackpadNavigationSupported: true,
          onTrackpadNavigationPhase: (callback) => {
            window.gesturePhase = callback;
            return () => { window.gesturePhase = null; };
          },
        };
      });
    },
    interact: async (page) => {
      await page.locator('a.row[href="#/pr/fixture/cockpit/101"]').click();
      await page.locator(".pr-head").waitFor();
      const detail = page.url();
      const phase = (phase) => page.evaluate((phase) => window.gesturePhase(phase), phase);
      const wheel = (dx, dy = 0, selector = ".pr-head", extra = {}) => page.evaluate(({ dx, dy, selector, extra }) => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, ...extra });
        document.querySelector(selector).dispatchEvent(event);
        return event.defaultPrevented;
      }, { dx, dy, selector, extra });
      const unchanged = async () => {
        await page.waitForTimeout(100);
        assert.equal(page.url(), detail);
      };
      await phase("begin");
      const neutralColor = await page.locator('[data-history-gesture="back"]').evaluate((node) => getComputedStyle(node).color);
      assert(await wheel(-75));
      await unchanged(); // Never navigate before release.
      assert.equal(await page.locator('[data-history-gesture="back"]').getAttribute("data-armed"), "true");
      assert.equal(await page.locator('[data-history-gesture="back"]').evaluate((node) => getComputedStyle(node).color), neutralColor);
      await phase("end");
      await page.waitForURL(/#\/$/);
      // Momentum has no active gesture and must not consume another history entry.
      await wheel(-100, 0, ".inbox");
      await phase("begin");
      await wheel(75, 0, ".inbox");
      await phase("end");
      await page.waitForURL(detail);
      await page.locator(".pr-head").waitFor();

      for (const [dx, dy, end, extra] of [[-25, 0, "end", {}], [-80, 0, "cancel", {}], [-5, 90, "end", {}], [-90, 0, "end", { ctrlKey: true }]]) {
        await phase("begin");
        await wheel(dx, dy, ".pr-head", extra);
        await phase(end);
        await unchanged();
      }
      await page.locator("#composer-input").focus();
      await phase("begin");
      assert.equal(await wheel(-90), false);
      await phase("end");
      await unchanged();
      await page.locator("#composer-input").evaluate((node) => node.blur());
      // A wide diff/code region keeps horizontal scrolling even at its boundary.
      await page.evaluate(() => {
        const region = document.createElement("div");
        region.id = "gesture-scroll-fixture";
        region.style.cssText = "width:120px;overflow-x:auto";
        region.innerHTML = '<div style="width:500px">Wide code</div>';
        document.querySelector(".pr-head").append(region);
      });
      await phase("begin");
      assert.equal(await wheel(-90, 0, "#gesture-scroll-fixture"), false);
      await phase("end");
      await unchanged();
      await page.locator("#gesture-scroll-fixture").evaluate((node) => node.remove());
      await page.locator(".page").first().evaluate((node) => { node.scrollTop = 0; });
      await phase("begin");
      await wheel(-75);
      console.log("history gesture: release-only back/forward, momentum, short/cancelled/vertical/modified gestures, inputs and horizontal panes passed");
    },
  };
}
