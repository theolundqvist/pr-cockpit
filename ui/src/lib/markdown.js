import { marked } from "marked";
import DOMPurify from "dompurify";
import { prTitle } from "./prIndex.svelte.js";
import { linkifyBareRefs } from "./prRefs.js";
import { theme } from "./theme.svelte.js";
import { viewer } from "./viewer.svelte.js";
import { highlightFencedCode } from "./codeHighlight.svelte.js";

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

const GH_IMAGE_HOSTS = new Set(["github.com", "private-user-images.githubusercontent.com"]);

function proxyImages(doc) {
  for (const img of doc.querySelectorAll("img")) {
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

function highlightCodeBlocks(doc) {
  const blocks = doc.querySelectorAll("pre code");
  if (!blocks.length) return;
  const themeName = theme.shiki;
  for (const codeEl of blocks) {
    const fenceLang = (codeEl.className || "").match(/language-(\S+)/)?.[1];
    const lines = highlightFencedCode(codeEl.textContent.replace(/\n$/, ""), fenceLang, themeName);
    if (!lines) continue;
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
}

export function renderMarkdown(source) {
  if (!source) return "";
  const clean = DOMPurify.sanitize(marked.parse(source));
  const doc = new DOMParser().parseFromString(clean, "text/html");
  styleAlerts(doc);
  proxyImages(doc);
  linkifyRefs(doc);
  linkifyBareRefs(doc, currentRepo(), prTitle);
  highlightMentions(doc);
  highlightCodeBlocks(doc);
  return doc.body.innerHTML;
}

export function summarize(source) {
  if (!source) return "";
  const doc = new DOMParser().parseFromString(renderMarkdown(source), "text/html");
  const text = doc.body.textContent.replace(/\s+/g, " ").trim();
  if (text) return text;
  const alt = doc.body.querySelector("img")?.getAttribute("alt")?.trim();
  return alt || "(image)";
}
