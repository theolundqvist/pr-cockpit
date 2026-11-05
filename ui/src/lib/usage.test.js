import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { sendUsage } from "./api.js";
import { controlName, keyCombo, showScreen, startUsage, tapKeys } from "./usage.js";

// A tiny DOM: elements with attributes and children, closest/matches for the simple selectors usage.js uses, and event targets.
class Element {
  constructor(tag, attrs, children) {
    this.tagName = tag === "svg" ? "svg" : tag.toUpperCase();
    this.nodeType = 1;
    this.attrs = attrs;
    this.parentElement = null;
    this.childNodes = children.map((child) => (typeof child === "string" ? { nodeType: 3, nodeValue: child } : child));
    for (const child of this.childNodes) if (child.nodeType === 1) child.parentElement = this;
    this.checked = false;
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  get type() {
    return this.attrs.type ?? (this.tagName === "INPUT" ? "text" : "");
  }
  get isContentEditable() {
    return this.attrs.contenteditable === "true";
  }
  matches(selectors) {
    return selectors.split(",").some((selector) => {
      const [, tag, rest] = selector.trim().match(/^([a-z]*)(.*)$/);
      if (tag && tag.toUpperCase() !== this.tagName.toUpperCase()) return false;
      return [...rest.matchAll(/\.([\w-]+)|\[([\w-]+)(?:=([\w-]+))?\]/g)].every(([, className, attr, value]) =>
        className
          ? (this.attrs.class ?? "").split(/\s+/).includes(className)
          : value === undefined
            ? this.attrs[attr] !== undefined
            : this.attrs[attr] === value,
      );
    });
  }
  closest(selectors) {
    for (let at = this; at; at = at.parentElement) if (at.matches(selectors)) return at;
    return null;
  }
}
const h = (tag, attrs = {}, ...children) => new Element(tag, attrs, children);

class Target {
  listeners = new Map();
  addEventListener(type, listener, capture = false) {
    this.listeners.set(`${type}:${!!capture}`, [...(this.listeners.get(`${type}:${!!capture}`) ?? []), listener]);
  }
  removeEventListener(type, listener, capture = false) {
    this.listeners.set(`${type}:${!!capture}`, (this.listeners.get(`${type}:${!!capture}`) ?? []).filter((l) => l !== listener));
  }
  dispatch(type, event = {}) {
    let stopped = false;
    const sent = { type, ...event, stopImmediatePropagation: () => (stopped = true) };
    for (const key of [`${type}:true`, `${type}:false`]) for (const listener of this.listeners.get(key) ?? []) if (!stopped) listener(sent);
  }
  count() {
    return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  }
}

const WORDS = new Set(["Close", "Close pull request", "Reply", "Newest first", "relay-url", "Share usage statistics", "app"]);
const SECRET = "Secret launch plan for acme";
let doc;
let win;
let sent;
let running;

const start = (options = {}) => {
  running = startUsage({ send: (events, last) => sent.push({ events, last }), words: WORDS, root: doc, ...options });
  return running;
};
const events = () => sent.flatMap((batch) => batch.events);
const click = (target) => doc.dispatch("click", { target });

beforeEach(() => {
  doc = new Target();
  doc.visibilityState = "visible";
  win = new Target();
  const storage = new Map();
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  sent = [];
  setSystemTime(new Date("2026-11-05T12:00:00Z"));
});

afterEach(() => {
  running?.stop();
  running = null;
  vi.useRealTimers();
  setSystemTime();
});

describe("controlName", () => {
  test("uses data-event first", () => {
    expect(controlName(h("button", { "data-event": "merge", "aria-label": "Close" }, "Merge"), WORDS)).toBe("merge");
  });

  test("uses a static id the source writes, never one built from data", () => {
    expect(controlName(h("input", { id: "relay-url" }), WORDS)).toBe("relay-url");
    expect(controlName(h("select", { id: "trigger-secret-bot" }), WORDS)).toBe("select");
    expect(controlName(h("button", { id: "row-12" }), WORDS)).toBe("button");
  });

  test("uses an aria-label, title or the words a control shows when the app's source writes them", () => {
    expect(controlName(h("button", { "aria-label": "Close" }), WORDS)).toBe("close");
    expect(controlName(h("button", { title: "Close" }, "×"), WORDS)).toBe("close");
    const close = h("button", {}, h("svg", { "aria-hidden": "true" }), h("span", {}, "Close pull request"), h("kbd", { "aria-label": "X" }, "x"));
    expect(controlName(close, WORDS)).toBe("close-pull-request");
  });

  test("prefixes the place: the nearest data-area or static id around it", () => {
    const button = h("button", { "aria-label": "Close" });
    h("aside", { "data-area": "nav" }, h("div", {}, button));
    expect(controlName(button, WORDS)).toBe("nav:close");
  });

  test("stops looking for a place at the app's mount point", () => {
    const button = h("button", { "aria-label": "Close" });
    h("div", { id: "app" }, h("div", {}, button));
    expect(controlName(button, WORDS)).toBe("close");
  });

  test("falls back to what a control is when its label is built from data", () => {
    expect(controlName(h("button", { "aria-label": `Bring back ${SECRET}` }, "Bring back"), WORDS)).toBe("button");
    expect(controlName(h("a", { href: "#/pr/acme/secret/7" }, SECRET), WORDS)).toBe("link");
    expect(controlName(h("div", { role: "button" }, SECRET), WORDS)).toBe("button");
  });

  test("names a list row by its kind and a control in one by the kind and its own name", () => {
    expect(controlName(h("a", { href: "#/pr/acme/secret/7", class: "row wait", "data-event": "pr-row" }, SECRET), WORDS)).toBe("pr-row");
    expect(controlName(h("button", { class: "row file selected" }, "src/secret/path.ts"), WORDS)).toBe("row");
    expect(controlName(h("div", { role: "option" }, SECRET), WORDS)).toBe("option");
    const reply = h("button", {}, "Reply");
    const remove = h("button", { "aria-label": `Remove ${SECRET}` });
    h("div", { class: "comment" }, h("p", {}, SECRET), reply, remove);
    expect(controlName(reply, WORDS)).toBe("comment-reply");
    expect(controlName(remove, WORDS)).toBe("comment-button");
  });

  test("names anything inside rendered markdown by what it is alone", () => {
    const link = h("a", { href: "https://example.com", id: "relay-url", "data-event": "secret-plan" }, "Close");
    h("section", { "data-area": "timeline" }, h("div", { class: "md", id: "close" }, h("h2", { id: "secret" }, link)));
    expect(controlName(link, WORDS)).toBe("timeline:content-link");
  });
});

describe("keyCombo", () => {
  test("names shortcuts by modifier prefixes and the relay's key names", () => {
    expect(keyCombo({ key: "k", metaKey: true })).toBe("cmd+k");
    expect(keyCombo({ key: "M", shiftKey: true })).toBe("shift+m");
    expect(keyCombo({ key: "?", shiftKey: true })).toBe("question");
    expect(keyCombo({ key: "/" })).toBe("slash");
    expect(keyCombo({ key: ",", metaKey: true })).toBe("cmd+comma");
    expect(keyCombo({ key: "Tab", shiftKey: true })).toBe("shift+tab");
    expect(keyCombo({ key: "ArrowUp", ctrlKey: true })).toBe("ctrl+up");
    expect(keyCombo({ key: "ç", code: "KeyC", metaKey: true, altKey: true })).toBe("cmd+alt+c");
  });

  test("ignores bare modifiers and keys no shortcut uses", () => {
    expect(keyCombo({ key: "Shift", shiftKey: true })).toBeNull();
    expect(keyCombo({ key: "Meta", metaKey: true })).toBeNull();
    expect(keyCombo({ key: "F5" })).toBeNull();
    expect(keyCombo({ key: "é" })).toBeNull();
  });
});

describe("startUsage", () => {
  test("logs a step on the screen showing", async () => {
    const hide = showScreen("detail/conversation");
    start({ every: 60_000 }).step("pr-opened", "ok");
    win.dispatch("pagehide");
    hide();
    await Promise.resolve();
    expect(events().map(({ kind, action, value }) => [kind, action, value])).toEqual([
      ["screen", "detail/conversation", undefined],
      ["step", "pr-opened", "ok"],
    ]);
    expect(events()[1]).toEqual({ at: Date.now(), session: events()[0].session, kind: "step", screen: "detail/conversation", action: "pr-opened", value: "ok" });
    expect(events()[0].session).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(sent.every((batch) => batch.last)).toBe(true);
  });

  test("counts the screen, clicks on it and keeps one session per window", async () => {
    const hide = showScreen("inbox");
    start({ every: 60_000 });
    click(h("button", { "aria-label": `Bring back ${SECRET}` }, h("span", {}, SECRET)));
    click(h("button", { "data-event": "merge" }));
    win.dispatch("pagehide");
    const first = events();
    expect(first.map(({ kind, action }) => [kind, action])).toEqual([
      ["screen", "inbox"],
      ["ui", "button"],
      ["ui", "merge"],
    ]);
    expect(first.every((event) => event.screen === "inbox" && event.session === first[0].session)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("Secret");
    running.stop();
    sent = [];
    start({ every: 60_000 });
    win.dispatch("pagehide");
    expect(events()[0].session).toBe(first[0].session);
    hide();
    await Promise.resolve();
  });

  test("follows screens shown over the route and back, counting a swap in one task once", async () => {
    const hideRoute = showScreen("inbox");
    start({ every: 60_000 });
    let hideStep = showScreen("onboarding/choose", 1);
    await Promise.resolve();
    hideStep();
    hideStep = showScreen("onboarding/review", 1);
    await Promise.resolve();
    const hideSetup = showScreen("github-setup", 2);
    await Promise.resolve();
    hideSetup();
    await Promise.resolve();
    hideStep();
    await Promise.resolve();
    win.dispatch("pagehide");
    hideRoute();
    await Promise.resolve();
    expect(events().map((event) => event.action)).toEqual(["inbox", "onboarding/choose", "onboarding/review", "github-setup", "onboarding/review", "inbox"]);
  });

  test("logs checkbox and select changes with their value, an option only by the app's words", () => {
    start({ every: 60_000 });
    const box = h("input", { type: "checkbox", "data-event": "usage-stats" });
    box.checked = true;
    doc.dispatch("click", { target: box });
    doc.dispatch("change", { target: box });
    const select = h("select", { "aria-label": "Close" });
    select.selectedOptions = [h("option", {}, " Newest first ")];
    doc.dispatch("change", { target: select });
    select.selectedOptions = [h("option", {}, "acme/secret-repo")];
    doc.dispatch("change", { target: select });
    win.dispatch("pagehide");
    expect(events().map(({ action, value }) => [action, value])).toEqual([
      ["usage-stats", "on"],
      ["close", "newest-first"],
      ["close", undefined],
    ]);
    expect(JSON.stringify(sent)).not.toContain("secret-repo");
  });

  test("logs a typed-in field once per focus as typed, never what was typed", () => {
    start({ every: 60_000 });
    const field = h("textarea", { id: "relay-url" });
    field.value = SECRET;
    doc.dispatch("focusin", { target: field });
    doc.dispatch("input", { target: field });
    doc.dispatch("input", { target: field });
    const editor = h("div", { contenteditable: "true" }, SECRET);
    doc.dispatch("input", { target: editor });
    doc.dispatch("input", { target: h("input", { type: "checkbox" }) });
    doc.dispatch("focusin", { target: field });
    doc.dispatch("input", { target: field });
    win.dispatch("pagehide");
    expect(events().map(({ action, value }) => [action, value])).toEqual([
      ["relay-url", "typed"],
      ["div", "typed"],
      ["relay-url", "typed"],
    ]);
    expect(JSON.stringify(sent)).not.toContain("Secret");
  });

  test("logs shortcuts outside fields, the same one on a screen at most once per 5 seconds", async () => {
    const hide = showScreen("inbox");
    start({ every: 60_000 });
    const body = h("body");
    const key = (event) => win.dispatch("keydown", { target: body, ...event });
    key({ key: "j" });
    key({ key: "j" });
    key({ key: "j", repeat: true });
    key({ key: "Shift", shiftKey: true });
    key({ key: "M", shiftKey: true });
    key({ key: "k", target: h("textarea") });
    key({ key: "k", target: h("div", { contenteditable: "true" }) });
    setSystemTime(new Date(Date.now() + 5_000));
    key({ key: "j" });
    const hideSettings = showScreen("settings/usage", 1);
    await Promise.resolve();
    key({ key: "j" });
    win.dispatch("pagehide");
    hideSettings();
    hide();
    await Promise.resolve();
    expect(events().filter((event) => event.kind === "key").map(({ action, screen }) => [action, screen])).toEqual([
      ["j", "inbox"],
      ["shift+m", "inbox"],
      ["j", "inbox"],
      ["j", "settings/usage"],
    ]);
  });

  test("sees shortcuts a component's capture listener stops, through the tap installed first", () => {
    tapKeys(win);
    win.addEventListener("keydown", (event) => event.stopImmediatePropagation(), true);
    const usage = start({ every: 60_000 });
    start({ every: 60_000 }).stop();
    running = usage;
    win.dispatch("keydown", { target: h("body"), key: "?" });
    win.dispatch("pagehide");
    expect(events().filter((event) => event.kind === "key").map((event) => event.action)).toEqual(["question"]);
    expect(win.listeners.get("keydown:true")).toHaveLength(2);
  });

  test("sends batches of 50 at once and the rest every interval", () => {
    vi.useFakeTimers();
    start({ every: 20 });
    for (let i = 0; i < 52; i += 1) click(h("button", { "data-event": "merge" }));
    expect(sent.map((batch) => [batch.events.length, batch.last])).toEqual([[50, false]]);
    vi.advanceTimersByTime(20);
    expect(sent.map((batch) => [batch.events.length, batch.last])).toEqual([[50, false], [2, false]]);
    click(h("button", { "data-event": "merge" }));
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(sent.at(-1)).toMatchObject({ last: true, events: [{ action: "merge" }] });
  });

  test("stop removes its listeners and drops what is queued", () => {
    vi.useFakeTimers();
    const usage = start({ every: 20 });
    click(h("button", { "data-event": "merge" }));
    usage.stop();
    running = null;
    // Only the window's shortcut tap stays, and it hands keys to no one.
    expect(doc.count() + win.count()).toBe(1);
    click(h("button", { "data-event": "merge" }));
    win.dispatch("keydown", { target: h("body"), key: "j" });
    win.dispatch("pagehide");
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([]);
  });
});

describe("sendUsage", () => {
  const original = { navigator: globalThis.navigator, fetch: globalThis.fetch };
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: original.navigator, configurable: true });
    globalThis.fetch = original.fetch;
  });

  test("posts a batch with its session and client, and the last by beacon", async () => {
    const beacons = [];
    const posts = [];
    Object.defineProperty(globalThis, "navigator", {
      value: { userAgent: "Mozilla/5.0 Electron/38.0.0", sendBeacon: (url, blob) => beacons.push([url, blob]) && true },
      configurable: true,
    });
    globalThis.fetch = (url, init) => (posts.push([url, init]), Promise.resolve(new Response(null, { status: 204 })));
    const batch = [{ at: 1, session: "s-1", kind: "ui", action: "merge" }];
    sendUsage(batch);
    sendUsage(batch, true);
    expect(posts.length).toBe(1);
    expect(posts[0][0]).toBe("/api/usage");
    expect(posts[0][1]).toMatchObject({ method: "POST", keepalive: true });
    expect(JSON.parse(posts[0][1].body)).toEqual({ session: "s-1", client: "electron", events: batch });
    expect(beacons.length).toBe(1);
    expect(beacons[0][0]).toBe("/api/usage");
    expect(beacons[0][1].type).toStartWith("application/json");
    expect(JSON.parse(await beacons[0][1].text())).toEqual({ session: "s-1", client: "electron", events: batch });
  });
});
