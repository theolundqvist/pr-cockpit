import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredSupervisorForPort, runtimeSupervisor } from "./supervisor.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-supervisor-"));
  fixtures.push(root);
  return root;
}

describe("Cockpit supervisor ownership", () => {
  test("identifies system and user service processes", () => {
    expect(runtimeSupervisor({}, "0::/system.slice/pr-cockpit.service\n")).toBe("systemd-system");
    expect(runtimeSupervisor({}, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pr-cockpit.service\n")).toBe("systemd-user");
    expect(runtimeSupervisor({}, "0::/user.slice/user-1000.slice/session-1.scope\n")).toBe("unmanaged");
    expect(runtimeSupervisor({ COCKPIT_SUPERVISOR: "systemd-user" }, "")).toBe("systemd-user");
  });

  test("matches only the configured user-service port", () => {
    const root = fixture();
    const unit = join(root, "pr-cockpit.service");
    const environment = join(root, "server.env");
    writeFileSync(unit, "[Service]\n");
    writeFileSync(environment, "COCKPIT_PORT=4912\n");

    expect(configuredSupervisorForPort(4912, { platform: "linux", userUnit: unit, userEnvironment: environment, systemUnit: join(root, "absent") })).toBe("systemd-user");
    expect(configuredSupervisorForPort(4820, { platform: "linux", userUnit: unit, userEnvironment: environment, systemUnit: join(root, "absent") })).toBeNull();
  });

  test("recognizes a system service and its explicit port", () => {
    const root = fixture();
    const unit = join(root, "pr-cockpit.service");
    writeFileSync(unit, "[Service]\nEnvironment=\"COCKPIT_PORT=4930\"\n");

    expect(configuredSupervisorForPort(4930, { platform: "linux", userUnit: join(root, "absent"), systemUnit: unit })).toBe("systemd-system");
    expect(configuredSupervisorForPort(4820, { platform: "linux", userUnit: join(root, "absent"), systemUnit: unit })).toBeNull();
  });
});
