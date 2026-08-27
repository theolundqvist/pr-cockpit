const { describe, expect, test } = require("bun:test");
const { setupCommand } = require("./setupLaunch");

describe("setupCommand", () => {
  test("opens only fixed authentication commands", () => {
    expect(setupCommand("omp-anthropic")).toContain("connect Anthropic");
    expect(setupCommand("github-workflow")).toBeNull();
    expect(setupCommand("arbitrary")).toBeNull();
  });
});