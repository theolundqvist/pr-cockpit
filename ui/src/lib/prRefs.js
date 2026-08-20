const BARE_REF_RE = /(^|[^\w])#(\d+)\b/g;

export function linkifyBareRefs(doc, repo, titleFor) {
  if (!repo) return;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest("code, pre, a")) continue;
    if (node.nodeValue.includes("#")) targets.push(node);
  }
  for (const node of targets) {
    const text = node.nodeValue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(BARE_REF_RE)) {
      const num = m[2];
      const title = titleFor(repo, Number(num));
      const start = m.index + m[1].length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const a = doc.createElement("a");
      a.className = "ref-link";
      if (title) {
        a.setAttribute("href", `#/pr/${repo}/${num}`);
        a.textContent = `${title} #${num}`;
      } else {
        a.setAttribute("href", `https://github.com/${repo}/issues/${num}`);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener");
        a.textContent = `#${num}`;
      }
      frag.appendChild(a);
      last = start + 1 + num.length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}
