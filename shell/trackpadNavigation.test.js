const { expect, test } = require("bun:test");
const { EventEmitter } = require("events");
const { attachTrackpadNavigation } = require("./trackpadNavigation");

test.skipIf(process.platform !== "darwin")("trackpad cleanup never reads webContents from a destroyed window", () => {
  const webContents = new EventEmitter();
  let destroyed = false;
  const sent = [];
  webContents.isDestroyed = () => destroyed;
  webContents.send = (...args) => sent.push(args);
  const win = new EventEmitter();
  Object.defineProperty(win, "webContents", {
    get() {
      if (destroyed) throw new Error("Object has been destroyed");
      return webContents;
    },
  });
  win.getNativeWindowHandle = () => Buffer.alloc(8);
  attachTrackpadNavigation(win);
  win.emit("blur");
  expect(sent).toEqual([["cockpit:trackpad-phase", "cancel"]]);
  destroyed = true;
  expect(() => win.emit("blur")).not.toThrow();
  expect(() => win.emit("closed")).not.toThrow();
  expect(win.listenerCount("blur")).toBe(0);
  expect(webContents.listenerCount("input-event")).toBe(0);
});
