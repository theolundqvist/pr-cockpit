const { describe, expect, test } = require("bun:test");
const { setupCommand, setupInvocation } = require("./setupLaunch");

describe("setupCommand", () => {
  test("opens only fixed authentication commands", () => {
    expect(setupCommand("omp-anthropic")).toContain("connect Anthropic");
    expect(setupCommand("github-workflow")).toBeNull();
    expect(setupCommand("arbitrary")).toBeNull();
  });

  test("runs setup on the authoritative host in proxy mode", () => {
    expect(setupInvocation("omp", "root@dev-vm")).toBe("ssh -t 'root@dev-vm' 'omp'");
    expect(setupInvocation("omp", "bad host")).toBeNull();
  });
});