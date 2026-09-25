import { marked } from "marked";
import DOMPurify from "dompurify";
import { prIndexRevision, prTitle } from "./prIndex.svelte.js";
import { linkifyBareRefs } from "./prRefs.js";
import { theme } from "./theme.svelte.js";
import { viewer } from "./viewer.svelte.js";
import { HIGHLIGHT_PENDING, codeHl, highlightFencedCode } from "./codeHighlight.svelte.js";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") ?? "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener");
  }
});

const ALERT_LABELS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};
const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br\s*\/?>)?\s*/i;

function styleAlerts(doc) {
  for (const quote of doc.querySelectorAll("blockquote")) {
    const lead = quote.querySelector("p");
    if (!lead) continue;
    const match = lead.innerHTML.match(ALERT_MARKER);
    if (!match) continue;
    const kind = match[1].toUpperCase();
    lead.innerHTML = lead.innerHTML.replace(ALERT_MARKER, "");
    if (!lead.textContent.trim() && !lead.querySelector("*")) lead.remove();
    const label = doc.createElement("div");
    label.className = "callout-label";
    label.textContent = ALERT_LABELS[kind];
    quote.insertBefore(label, quote.firstChild);
    quote.className = `callout callout-${kind.toLowerCase()}`;
  }
}

const GH_IMAGE_HOSTS = new Set(["github.com", "private-user-images.githubusercontent.com", "raw.githubusercontent.com"]);

function proxyImages(doc) {
  for (const img of doc.querySelectorAll("img")) {
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("fetchpriority", "low");
    img.setAttribute("draggable", "false");
    const src = img.getAttribute("src") ?? "";
    let host;
    try {
      host = new URL(src).host;
    } catch {
      continue;
    }
    if (!GH_IMAGE_HOSTS.has(host)) continue;
    img.setAttribute("data-original-src", src);
    img.setAttribute("src", `/api/image?url=${encodeURIComponent(src)}`);
  }
}

const GH_VIDEO_RE = /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+$/i;

const VIDEO_CONTROLS = `<media-control-bar>
  <media-play-button notooltip></media-play-button>
  <media-time-range></media-time-range>
  <media-time-display showduration></media-time-display>
  <media-mute-button notooltip></media-mute-button>
  <media-playback-rate-button notooltip rates="1 1.5 2"></media-playback-rate-button>
  <media-fullscreen-button notooltip></media-fullscreen-button>
</media-control-bar>`;
let mediaChrome;

function videoPlayer(doc, src) {
  mediaChrome ??= import("media-chrome");
  const player = doc.createElement("media-controller");
  const video = doc.createElement("video");
  video.setAttribute("slot", "media");
  video.setAttribute("src", src);
  video.setAttribute("preload", "metadata");
  video.setAttribute("playsinline", "");
  player.append(video);
  player.insertAdjacentHTML("beforeend", VIDEO_CONTROLS);
  return player;
}

export function imageFallback(node) {
  const replace = (element, src) => {
    const chip = document.createElement("a");
    chip.className = "broken-img mono";
    chip.href = src;
    chip.target = "_blank";
    chip.rel = "noopener";
    chip.textContent = "⤷ image";
    element.replaceWith(chip);
  };
  const failed = (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !node.contains(img)) return;
    const original = img.dataset.originalSrc || img.src;
    if (!GH_VIDEO_RE.test(original)) return replace(img, original);
    const player = videoPlayer(document, img.src);
    player.querySelector("video").addEventListener("error", () => replace(player, original), { once: true });
    img.replaceWith(player);
  };
  node.addEventListener("error", failed, true);
  for (const img of node.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth === 0) failed({ target: img });
  }
  return { destroy: () => node.removeEventListener("error", failed, true) };
}

// GitHub renders an uploaded video as its bare attachment URL on its own line.
function embedVideos(doc) {
  for (const p of doc.querySelectorAll("p")) {
    const a = p.firstElementChild;
    const href = a?.getAttribute("href") ?? "";
    if (a?.tagName !== "A" || p.childElementCount !== 1 || !GH_VIDEO_RE.test(href) || p.textContent.trim() !== href) continue;
    p.replaceWith(videoPlayer(doc, `/api/image?url=${encodeURIComponent(href)}`));
  }
}

const GIF_RE = /\.gif$/i;

// GIFs play as looping video so they can be paused and scrubbed; the server transcodes them.
function embedGifs(doc) {
  for (const img of doc.querySelectorAll("img[data-original-src]")) {
    if (!GIF_RE.test(img.getAttribute("alt") ?? "") && !GIF_RE.test(new URL(img.dataset.originalSrc).pathname)) continue;
    const player = videoPlayer(doc, `${img.getAttribute("src")}&as=video`);
    const video = player.querySelector("video");
    for (const flag of ["autoplay", "muted", "loop"]) video.setAttribute(flag, "");
    video.dataset.gifSrc = img.getAttribute("src");
    video.dataset.gifAlt = img.getAttribute("alt") ?? "";
    const link = img.parentElement?.tagName === "A" && img.parentElement.childNodes.length === 1 ? img.parentElement : null;
    (link ?? img).replaceWith(player);
  }
}

