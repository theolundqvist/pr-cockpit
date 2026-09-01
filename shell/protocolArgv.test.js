const { describe, expect, test } = require("bun:test");
const { deepLinkHash, protocolAction, protocolArgFromArgv } = require("./protocolArgv");

describe("prcockpit protocol argv", () => {
  test("keeps the raw desktop-entry URL and routes it through the canonical parser", () => {
    const url = "prcockpit://pr/scape-app/scape/123";
    expect(protocolArgFromArgv(["electron", "/runtime/shell", url])).toBe(url);
    expect(protocolAction(url)).toEqual({ type: "open-pr", owner: "scape-app", repo: "scape", number: "123" });
    expect(deepLinkHash(url)).toBe("#/pr/scape-app/scape/123");
  });

  test("parses exact prcockpit://main as a focus action that never navigates", () => {
    expect(protocolAction("prcockpit://main")).toEqual({ type: "focus-main" });
    expect(deepLinkHash("prcockpit://main")).toBeNull();
    expect(protocolArgFromArgv(["electron", "/runtime/shell", "prcockpit://main"])).toBe("prcockpit://main");
  });

  test.each([
    "not a URL",
    "https://pr/scape-app/scape/123",
    "prcockpit://settings/scape-app/scape/123",
    "prcockpit://user@pr/scape-app/scape/123",
    "prcockpit://user:secret@pr/scape-app/scape/123",
    "prcockpit://pr:4820/scape-app/scape/123",
    "prcockpit://pr/scape-app/scape/123?tab=checks",
    "prcockpit://pr/scape-app/scape/123#files",
    "prcockpit://pr/scape-app/scape",
    "prcockpit://pr/scape-app/scape/123/extra",
    "prcockpit://pr//scape/123",
    "prcockpit://pr/scape%20app/scape/123",
    "prcockpit://pr/scape-app/scape%2Freviews/123",
    "prcockpit://pr/scape-app/scape/0",
    "prcockpit://pr/scape-app/scape/-1",
    "prcockpit://pr/scape-app/scape/01",
    "prcockpit://pr/scape-app/scape/1.5",
  ])("rejects invalid protocol input %s", (url) => {
    expect(protocolAction(url)).toBeNull();
    expect(deepLinkHash(url)).toBeNull();
    if (url.toLowerCase().startsWith("prcockpit:")) expect(protocolArgFromArgv(["electron", url])).toBe(url);
  });

  test.each([
    "prcockpit://main/",
    "prcockpit://main/extra",
    "prcockpit://main?focus=1",
    "prcockpit://main#top",
    "prcockpit://user@main",
    "prcockpit://user:secret@main",
    "prcockpit://main:4820",
    "prcockpit:main",
    "prcockpit://mainline",
  ])("rejects invalid main variant %s", (url) => {
    expect(protocolAction(url)).toBeNull();
    expect(deepLinkHash(url)).toBeNull();
  });

  test("finds a warm-launch URL without depending on Electron argv prefixes", () => {
    const url = "prcockpit://pr/owner/repo/42";
    expect(protocolArgFromArgv(["--cockpit-url=http://127.0.0.1:4820", url, "--flag"])).toBe(url);
    expect(protocolAction(url)?.type).toBe("open-pr");
  });

  test("distinguishes an invalid protocol argument from no protocol request", () => {
    expect(protocolArgFromArgv(["--cockpit-url=http://127.0.0.1:4820", "prcockpit://settings/owner/repo/42"])).toBe("prcockpit://settings/owner/repo/42");
    expect(protocolAction("prcockpit://settings/owner/repo/42")).toBeNull();
    expect(protocolArgFromArgv(["--cockpit-url=http://127.0.0.1:4820"])).toBeNull();
  });
});
