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
          approvedForSafeMerge: false, mergeFailed: number === 508,
          isDraft: number === 506, ciStatus: number === 507 ? "PENDING" : "SUCCESS",
          labels: label ? [{ name: label, color: "d99a39" }] : [],
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
        // Restore the mixed state for the review screenshot.
        await page.evaluate(() => { localStorage.setItem("cockpit:kitchen-seen", JSON.stringify({ "fixture/cockpit#509:2026-07-14T09:30:00Z": true })); });
        await page.reload();
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await page.getByRole("dialog", { name: "Notifications" }).waitFor();
      }
      if (mode === "before" && await page.locator(".cooking-toggle,.cooking-stage").count()) throw new Error("Cooking UI visible before opt-in");
      if (mode !== "before" && mode !== "history" && await page.locator(".cooking-toggle .group-count").textContent() !== "4") throw new Error("Cooking count is wrong");
    },
  }));
}
