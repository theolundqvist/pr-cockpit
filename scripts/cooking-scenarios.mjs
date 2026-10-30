// Exercise the real settings and list UI against the screenshot harness's isolated backend.
export function cookingScenarios() {
  return ["before", "expanded", "hidden", "history"].map((mode) => ({
    name: `inbox-cooking-${mode}`,
    route: mode === "before" ? "#/" : "#/settings/general",
    ready: mode === "before" ? ".queue-group" : ".settings-panel",
    sidebar: true,
    prepare: async ({ baseURL }) => {
      const previous = await fetch(`${baseURL}/api/settings`).then((r) => r.json());
      const update = (enabled) => fetch(`${baseURL}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cooking_section_enabled: enabled }),
      });
      await update(false);
      return () => update(previous.cooking_section_enabled);
    },
    beforeGoto: async (page) => {
      await page.route("**/api/kitchen-history?*", (route) => route.fulfill({ json: { hasMore: false, prs: [
        { repo: "fixture/cockpit", number: 510, title: "Improve workspace search", author: "octocat", state: "MERGED", terminalAt: "2026-07-15T09:30:00Z" },
        { repo: "fixture/cockpit", number: 509, title: "Fix export ordering", author: "octocat", state: "MERGED", terminalAt: "2026-07-14T09:30:00Z" },
      ] } }));
      await page.addInitScript(() => {
        if (!sessionStorage.getItem("cooking-fixture")) {
          localStorage.removeItem("cockpit:cooking-hidden");
          localStorage.setItem("cockpit:kitchen-seen", JSON.stringify({ "fixture/cockpit#509:2026-07-14T09:30:00Z": true }));
          sessionStorage.setItem("cooking-fixture", "1");
        }
      });
      await page.route("**/api/inbox", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const seed = data.prs[0];
        data.prs = [
          [501, "Add workspace search", "kitchen: oven"],
          [502, "Improve keyboard navigation", "kitchen: chef"],
          [503, "Update export layout", "kitchen: prepped"],
          [504, "Fix notification preferences", "kitchen: serving"],
          [505, "Repair upload validation", "kitchen: burnt"],
          [506, "Explore navigation layout", null],
          [507, "Adjust settings spacing", null],
          [508, "Retry failed merge", "kitchen: oven"],
        ].map(([number, title, label]) => ({ ...seed, number, title,
          baseRef: "main", headRef: `example-${number}`, rank: number === 501 ? 1 : null,
          kitchenEnteredAt: number === 503 ? null : "2026-07-15T08:18:00Z",
          approvedForSafeMerge: false, mergeFailed: number === 508,
          isDraft: number === 506, ciStatus: number === 507 ? "PENDING" : "SUCCESS",
          labels: label ? [{ name: "order", color: "d99a39" }, { name: label, color: "d99a39" }] : [],
        }));
        await route.fulfill({ response, json: data });
      });
    },
    interact: async (page) => {
      if (mode === "before") return;
      await page.getByLabel("Separate PRs that are cooking").check();
      await page.getByRole("button", { name: /^Save changes/ }).click();
      await page.getByText("Changes saved.", { exact: true }).waitFor();
      await page.reload();
      if (!await page.getByLabel("Separate PRs that are cooking").isChecked()) throw new Error("Cooking setting did not persist");
      await page.evaluate(() => { location.hash = "#/"; });
      const toggle = page.locator(".cooking-toggle");
      await toggle.waitFor();
      const numbers = await page.locator("#cooking-prs .num").allTextContents();
      if (numbers.join() !== "#504,#501,#502,#503") throw new Error(`Incorrect stage order: ${numbers}`);
      await toggle.click();
      if (await page.locator("#cooking-prs .row").count()) throw new Error("Hidden cooking rows remain mounted");
      for (const number of [505, 506, 507, 508]) await page.locator(`.queue-list .num`).getByText(`#${number}`, { exact: true }).waitFor();
      await toggle.evaluate((node) => node.blur());
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("j");
        const selected = await page.locator(".queue-list .row.selected .num").textContent();
        if (["#501", "#502", "#503", "#504"].includes(selected)) throw new Error("Keyboard selected a hidden PR");
      }
      await page.reload();
      await toggle.waitFor();
      if (await toggle.getAttribute("aria-expanded") !== "false") throw new Error("Hidden state did not survive reload");
      if (mode === "expanded") await toggle.click();
      if (mode === "history") {
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await page.getByRole("dialog", { name: "Notifications" }).waitFor();
      }
    },
    verify: async (page) => {
      if (mode === "history") {
        const dialog = page.getByRole("dialog", { name: "Notifications" });
        const authors = await dialog.locator(".notification-author").allTextContents();
        if (authors.length !== 2 || authors.some((author) => author !== "Author @octocat")) throw new Error(`Missing notification authors: ${authors}`);
        const bell = page.getByRole("button", { name: /^Notifications/ });
        const badge = await page.locator(".notification-count").boundingBox();
        if (Math.abs(badge.width - badge.height) > 1) throw new Error("Single-digit count is not circular");
        // The native invoker must close on a second click, even during a transition.
        await page.emulateMedia({ reducedMotion: "no-preference" });
        for (let i = 0; i < 3; i++) {
          await bell.click();
          await page.waitForFunction(() => !document.querySelector(".notifications").matches(":popover-open"));
          await bell.click();
          await page.waitForFunction(() => document.querySelector(".notifications").matches(":popover-open"));
        }
        const duration = await dialog.evaluate((node) => getComputedStyle(node).transitionDuration);
        if (!duration.includes("0.16s")) throw new Error(`Pointer transition is missing: ${duration}`);
        await page.keyboard.press("Escape");
        await bell.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector(".notifications").matches(":popover-open") && document.querySelector(".notifications").dataset.instant === "true");
        if (await dialog.evaluate((node) => getComputedStyle(node).transitionDuration) !== "0s") throw new Error("Keyboard open animates");
        await page.locator(".head-title").click();
        await page.waitForFunction(() => !document.querySelector(".notifications").matches(":popover-open"));
        await page.emulateMedia({ reducedMotion: "reduce" });
        await bell.click();
        const reduced = await dialog.evaluate((node) => ({ duration: getComputedStyle(node).transitionDuration, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches }));
        if (!reduced.reduced || reduced.duration.split(",").some((value) => parseFloat(value) > 0.00001)) throw new Error(`Reduced motion animates: ${JSON.stringify(reduced)}`);

        if (await dialog.locator(".notification-item.unread").count() !== 1) throw new Error("Unread count is wrong");
        await dialog.getByRole("button", { name: /^Mark as unread:/ }).click();
        if (await dialog.locator(".notification-item.unread").count() !== 2) throw new Error("Mark unread failed");
        await dialog.getByRole("button", { name: /^Mark as read:/ }).first().click();
        if (await dialog.locator(".notification-item.unread").count() !== 1) throw new Error("Mark read failed");
        await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
        await dialog.getByRole("button", { name: /^Unread/ }).click();
        await dialog.getByText("You're all caught up.").waitFor();
        await page.keyboard.press("Escape");
        if (await dialog.isVisible()) throw new Error("Escape did not close notifications");
        await page.reload();
        await page.getByRole("button", { name: "Notifications", exact: true }).click();
        await dialog.waitFor();
        if (await dialog.locator(".notification-item.unread").count()) throw new Error("Read state did not persist");
        await dialog.getByRole("button", { name: /^Mark as unread:/ }).first().click();
        if (await dialog.locator(".notification-item.unread").count() !== 1) throw new Error("Cannot mark unread after mark all read");
        await dialog.locator(".notification-link").first().click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("cockpit:kitchen-seen"))["fixture/cockpit#510:2026-07-15T09:30:00Z"] === true);
        await page.evaluate(() => { location.hash = "#/"; });
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await dialog.getByRole("button", { name: "Clear notifications", exact: true }).click();
        await dialog.getByText("No notifications.", { exact: true }).waitFor();
        if (await dialog.locator(".notification-item").count()) throw new Error("Clear left notifications visible");
        await page.reload();
        await page.getByRole("button", { name: "Notifications", exact: true }).click();
        await dialog.getByText("No notifications.", { exact: true }).waitFor();
        // A later completion must still arrive after the saved clear watermark.
        await page.route("**/api/kitchen-history?*", (route) => route.fulfill({ json: { hasMore: false, prs: [
          { repo: "fixture/cockpit", number: 511, title: "A new completion", state: "MERGED", terminalAt: "2026-07-15T10:01:00Z" },
          { repo: "fixture/cockpit", number: 510, title: "Improve workspace search", state: "MERGED", terminalAt: "2026-07-15T09:30:00Z" },
        ] } }));
        await page.reload();
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await dialog.getByText("A new completion", { exact: true }).waitFor();
        if (await dialog.locator(".notification-item").count() !== 1) throw new Error("Cleared history returned with a new completion");
        await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
        await page.reload();
        await page.getByRole("button", { name: /^Notifications/ }).click();
        if (await dialog.locator(".notification-item").count() !== 1) throw new Error("Mark all read lost the clear watermark");
        await page.unroute("**/api/kitchen-history?*");
        await page.route("**/api/kitchen-history?*", (route) => route.fulfill({ json: { hasMore: false, prs: [
          { repo: "fixture/cockpit", number: 510, title: "Improve workspace search", author: "octocat", state: "MERGED", terminalAt: "2026-07-15T09:30:00Z" },
          { repo: "fixture/cockpit", number: 509, title: "Fix export ordering", author: "octocat", state: "MERGED", terminalAt: "2026-07-14T09:30:00Z" },
        ] } }));
        // Restore the mixed state for the review screenshot.
        await page.evaluate(() => { localStorage.setItem("cockpit:kitchen-seen", JSON.stringify({ "fixture/cockpit#509:2026-07-14T09:30:00Z": true })); });
        await page.reload();
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await page.getByRole("dialog", { name: "Notifications" }).waitFor();
      }
      if (mode === "expanded") {
        const durations = page.locator("#cooking-prs .kitchen-duration");
        if ((await durations.allTextContents()).join() !== Array(3).fill("1h 42m since ordered").join()) throw new Error("Order elapsed time is wrong");
        if (await page.locator(".queue-list .kitchen-duration").count() !== 3) throw new Error("Non-cooking rows show order time");
        await page.clock.install({ time: new Date("2026-07-15T10:00:00Z") });
        // Remount so the clock owns the interval too.
        await page.locator(".cooking-toggle").click();
        await page.locator(".cooking-toggle").click();
        await page.clock.fastForward(60000);
        if ((await durations.allTextContents()).some((value) => value !== "1h 43m since ordered")) throw new Error("Order clock did not tick");
        // Clock belongs to the shared browser context; restore the fixture time for later scenarios.
        await page.clock.setFixedTime(new Date("2026-07-15T10:00:00Z"));
        await page.clock.fastForward(60000);
        await page.clock.resume();
      }
      if (mode === "before" && await page.locator(".cooking-toggle,.cooking-stage").count()) throw new Error("Cooking UI visible before opt-in");
      const firstGroup = page.locator(".queue-group").first();
      if (mode === "before" && (await firstGroup.locator(".group-label").textContent()).startsWith("Burnt")) throw new Error("Burnt section visible before opt-in");
      if (mode !== "before" && mode !== "history") {
        if (await page.locator(".cooking-toggle .group-count").textContent() !== "4") throw new Error("Cooking count is wrong");
        if ((await firstGroup.locator(".group-label").textContent()).replace(/\s+/g, "") !== "Burnt1") throw new Error("Burnt is not the first section");
        if ((await firstGroup.locator(".num").allTextContents()).join() !== "#505") throw new Error("Burnt rows are wrong");
        if (await page.locator(".queue-list .num").getByText("#505", { exact: true }).count() !== 1) throw new Error("Burnt PR is duplicated");
      }
      if (mode === "expanded") {
        const data = await page.evaluate(() => fetch("/api/inbox").then((response) => response.json()));
        // A cached timestamp must not survive removal of the current order label.
        data.prs.find((pr) => pr.number === 502).labels = [{ name: "kitchen: chef" }];
        await page.route("**/api/pr-details?*", (route) => route.fulfill({ json: {
          rows: Object.fromEntries(data.prs.map((pr) => [`${pr.repo}#${pr.number}`, pr])),
          viewerLogin: data.viewerLogin,
        } }));
        const inboxURL = page.url();
        const keys = data.prs.map((pr) => encodeURIComponent(`${pr.repo}#${pr.number}`)).join(",");
        await page.goto(`${inboxURL.split("#")[0]}#/embed?keys=${keys}&overlay=1`);
        await page.locator(".compact .cooking-stage").first().waitFor();
        const durations = page.locator(".compact .kitchen-duration");
        if (await durations.count() !== 2 || (await durations.allTextContents()).some((value) => !value.endsWith(" since ordered"))) {
          throw new Error("Overlay order clocks must omit unknown timestamps and removed orders");
        }
        await page.goto(inboxURL);
        await page.locator(".cooking-toggle").waitFor();
      }
    },
  }));
}

