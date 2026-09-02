import { setRendererInvalidationPublisher } from "./rendererInvalidation.ts";

type FetchHandler = (request: Request) => Response | Promise<Response>;

const UNSAFE_BROWSER_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

function parseAllowedOrigins(configured: string | undefined): Set<string> {
  const origins = new Set<string>();
  if (configured === undefined) return origins;
  for (const entry of configured.split(",")) {
    const value = entry.trim();
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`COCKPIT_ALLOWED_ORIGINS entry is not a valid URL: ${value}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`COCKPIT_ALLOWED_ORIGINS entry must be an HTTP(S) origin: ${value}`);
    }
    if (url.origin !== value) {
      throw new Error(`COCKPIT_ALLOWED_ORIGINS entry must be an exact origin like ${url.origin}: ${value}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function mergeRendererOrigins(...entries: Array<string | undefined | null>): string | undefined {
  const origins = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    for (const origin of parseAllowedOrigins(entry)) origins.add(origin);
  }
  return origins.size === 0 ? undefined : [...origins].join(",");
}

function buildOriginPolicy(configured: string | undefined): (request: Request) => boolean {
  const allowedOrigins = parseAllowedOrigins(configured);
  return (request) => {
    const origin = request.headers.get("origin");
    if (origin === null) return request.headers.get("sec-fetch-site") !== "cross-site";
    if (allowedOrigins.has(origin)) return true;
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:")
        && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
    } catch {
      return false;
    }
  };
}

export function startCockpitServer(port: number, fetchHandler: FetchHandler, allowedOrigins?: string) {
  const originAllowed = buildOriginPolicy(allowedOrigins ?? Bun.env.COCKPIT_ALLOWED_ORIGINS);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/api/events") {
        if (!originAllowed(request)) return new Response("Forbidden", { status: 403 });
        return bunServer.upgrade(request)
          ? undefined
          : new Response("WebSocket upgrade required", { status: 426 });
      }
      if (UNSAFE_BROWSER_METHODS[request.method] && !originAllowed(request)) {
        return new Response("Forbidden", { status: 403 });
      }
      return fetchHandler(request);
    },
    websocket: {
      open(socket) {
        socket.subscribe("renderer-invalidations");
      },
      message() {},
    },
    // above Bun's 10s default - the range-diff route can wait out a bounded incremental mirror fetch
    idleTimeout: 30,
  });
  setRendererInvalidationPublisher((event) => {
    server.publish("renderer-invalidations", JSON.stringify(event));
  });
  return server;
}
