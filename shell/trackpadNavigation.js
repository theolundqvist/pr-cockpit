const CHANNEL = "cockpit:trackpad-phase";
const windows = new Map();
let nativeMonitor;
let nativeAttempted = false;

function getNativeMonitor() {
  if (nativeAttempted) return nativeMonitor;
  nativeAttempted = true;
  try {
    const monitor = require("./native/build/trackpad.node");
    if (monitor.start((phase, windowNumber) => {
      const win = windows.get(windowNumber);
      if (win && !win.webContents.isDestroyed()) win.webContents.send(CHANNEL, phase);
    })) nativeMonitor = monitor;
  } catch (error) {
    console.warn("pr-cockpit: using Electron trackpad fallback:", error.message);
  }
  return nativeMonitor;
}

// Electron's gesture phases distinguish one trackpad gesture from its wheel deltas.
// Keep delivery scoped to the window receiving input, including detached PR windows.
function attachTrackpadNavigation(win) {
  if (process.platform !== "darwin") return;
  const send = (phase) => {
    if (!win.webContents.isDestroyed()) win.webContents.send(CHANNEL, phase);
  };
  const input = (_event, event) => {
    if (event.type === "gestureScrollBegin") send("begin");
    else if (event.type === "gestureScrollEnd") send("end");
    else if (event.type === "gesturePinchBegin" || event.type === "touchCancel") send("cancel");
  };
  const cancel = () => send("cancel");
  // AppKit ends finger contact before momentum; Chromium's scroll-end may arrive
  // later. Never mix both streams or momentum can reopen a completed gesture.
  const native = getNativeMonitor();
  const windowNumber = native?.windowNumber(win.getNativeWindowHandle());
  if (native) windows.set(windowNumber, win);
  else win.webContents.on("input-event", input);
  win.on("blur", cancel);
  win.once("closed", () => {
    win.webContents.removeListener("input-event", input);
    if (native) windows.delete(windowNumber);
    win.removeListener("blur", cancel);
  });
}

module.exports = { attachTrackpadNavigation };
