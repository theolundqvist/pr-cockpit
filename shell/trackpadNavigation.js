const CHANNEL = "cockpit:trackpad-phase";

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
  win.webContents.on("input-event", input);
  win.on("blur", cancel);
  win.once("closed", () => {
    win.webContents.removeListener("input-event", input);
    win.removeListener("blur", cancel);
  });
}

module.exports = { attachTrackpadNavigation };
