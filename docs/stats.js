// Site counts, described in the README's "Usage statistics": a random id for this tab only
// (sessionStorage, no cookies or lasting storage), where the visit came from (utm_source or the
// referring host), the OS family, and the names of links and buttons pressed. Never typed or selected
// text. Do Not Track and Global Privacy Control turn it off.
(() => {
  const RELAY = "https://relay.prcockpit.com/events";
  const NAME = /^[a-z0-9][a-z0-9:._/+-]{0,63}$/;
  window.prcStats = { step() {}, flush() {} };
  if (navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true || navigator.webdriver) return;
  if (location.protocol !== "https:" || !crypto.randomUUID) return;
  let anon;
  try {
    anon = sessionStorage.getItem("prc-tab");
    if (!anon) sessionStorage.setItem("prc-tab", (anon = crypto.randomUUID()));
  } catch {
    return;
  }
  const slug = (text) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const agent = navigator.userAgent;
  const platform = /Windows/.test(agent) ? "windows" : /Macintosh/.test(agent) ? "darwin" : /Linux/.test(agent) && !/Android/.test(agent) ? "linux" : "other";
  const page = slug(location.pathname) || "home";
  const queue = [];
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    while (queue.length) {
      const body = JSON.stringify({ anon, surface: "site", platform, events: queue.splice(0, 50) });
      if (!navigator.sendBeacon?.(RELAY, body)) fetch(RELAY, { method: "POST", body, keepalive: true, mode: "no-cors" }).catch(() => {});
    }
  };
  const log = (kind, action, value) => {
    if (!NAME.test(action)) return;
    queue.push({ at: Date.now(), session: anon, kind, screen: page, action, ...(value && NAME.test(value) ? { value } : {}) });
    timer ??= setTimeout(flush, 5_000);
  };
  window.prcStats = { step: (action, value) => log("step", action, value), flush };
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.hidden && flush());

  // The visit, once per tab: its campaign source, else the site that linked here, else direct.
  try {
    if (!sessionStorage.getItem("prc-visit")) {
      sessionStorage.setItem("prc-visit", "1");
      const campaign = new URLSearchParams(location.search).get("utm_source");
      const from = document.referrer ? new URL(document.referrer) : null;
      const source = campaign ? slug(campaign) : from && from.host !== location.host ? from.hostname.replace(/^www\./, "") : "direct";
      log("step", "visit", source);
    }
  } catch {}
  log("screen", page);

  // A control is named by data-event, else its id, else where a link goes, else its label: the site's
  // own words, since nothing on these pages comes from a visitor.
  const controlName = (el) => {
    if (el.dataset.event) return el.dataset.event;
    if (el.id) return slug(el.id);
    if (el.matches("a[href]")) {
      const url = new URL(el.href, location.href);
      if (url.origin !== location.origin) return /^https?:$/.test(url.protocol) ? `out:${url.hostname.replace(/^www\./, "")}` : "out:app";
      return `to:${slug(url.hash || url.pathname) || "home"}`;
    }
    const where = el.closest("[id]");
    const label = slug(el.getAttribute("aria-label") || el.textContent || el.tagName);
    return where ? `${slug(where.id)}:${label}` : label;
  };
  document.addEventListener("click", (event) => {
    const el = event.target.closest?.("a[href], button, summary");
    if (el) log("ui", controlName(el));
  }, true);
  // Copying the command by hand counts like the copy button.
  document.addEventListener("copy", () => {
    const node = document.getSelection()?.anchorNode;
    const at = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (at?.closest(".install-command, .code-block")) log("step", "copy-install", "manual");
  });
  const install = document.getElementById("install");
  if (install && "IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      log("step", "saw-install");
    }, { threshold: 0.5 });
    seen.observe(install);
  }
})();
