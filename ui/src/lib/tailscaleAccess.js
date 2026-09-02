export function tailscaleAccess(health) {
  const serve = health?.tailscaleServe;
  if (!serve) return null;
  if (serve.origin) return { state: "live", origin: serve.origin, kind: "Tailscale Serve", error: null };
  return { state: "error", origin: null, kind: "Tailscale Serve", error: serve.error || "unavailable" };
}
