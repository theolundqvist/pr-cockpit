export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function shouldCopyPrUrl(event) {
  return event.metaKey
    && !event.ctrlKey
    && event.altKey
    && !event.shiftKey
    && event.code === "KeyC";
}

export function shouldCopyPrCockpitUrl(event) {
  return event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.shiftKey
    && event.code === "KeyC";
}

export function prKeyOwner(event) {
  if (!isTypingTarget(event.target)) return "pr";
  if (event.key === "Escape") return "blur";
  if (event.metaKey && (event.key === "," || ["1", "2", "3"].includes(event.key))) return "pr";
  if (shouldCopyPrUrl(event) || shouldCopyPrCockpitUrl(event)) return "pr";
  return "typing";
}

export function imageFallback(node) {
  const replace = (img) => {
    const chip = document.createElement("a");
    chip.className = "broken-img mono";
    chip.href = img.dataset.originalSrc || img.src;
    chip.target = "_blank";
    chip.rel = "noopener";
    chip.textContent = "⤷ image";
    img.replaceWith(chip);
  };
  for (const img of node.querySelectorAll("img")) {
    if (img.complete && img.naturalWidth === 0) replace(img);
    else img.addEventListener("error", () => replace(img), { once: true });
  }
}
