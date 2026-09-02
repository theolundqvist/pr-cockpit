export function tailscaleAccess(health) {
  const serve = health?.tailscaleServe;
  if (serve?.origin) return { state: "live", origin: serve.origin, kind: "Tailscale Serve", error: null };
  const error = serve?.error || null;
  return error
    ? { state: "error", origin: null, kind: null, error }
    : { state: "local", origin: null, kind: null, error: null };
}