document.addEventListener("error", (event) => {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement) || !video.dataset.gifSrc) return;
  const img = document.createElement("img");
  img.src = video.dataset.gifSrc;
  img.alt = video.dataset.gifAlt;
  video.closest("media-controller")?.replaceWith(img);
}, true);

// A player's tooltips measure layout on every media state change, so they stay off until the
// pointer or focus first reaches that player.
function enableTooltips(event) {
  const player = event.target.closest?.("media-controller");
  if (!player) return;
  for (const button of player.querySelectorAll("[notooltip]")) button.removeAttribute("notooltip");
}
document.addEventListener("pointerover", enableTooltips, true);
document.addEventListener("focus", enableTooltips, true);

const MARKDOWN_CACHE_MAX = 400;
const markdownCache = new Map();

function cachedMarkdown(source, context) {
  const cached = markdownCache.get(source);
  if (!cached || cached.context !== context) return null;
  markdownCache.delete(source);
  markdownCache.set(source, cached);
  return cached.html;
}

function storeMarkdown(source, context, html) {
  markdownCache.set(source, { context, html });
  if (markdownCache.size > MARKDOWN_CACHE_MAX) markdownCache.delete(markdownCache.keys().next().value);
  return html;
}

const REF_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)(?:[#?].*)?$/;

function linkifyRefs(doc) {
  for (const a of doc.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    const match = href.match(REF_RE);
    if (!match) continue;
    if (a.textContent.trim() !== href.trim()) continue;
    const [, owner, repo, kind, num] = match;
    if (kind === "pull") {
      const title = prTitle(`${owner}/${repo}`, Number(num));
      a.textContent = title ? `${title} #${num}` : `${owner}/${repo}#${num}`;
      a.setAttribute("href", `#/pr/${owner}/${repo}/${num}`);
      a.removeAttribute("target");
      a.removeAttribute("rel");
    } else {
      a.textContent = `${owner}/${repo}#${num}`;
    }
    a.classList.add("ref-link");
  }
}

function currentRepo() {
  const m = location.hash.match(/^#\/pr\/([^/]+)\/([^/]+)(?:\/|$)/);
  return m ? `${m[1]}/${m[2]}` : null;
}


const MENTION_RE = /(^|[^\w@/])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g;

function highlightMentions(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest("code, pre, a")) continue;
    if (node.nodeValue.includes("@")) targets.push(node);
  }
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(MENTION_RE)) {
      const start = m.index + m[1].length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const span = doc.createElement("span");
      const isSelf = viewer.login != null && m[2].toLowerCase() === viewer.login.toLowerCase();
      span.className = isSelf ? "mention mention-self" : "mention";
      span.textContent = `@${m[2]}`;
      frag.appendChild(span);
      last = start + 1 + m[2].length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}

// Returns false while any block's tokens are still being computed.
function highlightCodeBlocks(doc) {
  const blocks = doc.querySelectorAll("pre code");
  let complete = true;
  if (!blocks.length) return complete;
  const themeName = theme.shiki;
  for (const codeEl of blocks) {
    const fenceLang = (codeEl.className || "").match(/language-(\S+)/)?.[1];
    const lines = highlightFencedCode(codeEl.textContent.replace(/\n$/, ""), fenceLang, themeName);
    if (lines === HIGHLIGHT_PENDING) complete = false;
    if (!Array.isArray(lines)) continue;
    codeEl.textContent = "";
    lines.forEach((tokens, i) => {
      if (i > 0) codeEl.appendChild(doc.createTextNode("\n"));
      for (const token of tokens) {
        const span = doc.createElement("span");
        span.style.color = token.color;
        span.textContent = token.content;
        codeEl.appendChild(span);
      }
    });
  }
  return complete;
}

export function renderMarkdown(source) {
  if (!source) return "";
  void codeHl.revision;
  const context = `${theme.shiki}\u0000${viewer.login ?? ""}\u0000${currentRepo() ?? ""}\u0000${prIndexRevision()}`;
  const cached = cachedMarkdown(source, context);
  if (cached !== null) return cached;
  const clean = DOMPurify.sanitize(marked.parse(source));
  const doc = new DOMParser().parseFromString(clean, "text/html");
  styleAlerts(doc);
  proxyImages(doc);
  embedVideos(doc);
  embedGifs(doc);
  linkifyRefs(doc);
  linkifyBareRefs(doc, currentRepo(), prTitle);
  highlightMentions(doc);
  if (!highlightCodeBlocks(doc)) return doc.body.innerHTML;
  return storeMarkdown(source, context, doc.body.innerHTML);
}

const SUMMARY_CACHE_MAX = 2000;
const summaryCache = new Map();

export function summarize(source) {
  if (!source) return "";
  const cached = summaryCache.get(source);
  if (cached !== undefined) {
    summaryCache.delete(source);
    summaryCache.set(source, cached);
    return cached;
  }
  const doc = new DOMParser().parseFromString(marked.parse(source), "text/html");
  for (const node of doc.querySelectorAll("script, style, template")) node.remove();
  const text = doc.body.textContent.replace(/\s+/g, " ").trim();
  const summary = text || doc.body.querySelector("img")?.getAttribute("alt")?.trim() || "(image)";
  summaryCache.set(source, summary);
  if (summaryCache.size > SUMMARY_CACHE_MAX) summaryCache.delete(summaryCache.keys().next().value);
  return summary;
}
