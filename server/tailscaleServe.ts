export type TailscaleServeStatus = {
  enabled: boolean;
  origin: string | null;
  proxy: string | null;
  httpsPort: number | null;
  error: string | null;
};

export type TailscaleCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TailscaleCommandRunner = (args: readonly string[]) => Promise<TailscaleCommandResult>;

const DISABLED: TailscaleServeStatus = { enabled: false, origin: null, proxy: null, httpsPort: null, error: null };
const COMMAND_TIMEOUT_MS = 15_000;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

let lastStatus: TailscaleServeStatus = DISABLED;

export function tailscaleServeEnabled(value = Bun.env.COCKPIT_TAILSCALE_SERVE): boolean {
  return value === "1";
}

export function tailscaleHttpsPort(value = Bun.env.COCKPIT_TAILSCALE_HTTPS_PORT): number {
  const port = value?.trim() ? Number(value) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`COCKPIT_TAILSCALE_HTTPS_PORT is not a valid port: ${value}`);
  }
  return port;
}

export function tailscaleServeStatus(): TailscaleServeStatus {
  return lastStatus;
}

export function resetTailscaleServeStatus(): void {
  lastStatus = DISABLED;
}

function failed(proxy: string, httpsPort: number | null, error: string): TailscaleServeStatus {
  return { enabled: true, origin: null, proxy, httpsPort, error };
}

function selfDnsName(status: unknown): string {
  if (!status || typeof status !== "object" || !("Self" in status) || !status.Self || typeof status.Self !== "object") {
    return "";
  }
  const dnsName = "DNSName" in status.Self ? status.Self.DNSName : "";
  return typeof dnsName === "string" ? dnsName : "";
}

export function normalizeMagicDnsHost(value: string): string {
  return value.trim().replace(/\.+$/, "").toLowerCase();
}

export function magicDnsHttpsOrigin(statusJson: string, httpsPort = 443): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    throw new Error("tailscale status --json was not valid JSON");
  }
  const dnsName = selfDnsName(parsed);
  const host = normalizeMagicDnsHost(dnsName);
  if (!HOSTNAME.test(host)) {
    throw new Error(host ? `Tailscale MagicDNS name is not a valid hostname: ${dnsName}` : "Tailscale did not report a MagicDNS name");
  }
  return `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;
}

export function tailscaleServeArgs(port: number, httpsPort = 443): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`];
}

export function conflictingServeRoute(serveStatusJson: string, origin: string, httpsPort: number, proxy: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serveStatusJson);
  } catch {
    throw new Error("tailscale serve status --json was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("Web" in parsed) || !parsed.Web || typeof parsed.Web !== "object") return null;
  const host = new URL(origin).hostname;
  const site = (parsed.Web as Record<string, unknown>)[`${host}:${httpsPort}`];
  if (!site || typeof site !== "object" || !("Handlers" in site) || !site.Handlers || typeof site.Handlers !== "object") return null;
  const handler = (site.Handlers as Record<string, unknown>)["/"];
  if (!handler || typeof handler !== "object") return null;
  const existing = "Proxy" in handler && typeof handler.Proxy === "string" ? handler.Proxy : "another handler";
  return existing === proxy ? null : `Tailscale HTTPS ${httpsPort} already routes / to ${existing}`;
}

async function runTailscale(bin: string, args: readonly string[]): Promise<TailscaleCommandResult> {
  const process = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function startTailscaleServe(
  port: number,
  deps: { enabled?: boolean; httpsPort?: number; which?: () => string | null; run?: TailscaleCommandRunner } = {},
): Promise<TailscaleServeStatus> {
  if (!(deps.enabled ?? tailscaleServeEnabled())) {
    lastStatus = DISABLED;
    return lastStatus;
  }
  const proxy = `http://127.0.0.1:${port}`;
  let httpsPort: number;
  try {
    httpsPort = deps.httpsPort ?? tailscaleHttpsPort();
  } catch (error) {
    lastStatus = failed(proxy, null, error instanceof Error ? error.message : String(error));
    return lastStatus;
  }
  const bin = (deps.which ?? (() => Bun.which("tailscale")))();
  if (!bin) {
    lastStatus = failed(proxy, httpsPort, "`tailscale` is not on PATH");
    return lastStatus;
  }
  const run = deps.run ?? ((args) => runTailscale(bin, args));
  try {
    const status = await run(["status", "--json"]);
    if (status.exitCode !== 0) {
      lastStatus = failed(proxy, httpsPort, (status.stderr || status.stdout).trim() || `tailscale status exited ${status.exitCode}`);
      return lastStatus;
    }
    const origin = magicDnsHttpsOrigin(status.stdout, httpsPort);
    const serveStatus = await run(["serve", "status", "--json"]);
    if (serveStatus.exitCode !== 0) {
      lastStatus = failed(proxy, httpsPort, (serveStatus.stderr || serveStatus.stdout).trim() || `tailscale serve status exited ${serveStatus.exitCode}`);
      return lastStatus;
    }
    const conflict = conflictingServeRoute(serveStatus.stdout, origin, httpsPort, proxy);
    if (conflict) {
      lastStatus = failed(proxy, httpsPort, conflict);
      return lastStatus;
    }
    const served = await run(tailscaleServeArgs(port, httpsPort));
    if (served.exitCode !== 0) {
      lastStatus = failed(proxy, httpsPort, (served.stderr || served.stdout).trim() || `tailscale serve exited ${served.exitCode}`);
      return lastStatus;
    }
    lastStatus = { enabled: true, origin, proxy, httpsPort, error: null };
    return lastStatus;
  } catch (error) {
    lastStatus = failed(proxy, httpsPort, error instanceof Error ? error.message : String(error));
    return lastStatus;
  }
}
