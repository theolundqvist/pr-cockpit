// Browser integration coverage uses an isolated mutation queue, never a real order.
export function kitchenCancelScenarios() {
  return ["ready", "pending", "failed", "serving"].map((mode) => ({
    name: `detail-kitchen-cancel-${mode}`,
    route: "#/pr/fixture/cockpit/101",
    ready: ".detail .pr-head",
    beforeGoto: async (page) => {
      let submitted = false;
      await page.route("**/api/settings", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), cooking_section_enabled: true } });
      });
      await page.route((url) => url.pathname === "/api/pr/fixture/cockpit/101", async (route) => {
        const response = await route.fetch();
        const pr = await response.json();
        pr.labels.nodes.push(...["order", "rush", mode === "serving" ? "kitchen: serving" : "kitchen: oven"].map((name) => ({ name, color: "5319e7" })));
        await route.fulfill({ response, json: pr });
      });
      await page.route("**/api/mutations**", async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON();
          if (JSON.stringify(body) !== JSON.stringify({ repo: "fixture/cockpit", number: 101, payload: { kind: "remove-labels", labels: ["order", "rush"] } })) throw new Error(`Unexpected cancellation: ${JSON.stringify(body)}`);
          submitted = true;
          return route.fulfill({ status: 201, json: { id: 9100 } });
        }
        return route.fulfill({ json: { mutations: submitted ? [{ id: 9100, kind: "remove-labels", payload: { kind: "remove-labels", labels: ["order", "rush"] }, state: mode === "failed" ? "failed" : "pending", error: mode === "failed" ? "Permission denied" : null }] : [] } });
      });
    },
    interact: async (page) => {
      if (!["pending", "failed"].includes(mode)) return;
      await page.getByRole("button", { name: "Cancel Kitchen order", exact: true }).click();
      await page.getByRole("button", { name: "Cancel order", exact: true }).click();
    },
    verify: async (page) => {
      if (mode === "failed") {
        await page.getByRole("alert").filter({ hasText: /cancel Kitchen order/i }).waitFor();
        await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        return;
      }
      const button = page.getByRole("button", { name: mode === "pending" ? "Cancelling order…" : "Cancel Kitchen order", exact: true });
      await button.waitFor();
      if (await button.isDisabled() !== ["pending", "serving"].includes(mode)) throw new Error(`Wrong cancellation availability: ${mode}`);
    },
  }));
}
