import { isTypingTarget } from "./dom.js";

/** What usage stats take as a name, the relay's pattern; every action and value sent matches it. */
const NAME_CHARS = /[^a-z0-9:._/+-]/g;
/** An id or data-area that can name a place or control; one with digits names a record, not the app's markup. */
const ID = /^[a-z][a-z-]*$/;
/** Rendered markdown: everything in it, ids, data attributes and words included, is what someone wrote. */
const USER_CONTENT = ".md";
/** A row of a list, whose words are a PR's title, a file's path or a comment: named by its kind, never by them. */
const ROW = ".row, .comment, [data-issue-comment-id], [data-review-id], [data-result-key], [role=row], [role=option], [role=treeitem], li";
/** Classes a row carries for its state, not its kind. */
const STATE_CLASS = /^(active|selected|open|on|busy|hovered|unread|clickable|current|compact|dragging|disabled)$/;
/** What a click counts on; checkboxes and radios count on change, with their value. */
const CONTROL =
  "button, a[href], [role=button], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], summary, input[type=button], input[type=submit]";
/** Keys a shortcut can end in, by the names the relay takes. */
const KEYS = {
  "/": "slash",
  "?": "question",
  ".": "period",
  ",": "comma",
  ";": "semicolon",
  "'": "quote",
  "[": "bracket-left",
  "]": "bracket-right",
  "=": "equal",
  "+": "plus",
  "-": "minus",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  " ": "space",
  Home: "home",
  End: "end",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Backspace: "backspace",
  Delete: "delete",
};
const SESSION_KEY = "cockpit:usage-session";
const BATCH = 50;
const KEY_REPEAT_MS = 5_000;

/** Text as part of a name, Morf-style: lower case, words joined by -, 30 characters at most. */
const slug = (text) =>
  text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 30).replace(/-+$/, "");
const asName = (text) => text.toLowerCase().replace(NAME_CHARS, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "control";

const isField = (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;

/** The words a person reads on a control: key hints, icons, hidden parts and fields' contents left out. */
function textOf(node) {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) text += child.nodeValue;
    else if (child.nodeType === 1 && !/^(kbd|svg)$/i.test(child.tagName) && child.getAttribute("aria-hidden") !== "true" && !isField(child)) {
      text += textOf(child);
    }
  }
  return text;
}
const wordsOf = (node) => textOf(node).replace(/\s+/g, " ").trim();

/** A control's label: its aria-label, else its title, else its words (a field's are its label's, never what it holds). */
function labelOf(el) {
  const label = el.getAttribute("aria-label") || el.getAttribute("title") || (isField(el) ? (el.labels?.[0] ? wordsOf(el.labels[0]) : "") : wordsOf(el));
  return label.replace(/\s+/g, " ").trim();
}

/** A label as a name, only when the app's own source writes it; anything else may be someone's words. */
const known = (label, words) => (label && words.has(label) ? slug(label) : "");

/** An id the app's source writes, never one built from data. */
const staticId = (el, words) => {
  const id = el.getAttribute("id");
  return id && ID.test(id) && words.has(id) ? id : "";
};

/** Where an element sits: the nearest element around it with a data-area or a static id, short of the mount point (`#app`) that holds everything. */
function placeOf(el, words) {
  for (let at = el.parentElement; at && at.getAttribute("id") !== "app"; at = at.parentElement) {
    const place = at.getAttribute("data-area") || staticId(at, words);
    if (place) return place;
  }
  return "";
}

const structural = (el) => el.getAttribute("role") || (el.tagName === "INPUT" ? el.type : el.tagName === "A" ? "link" : el.tagName.toLowerCase());

/** A row's kind: its data-event, its role, else its first class that says no state. */
function kindOf(row) {
  const role = row.getAttribute("role");
  if (role === "row" || role === "option" || role === "treeitem") return role;
  const kind = (row.getAttribute("class") ?? "").split(/\s+/).find((name) => ID.test(name) && !name.startsWith("svelte-") && !STATE_CLASS.test(name));
  return row.getAttribute("data-event") || kind || "item";
}

