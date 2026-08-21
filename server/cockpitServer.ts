import { setRendererInvalidationPublisher } from "./rendererInvalidation.ts";

type FetchHandler = (request: Request) => Response | Promise<Response>;

function rendererOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function startCockpitServer(port: number, fetchHandler: FetchHandler) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/api/events") {
        if (!rendererOriginAllowed(request)) return new Response("Forbidden", { status: 403 });
        return bunServer.upgrade(request)
          ? undefined
          : new Response("WebSocket upgrade required", { status: 426 });
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
