const { describe, expect, test } = require("bun:test");
const { deepLinkHash, protocolArgFromArgv, protocolUrlFromArgv } = require("./protocolArgv");

describe("prcockpit protocol argv", () => {
  test("keeps the raw desktop-entry URL and routes it through the canonical parser", () => {
    const url = "prcockpit://pr/scape-app/scape/123";
    expect(protocolUrlFromArgv(["electron", "/runtime/shell", url])).toBe(url);
    expect(deepLinkHash(url)).toBe("#/pr/scape-app/scape/123");
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
    expect(protocolUrlFromArgv(["electron", url])).toBeNull();
    expect(deepLinkHash(url)).toBeNull();
    if (url.toLowerCase().startsWith("prcockpit:")) expect(protocolArgFromArgv(["electron", url])).toBe(url);
  });

  test("finds a warm-launch URL without depending on Electron argv prefixes", () => {
    const url = "prcockpit://pr/owner/repo/42";
    expect(protocolUrlFromArgv(["--cockpit-url=http://127.0.0.1:4820", url, "--flag"])).toBe(url);
  });

  test("distinguishes an invalid protocol argument from no protocol request", () => {
    expect(protocolArgFromArgv(["--cockpit-url=http://127.0.0.1:4820", "prcockpit://settings/owner/repo/42"])).toBe("prcockpit://settings/owner/repo/42");
    expect(protocolArgFromArgv(["--cockpit-url=http://127.0.0.1:4820"])).toBeNull();
  });
});
