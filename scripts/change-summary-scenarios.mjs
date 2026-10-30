import assert from "node:assert/strict";

export function changeSummaryScenario() {
  let row;
  return {
    name: "detail-change-summary",
    route: "#/pr/fixture/cockpit/101",
    ready: ".pr-metrics",
    description: "Conversation shows the inbox's filtered line counts above muted full totals.",
    beforeGoto: async (_page, { baseURL }) => {
      const key = "fixture/cockpit#101";
      const result = await fetch(`${baseURL}/api/pr-details?rows=1&keys=${encodeURIComponent(key)}`).then((r) => r.json());
      row = result.rows[key];
      assert.notEqual(row.additions, row.rawAdditions, "fixture must include excluded changes");
    },
    verify: async (page) => {
      const primary = page.locator(".pr-metric").first().locator("strong");
      const raw = page.locator(".pr-metric").first().locator("em");
      const expected = `+${row.additions} −${row.deletions}`;
      await page.waitForFunction((expected) => document.querySelector(".pr-metric strong")?.textContent === expected, expected);
      assert.equal(await raw.textContent(), `+${row.rawAdditions} −${row.rawDeletions}`);
      assert.equal(await raw.evaluate((node) => getComputedStyle(node).opacity), "0.5");
      // Loading the diff used to change these PR-wide counts; it must no longer do so.
      await page.getByRole("link", { name: /^Files/ }).click();
      await page.locator(".diff .file").first().waitFor();
      assert.equal(await primary.textContent(), expected);
      await page.getByRole("link", { name: /^Conversation/ }).click();
      assert.equal(await primary.textContent(), expected);
    },
  };
}
