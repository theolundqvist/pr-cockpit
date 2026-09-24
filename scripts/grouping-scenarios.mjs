// Runs against shoot-views' isolated server, including real settings persistence.
export function groupingScenarios() {
  return ["manual", "feature", "type", "settings"].map((mode) => ({
    name: `inbox-grouping-${mode}`,
    route: "#/settings/general",
    sidebar: true, // The narrow layout keeps its bottom navigation visible.
    ready: ".settings-panel",
    prepare: async ({ baseURL }) => {
      const previous = await fetch(`${baseURL}/api/settings`).then((response) => response.json());
      return () => fetch(`${baseURL}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr_grouping: previous.pr_grouping }),
      });
    },
    beforeGoto: async (page) => {
      await page.addInitScript(() => {
        if (!sessionStorage.getItem("grouping-fixture-ready")) {
          localStorage.removeItem("cockpit:pr-groups:v1");
          sessionStorage.setItem("grouping-fixture-ready", "1");
        }
      });
      if (mode === "manual") return;
      await page.route("**/api/inbox", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.prs = data.prs.map((pr, index) => ({ ...pr,
          title: index % 2 ? "fix(billing): Correct subscription total" : "feat(settings): Add workspace preferences",
          baseRef: "main", headRef: `fixture-${pr.number}`,
        }));
        await route.fulfill({ response, json: data });
      });
    },
    interact: async (page) => {
      const select = page.getByLabel("Group review queue by");
      await select.selectOption(mode === "settings" ? "feature" : mode);
      if (mode === "manual" || mode === "settings") {
        await page.getByRole("button", { name: "Add group", exact: true }).click();
        await page.getByLabel("Group 4 name", { exact: true }).fill("Release planning");
        if (mode === "settings") await page.getByLabel("Group 4 keywords", { exact: true }).fill("release, rollout");
      }
      await page.getByRole("button", { name: /^Save changes/ }).click();
      await page.getByText("Changes saved.", { exact: true }).waitFor();
      await page.reload();
      await select.waitFor();
      if (await select.inputValue() !== (mode === "settings" ? "feature" : mode)) throw new Error("Grouping mode was not persisted");
      if (mode === "settings") {
        if (page.viewportSize().width < 700) await page.getByLabel("Group 1 name", { exact: true }).scrollIntoViewIfNeeded();
        return;
      }
      await page.evaluate(() => { location.hash = "#/"; });
      await page.locator(".grouping-toolbar").waitFor();
      await page.locator(".group-label").getByText("Pinned", { exact: true }).waitFor();
      if (mode !== "manual") {
        for (const title of mode === "feature" ? ["Settings", "Billing"] : ["Features", "Fixes"]) {
          await page.locator(".group-label").getByText(title, { exact: true }).waitFor();
        }
        return;
      }
      const row = page.locator(".queue-group").filter({ has: page.locator(".group-label").getByText("Ungrouped", { exact: true }) }).locator("a.row:not(.stack-child)").first();
      await row.hover();
      const href = await row.getAttribute("href");
      const picker = page.locator(".grouping-toolbar select");
      await picker.selectOption({ label: "Release planning" });
      const grouped = () => page.locator(".queue-group").filter({ has: page.locator(".group-label").getByText("Release planning", { exact: true }) }).locator(`a[href="${href}"]`);
      await grouped().waitFor();
      if (!await grouped().evaluate((node) => node.classList.contains("selected"))) throw new Error("Regrouping lost selection");

      await page.reload();
      await grouped().waitFor();
      await grouped().hover();
      await picker.selectOption("");
      await grouped().waitFor({ state: "hidden" });
      await picker.selectOption({ label: "Release planning" });
      await grouped().waitFor();
      await picker.evaluate((node) => node.blur());
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/${href}`);
      await page.locator(".detail .pr-head").waitFor();
      await page.keyboard.press("Escape");
      await grouped().waitFor();
    },
    verify: async (page) => {
      if (mode === "settings") {
        const editor = await page.locator(".group-editor").boundingBox();
        const footer = await page.locator(".settings .actions").boundingBox();
        if (footer.y < editor.y + editor.height) throw new Error("Save footer obscures the group editor");
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw new Error("Grouping UI overflows the viewport");
    },
  }));
}
