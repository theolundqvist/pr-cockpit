// Run with shell/node_modules/.bin/electron against an isolated COCKPIT_MOCK server.
// Replays native input-event phases through the actual shell/preload/renderer bridge.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = process.env.COCKPIT_TEST_ROOT || path.resolve(__dirname, "..");
const base = process.env.COCKPIT_TEST_URL || "http://127.0.0.1:4899";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-trackpad-"));
app.setPath("userData", path.join(temporary, "user"));
process.env.COCKPIT_URL = `${base}/#/`;
process.env.COCKPIT_DATA_DIR = path.join(temporary, "data");
delete process.env.COCKPIT_MANAGED;
require(path.join(root, "shell/main.js"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    assert(Date.now() < deadline, "native gesture replay timed out");
    await delay(30);
  }
}
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL() === `${base}/#/`));
    const win = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === `${base}/#/`);
    win.show();
    win.focus();
    const wc = win.webContents;
    const js = (source) => wc.executeJavaScript(source);
    await until(() => js('!!document.querySelector(".inbox .row")'));
    assert.equal(await js('typeof window.cockpitShell.onTrackpadNavigationPhase'), "function");
    await js('location.hash = "#/pr/fixture/cockpit/101"');
    await until(() => js('!!document.querySelector(".pr-head")'));
    const phase = async (type) => {
      wc.emit("input-event", {}, { type });
      await delay(30);
    };
    const wheel = (x, selector = ".pr-head") => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new WheelEvent("wheel", {bubbles:true, cancelable:true, deltaX:${x}}))`);
    const detail = "#/pr/fixture/cockpit/101";
    await phase("gestureScrollBegin");
    assert.equal(await wheel(-75), false);
    assert.equal(await js("location.hash"), detail);
    await phase("gestureScrollEnd");
    await until(async () => await js("location.hash") === "#/");
    await until(() => js('!!document.querySelector(".inbox .row")'));
    await phase("gestureScrollBegin");
    await wheel(75, ".inbox");
    await phase("gestureScrollEnd");
    await until(async () => await js("location.hash") === detail);
    await until(() => js('!!document.querySelector(".pr-head")'));
    await phase("gestureScrollBegin");
    await wheel(-75);
    win.emit("blur");
    await phase("gestureScrollEnd");
    assert.equal(await js("location.hash"), detail, "blur must cancel the gesture");

    const beforeWindows = new Set(BrowserWindow.getAllWindows());
    await js('window.cockpitShell.openWindow("#/pr/fixture/cockpit/101")');
    await until(() => BrowserWindow.getAllWindows().some((item) => !beforeWindows.has(item)));
    const extra = BrowserWindow.getAllWindows().find((item) => !beforeWindows.has(item));
    const extraJs = (source) => extra.webContents.executeJavaScript(source);
    await until(() => extraJs('!!document.querySelector(".pr-head")'));
    await extraJs('location.hash = "#/pr/fixture/cockpit/102"');
    await delay(300);
    extra.webContents.emit("input-event", {}, { type: "gestureScrollBegin" });
    await delay(30);
    await extraJs('document.querySelector(".pr-head").dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaX:-75}))');
    extra.webContents.emit("input-event", {}, { type: "gestureScrollEnd" });
    await until(async () => await extraJs("location.hash") === detail);
    assert.equal(await js("location.hash"), detail, "other window must not receive the gesture");
    console.log("native history gesture: main and detached windows, back/forward, release and blur cancellation passed");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
