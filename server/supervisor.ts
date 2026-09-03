import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CockpitSupervisor = "systemd-system" | "systemd-user" | "unmanaged";

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function runtimeSupervisor(environment: NodeJS.ProcessEnv = process.env, cgroup = read("/proc/self/cgroup")): CockpitSupervisor {
  if (environment.COCKPIT_SUPERVISOR === "systemd-system" || environment.COCKPIT_SUPERVISOR === "systemd-user") {
    return environment.COCKPIT_SUPERVISOR;
  }
  const serviceGroup = cgroup.split("\n").find((line) => line.slice(line.lastIndexOf(":") + 1).split("/").includes("pr-cockpit.service"));
  if (!serviceGroup) return "unmanaged";
  return serviceGroup.includes("/user.slice/") ? "systemd-user" : "systemd-system";
}

function configuredPort(contents: string, fallback = 4820): number {
  const match = contents.match(/\bCOCKPIT_PORT=(\d+)\b/);
  return match ? Number(match[1]) : fallback;
}

export function configuredSupervisorForPort(
  port: number,
  options: { platform?: NodeJS.Platform; environment?: NodeJS.ProcessEnv; systemUnit?: string; userUnit?: string; userEnvironment?: string } = {},
): Exclude<CockpitSupervisor, "unmanaged"> | null {
  if ((options.platform ?? process.platform) !== "linux") return null;
  const environment = options.environment ?? process.env;
  const configHome = environment.XDG_CONFIG_HOME ?? join(environment.HOME ?? "", ".config");
  const userUnit = options.userUnit ?? join(configHome, "systemd/user/pr-cockpit.service");
  const userEnvironment = options.userEnvironment ?? join(configHome, "pr-cockpit/server.env");
  if (existsSync(userUnit) && configuredPort(read(userEnvironment)) === port) return "systemd-user";
  const systemUnit = options.systemUnit ?? "/etc/systemd/system/pr-cockpit.service";
  const systemUnitContents = read(systemUnit);
  if (systemUnitContents && configuredPort(systemUnitContents) === port) return "systemd-system";
  return null;
}

export function conflictingSupervisor(port: number, environment: NodeJS.ProcessEnv = process.env): Exclude<CockpitSupervisor, "unmanaged"> | null {
  if (runtimeSupervisor(environment) !== "unmanaged") return null;
  return configuredSupervisorForPort(port, { environment });
}
