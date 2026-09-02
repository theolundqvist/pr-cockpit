import { expect, test } from "bun:test";
import { tailscaleAccess } from "./tailscaleAccess.js";

test("shows classic Serve status and surfaces failures", () => {
  expect(tailscaleAccess({ tailscaleServe: { origin: "https://host.tail.ts.net:8443" } })).toEqual({
    state: "live", origin: "https://host.tail.ts.net:8443", kind: "Tailscale Serve", error: null,
  });
  expect(tailscaleAccess({ tailscaleServe: { error: "port occupied" } }).error).toBe("port occupied");
  expect(tailscaleAccess({}).state).toBe("local");
});
