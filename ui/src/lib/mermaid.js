import { theme } from "./theme.svelte.js";

let mermaidPromise = null;
let renderSeq = 0;

function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

async function renderAll(node, isStale) {
  const blocks = node.querySelectorAll("pre > code.language-mermaid");
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  if (isStale()) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: theme.name === "light" ? "default" : "dark",
  });
  for (const codeEl of blocks) {
    const pre = codeEl.closest("pre");
    if (!pre?.isConnected) continue;
    const stale = pre.nextElementSibling;
    if (stale?.classList.contains("mermaid-diagram")) stale.remove();
    const source = codeEl.textContent;
    let svg;
    try {
      if (!(await mermaid.parse(source, { suppressErrors: true }))) {
        pre.style.removeProperty("display");
        continue;
      }
      ({ svg } = await mermaid.render(`mermaid-${++renderSeq}`, source));
    } catch {
      pre.style.removeProperty("display");
      continue;
    }
    if (isStale() || !pre.isConnected) return;
    const figure = document.createElement("div");
    figure.className = "mermaid-diagram";
    figure.innerHTML = svg;
    pre.after(figure);
    pre.style.display = "none";
  }
}

export function mermaidDiagrams(node) {
  let seq = 0;
  const schedule = () => {
    const mine = ++seq;
    queueMicrotask(() => {
      if (mine === seq) renderAll(node, () => mine !== seq);
    });
  };
  schedule();
  return { update: schedule };
}
