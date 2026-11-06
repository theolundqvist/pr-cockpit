const { describe, expect, test } = require("bun:test");
const { createSelectionCapture, createSelectionOpener } = require("./selectedText");
const { createPanelOpenEvent } = require("./panelOpenEvent");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(capture) {
  const events = [];
  const failures = [];
  const pending = createPanelOpenEvent("cockpit:open-quick-generate");
  const panel = {
    win: { isFocused: () => false, isVisible: () => true },
    hide() { pending.clear(); events.push("hide"); },
    cancelPendingShow() { pending.clear(); events.push("cancel-pending"); },
    show(detail) { events.push(detail); pending.request(detail); },
  };
  let activePanel = panel;
  const opener = createSelectionOpener({ getPanel: () => activePanel, capture,
    reportFailure: (failure) => failures.push(failure) });
  return { opener, panel, pending, events, failures, disable() { activePanel = null; opener.cancel(); } };
}

describe("native selected text activation", () => {
  test("unsupported capture is an honest nonmodal notice, not a modal empty success", async () => {
    const state = fixture(async () => ({ status: "unavailable", selectedText: "must not import" }));
    await state.opener.open();
    expect(state.events[1]).toMatchObject({ selectedText: "", captureError: expect.any(String) });
    expect(state.failures).toEqual([]);
    expect(state.pending.takeScript()).toContain("captureError");
  });

  test("clipboard restoration failure remains explicitly actionable", async () => {
    const state = fixture(async () => ({ status: "clipboard-restore-failed", selectedText: "must not import" }));
    await state.opener.open();
    expect(state.events[1]).toEqual({ selectedText: "" });
    expect(state.failures).toHaveLength(1);
  });

  test("a visible but blurred floating panel still captures the external selection", async () => {
    const state = fixture(async () => ({ status: "ok", selectedText: "external selection" }));
    await state.opener.open();
    expect(state.events).toEqual(["cancel-pending", { selectedText: "external selection" }]);
  });

  test("a focused panel toggles closed without capturing", async () => {
    let captured = false;
    const state = fixture(async () => { captured = true; return { status: "ok", selectedText: "" }; });
    state.panel.win.isFocused = () => true;
    await state.opener.open();
    expect(state.events).toEqual(["hide"]);
    expect(captured).toBe(false);
  });

  test("waits for exact selection before presenting, including whitespace and Unicode", async () => {
    const selection = deferred();
    const state = fixture(() => selection.promise);
    const open = state.opener.open();
    expect(state.events).toEqual(["cancel-pending"]);
    const text = "  synthetic 🚀\n'\\\" </script>\u2028\t";
    selection.resolve({ status: "ok", selectedText: text });
    await open;
    expect(state.events[1]).toEqual({ selectedText: text });
    let delivered;
    class CustomEvent { constructor(name, init) { this.type = name; this.detail = init.detail; } }
    new Function("window", "CustomEvent", state.pending.takeScript())({ dispatchEvent(event) { delivered = event; } }, CustomEvent);
    expect(delivered.detail.selectedText).toBe(text);
    expect(delivered.type).toBe("cockpit:open-quick-generate");
    expect(state.pending.takeScript()).toBeNull();
  });

  test("latest shortcut owns capture even if older capture settles last", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const state = fixture(() => calls++ ? second.promise : first.promise);
    const a = state.opener.open();
    const b = state.opener.open();
    second.resolve({ status: "ok", selectedText: "new" });
    await b;
    first.resolve({ status: "ok", selectedText: "old" });
    await a;
    expect(state.events).toEqual(["cancel-pending", "cancel-pending", { selectedText: "new" }]);
  });

  test("new capture invalidates older pending first-load detail", async () => {
    const next = deferred();
    let calls = 0;
    const state = fixture(() => calls++ ? next.promise : Promise.resolve({ status: "ok", selectedText: "old" }));
    await state.opener.open();
    expect(state.pending.pending).toBe(true);
    const open = state.opener.open();
    expect(state.pending.pending).toBe(false);
    next.resolve({ status: "ok", selectedText: "new" });
    await open;
    expect(state.pending.takeScript()).toContain('"new"');
  });

  test("disabling the panel discards capture without showing or reporting", async () => {
    const selection = deferred();
    const state = fixture(() => selection.promise);
    const open = state.opener.open();
    state.disable();
    selection.resolve({ status: "accessibility-denied", selectedText: "" });
    await open;
    expect(state.events).toEqual(["cancel-pending"]);
    expect(state.failures).toEqual([]);
  });

  test("no selection sends empty detail, preserving the renderer-owned draft", async () => {
    const state = fixture(async () => ({ status: "ok", selectedText: "" }));
    await state.opener.open();
    expect(state.events[1]).toEqual({ selectedText: "" });
    expect(state.failures).toEqual([]);
  });

  test("permission denial still opens manual entry and explains the actual permission", async () => {
    const state = fixture(async () => ({ status: "accessibility-denied", selectedText: "not imported" }));
    await state.opener.open();
    expect(state.events[1]).toEqual({ selectedText: "" });
    expect(state.failures[0].settings).toContain("Privacy_Accessibility");
  });

  test("capture failures do not escape or report private error messages", async () => {
    const capture = createSelectionCapture({ platform: "darwin", loadNative: () => ({ capture() { throw Error("private text"); } }) });
    expect(await capture()).toEqual({ status: "unavailable", selectedText: "" });
  });

  test("missing native module is not disguised as no selection", async () => {
    const capture = createSelectionCapture({ platform: "darwin", loadNative() { throw Error("missing module"); } });
    expect(await capture()).toEqual({ status: "native-unavailable", selectedText: "" });
  });

  test("unresponsive native capture is bounded for manual entry", async () => {
    const capture = createSelectionCapture({ platform: "darwin", timeoutMs: 5, loadNative: () => ({ capture: () => new Promise(() => {}) }) });
    expect(await capture()).toEqual({ status: "unavailable", selectedText: "" });
  });

  test("non-Mac behavior never loads native code or reads clipboard", async () => {
    for (const platform of ["linux", "win32"]) {
      const capture = createSelectionCapture({ platform, loadNative() { throw Error("must not load"); } });
      expect(await capture()).toEqual({ status: "ok", selectedText: "" });
    }
  });

  test("pending detail is latest-only, cleared on hide, and default events remain valid", () => {
    const queue = createPanelOpenEvent("cockpit:open-palette");
    queue.request({ selectedText: "one" });
    queue.request({ selectedText: "two" });
    expect(queue.takeScript()).toContain('"two"');
    queue.request({ selectedText: "discard" });
    queue.clear();
    expect(queue.takeScript()).toBeNull();
    queue.request();
    expect(queue.takeScript()).toContain("detail:{}");
  });
});