/**
 * The name usage stats count a control by, so a new control counts without code of its own: its data-event, else its static id, else its label when the
 * app's source writes that label (`words`), else what it is (`button`, `link`, `checkbox`). A row of a list is its kind and a control in one is the kind
 * and its own name, so a PR title or file path is never a name. Anything inside rendered markdown is `content-<what it is>`. Prefixed by its place.
 */
export function controlName(el, words) {
  const content = el.closest(USER_CONTENT);
  if (content) {
    const place = placeOf(content, words);
    return asName(`${place ? `${place}:` : ""}content-${structural(el)}`);
  }
  const row = el.closest(ROW);
  const event = el.getAttribute("data-event");
  const own = event || staticId(el, words) || known(labelOf(el), words);
  let name = own || structural(el);
  if (row === el) name = own || kindOf(row);
  else if (row) name = event || `${kindOf(row)}-${own || structural(el)}`;
  const place = placeOf(el, words);
  return asName(place ? `${place}:${name}` : name);
}

/** A keyboard shortcut's name, like `cmd+k`, `shift+m` or `slash`; null for keys no shortcut uses. */
export function keyCombo(event) {
  // Alt on macOS types a symbol in place of the key's letter or digit.
  const key = event.altKey && /^(Key[A-Z]|Digit[0-9])$/.test(event.code ?? "") ? event.code.slice(-1).toLowerCase() : event.key;
  const base = /^[a-zA-Z0-9]$/.test(key) ? key.toLowerCase() : Object.hasOwn(KEYS, key) ? KEYS[key] : null;
  if (!base) return null;
  // A symbol such as ? says shift itself; a capital letter says it even under caps lock.
  const shift = (event.shiftKey && !/^[/?.,;'[\]=+-]$/.test(key)) || /^[A-Z]$/.test(key);
  return `${event.metaKey ? "cmd+" : ""}${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${shift ? "shift+" : ""}${base}`;
}

const randomId = () =>
  crypto.randomUUID?.() ??
  // randomUUID needs a secure context; a cockpit opened by its LAN or VPN address over http has none.
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));

// Screens shown: the route's at depth 0 and flows over it deeper (onboarding, GitHub setup). The deepest, latest shown is the one on screen.
const shown = [];
const running = new Set();
// Shortcut handlers of running usages, behind one capture listener per window that tapKeys installs.
const keyHandlers = new Set();
const tapped = new WeakSet();

/**
 * Installs the window's shortcut listener once. Call it before any component adds its own capture listener: one that stops a key it handled (the
 * cheatsheet's ?, a dialog's Escape) would otherwise hide that key from usage stats.
 */
export function tapKeys(win = window) {
  if (tapped.has(win)) return;
  tapped.add(win);
  win.addEventListener("keydown", (event) => {
    for (const handler of keyHandlers) handler(event);
  }, true);
}
let reporting = false;

function shownScreen() {
  let top = null;
  for (const entry of shown) if (!top || entry.depth >= top.depth) top = entry;
  return top?.name ?? null;
}

/**
 * Shows a screen, by name, to usage stats, running or started later, until the returned function hides it. Changes in one task count once: a flow
 * that swaps its step hides one and shows the next without the screen beneath counting in between.
 */
export function showScreen(name, depth = 0) {
  const entry = { name, depth };
  shown.push(entry);
  const changed = () => {
    if (reporting) return;
    reporting = true;
    queueMicrotask(() => {
      reporting = false;
      const screen = shownScreen();
      if (screen) for (const usage of running) usage.screen(screen);
    });
  };
  changed();
  return () => {
    shown.splice(shown.indexOf(entry), 1);
    changed();
  };
}

