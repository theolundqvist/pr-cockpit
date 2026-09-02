import { afterEach, expect, test } from "bun:test";
import { mergeRendererOrigins, startCockpitServer } from "./cockpitServer.ts";
import {
  conflictingServeRoute,
  magicDnsHttpsOrigin,
  resetTailscaleServeStatus,
  startTailscaleServe,
  tailscaleHttpsPort,
  tailscaleServeArgs,
  tailscaleServeEnabled,
  tailscaleServeStatus,
  type TailscaleCommandResult,
} from "./tailscaleServe.ts";
import { setRendererInvalidationPublisher } from "./rendererInvalidation.ts";

afterEach(resetTailscaleServeStatus);

function fakeTailscale(commands: string[][]): (args: readonly string[]) => Promise<TailscaleCommandResult> {
  return async (args) => {
    commands.push([...args]);
    if (args[0] === "status") {
      return { exitCode: 0, stdout: JSON.stringify({ Self: { DNSName: "cockpit-node.example.ts.net." } }), stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "status") return { exitCode: 0, stdout: JSON.stringify({ Web: {} }), stderr: "" };
    if (args[0] === "serve" && args[1] === "--bg") return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: `unexpected tailscale ${args.join(" ")}` };
  };
}

test("Serve is opt-in", () => {
  expect(tailscaleServeEnabled(undefined)).toBe(false);
  expect(tailscaleServeEnabled("0")).toBe(false);
  expect(tailscaleServeEnabled("1")).toBe(true);
});

test("Serve publishes configurable HTTPS to loopback and never Funnel", () => {
  expect(tailscaleServeArgs(4820, 8443)).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:4820"]);
  expect(tailscaleServeArgs(4820, 8443).join(" ")).not.toContain("funnel");
  expect(tailscaleHttpsPort(undefined)).toBe(443);
  expect(tailscaleHttpsPort("8443")).toBe(8443);
  expect(() => tailscaleHttpsPort("0")).toThrow("not a valid port");
});

test("MagicDNS origin strips the trailing dot and includes a non-default port", () => {
  const status = JSON.stringify({ Self: { DNSName: "cockpit-node.example.ts.net." } });
  expect(magicDnsHttpsOrigin(status)).toBe("https://cockpit-node.example.ts.net");
  expect(magicDnsHttpsOrigin(status, 8443)).toBe("https://cockpit-node.example.ts.net:8443");
  expect(() => magicDnsHttpsOrigin("{}")).toThrow("did not report a MagicDNS name");
});

test("Serve records its published origin", async () => {
  const commands: string[][] = [];
  const status = await startTailscaleServe(4820, {
    enabled: true,
    httpsPort: 8443,
    which: () => "/usr/bin/tailscale",
    run: fakeTailscale(commands),
  });
  expect(status).toEqual({
    enabled: true,
    origin: "https://cockpit-node.example.ts.net:8443",
    proxy: "http://127.0.0.1:4820",
    httpsPort: 8443,
    error: null,
  });
  expect(tailscaleServeStatus()).toEqual(status);
  expect(commands).toEqual([
    ["status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--bg", "--https=8443", "http://127.0.0.1:4820"],
  ]);
});

test("Serve refuses to replace another root route", async () => {
  const commands: string[][] = [];
  const config = JSON.stringify({
    Web: { "cockpit-node.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
  });
  expect(conflictingServeRoute(config, "https://cockpit-node.example.ts.net:8443", 8443, "http://127.0.0.1:4820")).toContain("already routes /");
  const status = await startTailscaleServe(4820, {
    enabled: true,
    httpsPort: 8443,
    which: () => "/usr/bin/tailscale",
    run: async (args) => {
      commands.push([...args]);
      if (args[0] === "status") return { exitCode: 0, stdout: JSON.stringify({ Self: { DNSName: "cockpit-node.example.ts.net." } }), stderr: "" };
      return { exitCode: 0, stdout: config, stderr: "" };
    },
  });
  expect(status.error).toContain("already routes /");
  expect(commands).toEqual([["status", "--json"], ["serve", "status", "--json"]]);
});

test("missing Tailscale and failed status leave loopback available", async () => {
  expect(await startTailscaleServe(4820, { enabled: true, which: () => null })).toEqual({
    enabled: true, origin: null, proxy: "http://127.0.0.1:4820", httpsPort: 443, error: "`tailscale` is not on PATH",
  });
  expect(await startTailscaleServe(4820, {
    enabled: true,
    which: () => "/usr/bin/tailscale",
    run: async () => ({ exitCode: 1, stdout: "", stderr: "tailscaled unavailable" }),
  })).toEqual({
    enabled: true, origin: null, proxy: "http://127.0.0.1:4820", httpsPort: 443, error: "tailscaled unavailable",
  });
  expect(await startTailscaleServe(4820, { enabled: false })).toEqual({
    enabled: false, origin: null, proxy: null, httpsPort: null, error: null,
  });
});

test("configured origins merge with the published Serve origin", () => {
  expect(mergeRendererOrigins("https://other.example", "https://cockpit-node.example.ts.net:8443")).toBe(
    "https://other.example,https://cockpit-node.example.ts.net:8443",
  );
  expect(mergeRendererOrigins(undefined, null)).toBeUndefined();
});

test("Cockpit server still listens only on loopback", () => {
  const server = startCockpitServer(0, () => new Response("ok"));
  try {
    expect(server.hostname).toBe("127.0.0.1");
  } finally {
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});
