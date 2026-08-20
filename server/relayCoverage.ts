import { ghToken } from "./github.ts";
import { relayConfig } from "./settings.ts";

export async function relayCoverage(repos: string[]): Promise<Record<string, boolean>> {
  const res = await fetch(`${relayConfig().url}/coverage?repos=${encodeURIComponent(repos.join(","))}`, {
    headers: { Authorization: `Bearer ${await ghToken()}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`relay coverage failed: ${res.status} ${await res.text()}`);
  const { repos: coverage } = (await res.json()) as { repos: Record<string, boolean> };
  return coverage;
}
