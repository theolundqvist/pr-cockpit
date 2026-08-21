import { expect, test } from "bun:test";
import { startCockpitServer } from "./cockpitServer.ts";
import {
  invalidateInbox,
  invalidatePr,
  publishPollCompleted,
  setRendererInvalidationPublisher,
} from "./rendererInvalidation.ts";

function openSocket(url: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => resolve(socket), { once: true });
  socket.addEventListener("error", () => reject(new Error("renderer event socket failed")), { once: true });
  return promise;
}

test("renderer event socket publishes poll, PR, and inbox invalidations after backend changes", async () => {
  const server = startCockpitServer(0, (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/mutate") {
      publishPollCompleted("2026-08-21T14:02:37.671Z");
      invalidatePr("microsoft/vscode", 331792);
      invalidateInbox();
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  });

  let socket: WebSocket | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${baseUrl}/api/events`)).status).toBe(426);
    expect((await fetch(`${baseUrl}/api/events`, {
      headers: { origin: "https://example.com" },
    })).status).toBe(403);

    socket = await openSocket(`ws://127.0.0.1:${server.port}/api/events`);
    const { promise: eventsPromise, resolve: resolveEvents } = Promise.withResolvers<unknown[]>();
    const events: unknown[] = [];
    socket.addEventListener("message", (message) => {
      events.push(JSON.parse(String(message.data)));
      if (events.length === 3) resolveEvents(events);
    });

    expect((await fetch(`${baseUrl}/mutate`, { method: "POST" })).ok).toBe(true);
    expect(await eventsPromise).toEqual([
      { type: "poll-complete", lastPollAt: "2026-08-21T14:02:37.671Z" },
      { type: "pr", repo: "microsoft/vscode", number: 331792 },
      { type: "inbox" },
    ]);
  } finally {
    socket?.close();
    server.stop(true);
    setRendererInvalidationPublisher(() => {});
  }
});
