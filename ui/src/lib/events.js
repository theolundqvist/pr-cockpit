// Renderer invalidations from /api/events. Reconnects a second after any close and calls onOpen on
// every (re)connect, since events published while disconnected are gone. Returns the disconnect.
export function connectEvents(onOpen, onEvent) {
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;

  function connect() {
    if (socket || stopped) return;

    const url = new URL("/api/events", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", (message) => {
      let invalidation;
      try {
        invalidation = JSON.parse(message.data);
      } catch {
        return;
      }
      onEvent(invalidation);
    });
    socket.addEventListener("close", () => {
      socket = null;
      if (!stopped) reconnectTimer = setTimeout(connect, 1000);
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  };
}