// An agent's marked-ready handoff leads the queue directly under Burnt when no higher-precedence state applies.
export function readyForReviewScenario() {
  return {
    name: "inbox-ready-for-review",
    route: "#/",
    ready: ".queue-group",
    sidebar: true,
    prepare: async ({ baseURL }) => {
      const previous = await fetch(`${baseURL}/api/settings`).then((r) => r.json());
      const update = (body) => fetch(`${baseURL}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      await update({ cooking_section_enabled: true, safe_merge_approval_enabled: true });
      return () => update({
        cooking_section_enabled: previous.cooking_section_enabled,
        safe_merge_approval_enabled: previous.safe_merge_approval_enabled,
      });
    },
    beforeGoto: async (page) => {
      await page.addInitScript(() => localStorage.removeItem("cockpit:cooking-hidden"));
      await page.route("**/api/inbox", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const seed = data.prs[0];
        // #512 is pinned and approved too; the handoff wins only when no Kitchen state applies.
        data.prs = [
          [501, "Add workspace search", "kitchen: oven"],
          [505, "Repair upload validation", "kitchen: burnt"],
          [508, "Retry failed merge", null],
          [512, "Explain search ranking", null],
          [513, "Approve export cleanup", null],
          [514, "Tidy settings copy", null],
        ].map(([number, title, label]) => ({ ...seed, number, title,
          baseRef: "main", headRef: `example-${number}`, rank: number === 512 ? 1 : null,
          kitchenEnteredAt: "2026-07-15T08:18:00Z", isDraft: false, ciStatus: "SUCCESS",
          approvedForSafeMerge: number === 512 || number === 513, mergeFailed: number === 508,
          readyForReview: number === 512,
          labels: label ? [{ name: label, color: "d99a39" }] : [],
        }));
        await route.fulfill({ response, json: data });
      });
    },
    interact: async (page) => {
      const row = page.locator(".queue-group").nth(1).locator(".row").first();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Clear marked ready/ }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator(".head-title").click();
    },
    verify: async (page) => {
      const sections = await page.locator(".queue-group .group-label").evaluateAll((labels) => labels.map((label) => label.textContent.replace(/\s+/g, " ").trim()));
      const expected = ["Burnt 1", "Marked ready 1", "FAILED TO MERGE 1", "Approved for safe merge 1"];
      if (sections.slice(0, 4).join("|") !== expected.join("|")) throw new Error(`Marked ready is not directly below Burnt: ${sections}`);
      if (!sections.some((section) => section.startsWith("Cooking"))) throw new Error(`Cooking section missing: ${sections}`);
      if ((await page.locator(".queue-group").nth(1).locator(".num").allTextContents()).join() !== "#512") throw new Error("Marked ready rows are wrong");
      if (await page.locator(".queue-list .num").getByText("#512", { exact: true }).count() !== 1) throw new Error("Marked-ready PR is repeated in another section");
    },
  };
}