/**
 * Usage stats for this window: each screen shown and every click, choice, typed-in field and shortcut on it, by controlName, under the window's session.
 * Listeners see every control, so none needs code of its own. A typed-in field counts once per focus as `typed`, never with what was typed; shortcuts
 * count outside fields, the same one on the same screen at most once per 5 seconds. `send(events, last)` gets batches of 50 at most, every `every` ms
 * or once 50 are queued, and the rest with `last` as the page hides. `stop()` removes every listener and drops what is queued.
 */
export function startUsage({ send, words, every = 10_000, root = document }) {
  let session;
  try {
    session = sessionStorage.getItem(SESSION_KEY);
    if (!session) sessionStorage.setItem(SESSION_KEY, (session = randomId()));
  } catch {
    session = randomId();
  }
  let queue = [];
  let timer = null;
  let screen = null;
  const pressed = new Map();
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (queue.length) send(queue.splice(0, BATCH), false);
  };
  const log = (kind, action, value) => {
    queue.push({ at: Date.now(), session, kind, ...(screen && { screen }), action, ...(value && { value }) });
    if (queue.length >= BATCH) flush();
    else timer ??= setTimeout(flush, every);
  };
  const last = () => {
    clearTimeout(timer);
    timer = null;
    while (queue.length) send(queue.splice(0, BATCH), true);
  };
  // A click counts on the screen it was pressed on, before its handler moves on.
  const onClick = (event) => {
    const el = event.target.closest?.(CONTROL);
    if (el) log("ui", controlName(el, words));
  };
  const onChange = (event) => {
    const el = event.target;
    if (el.tagName === "INPUT" && el.type === "checkbox") log("ui", controlName(el, words), el.checked ? "on" : "off");
    else if (el.tagName === "SELECT") log("ui", controlName(el, words), el.selectedOptions?.[0] && known(wordsOf(el.selectedOptions[0]), words));
    else if (el.tagName === "INPUT" && el.type === "radio") log("ui", controlName(el, words), known(labelOf(el), words));
  };
  const typed = new WeakSet();
  const onFocus = (event) => typed.delete(event.target);
  const onInput = (event) => {
    const el = event.target;
    const typing = el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !/^(checkbox|radio|range|color|file|date|time|button|submit)$/.test(el.type));
    if (!typing || typed.has(el)) return;
    typed.add(el);
    log("ui", controlName(el, words), "typed");
  };
  const onKey = (event) => {
    if (event.repeat || event.isComposing || isTypingTarget(event.target)) return;
    const combo = keyCombo(event);
    if (!combo) return;
    const at = `${screen}\n${combo}`;
    const now = Date.now();
    if (now - (pressed.get(at) ?? -Infinity) < KEY_REPEAT_MS) return;
    pressed.set(at, now);
    log("key", combo);
  };
  const onVisibility = () => document.visibilityState === "hidden" && last();
  root.addEventListener("click", onClick, true);
  root.addEventListener("change", onChange, true);
  root.addEventListener("focusin", onFocus, true);
  root.addEventListener("input", onInput, true);
  tapKeys(window);
  keyHandlers.add(onKey);
  window.addEventListener("pagehide", last);
  document.addEventListener("visibilitychange", onVisibility);
  const usage = {
    /** The screen now showing; counts once it changes. */
    screen(name) {
      if (name === screen) return;
      screen = name;
      log("screen", name);
    },
    /** An outcome a click alone doesn't show. */
    step(action, value) {
      log("step", action, value);
    },
    stop() {
      running.delete(usage);
      clearTimeout(timer);
      timer = null;
      queue = [];
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("change", onChange, true);
      root.removeEventListener("focusin", onFocus, true);
      root.removeEventListener("input", onInput, true);
      keyHandlers.delete(onKey);
      window.removeEventListener("pagehide", last);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
  running.add(usage);
  const now = shownScreen();
  if (now) usage.screen(now);
  return usage;
}
