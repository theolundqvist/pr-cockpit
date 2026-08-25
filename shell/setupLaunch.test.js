const { describe, expect, test } = require("bun:test");
const { setupCommand } = require("./setupLaunch");

describe("setupCommand", () => {
  test("opens only fixed authentication commands", () => {
    expect(setupCommand("github-workflow")).toBe("gh auth refresh --hostname github.com --scopes workflow");
    expect(setupCommand("omp-anthropic")).toContain("connect Anthropic");
    expect(setupCommand("arbitrary")).toBeNull();
  });
});