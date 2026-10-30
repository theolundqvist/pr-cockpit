const INTENT = 10;
const THRESHOLD = 60;
const DOMINANCE = 2.5;

function editing(target) {
  return target instanceof Element && !!target.closest("input, textarea, [contenteditable]:not([contenteditable=false]), [role=searchbox], [role=dialog], [role=application]");
}

function scrollsHorizontally(event) {
  return event.composedPath().some((node) => {
    if (!(node instanceof HTMLElement) || node.scrollWidth - node.clientWidth <= 1) return false;
    return ["auto", "scroll"].includes(getComputedStyle(node).overflowX);
  });
}

export function attachHistoryGesture({ subscribe, canNavigate, navigate, progress }) {
  let active = false;
  let blocked = false;
  let x = 0;
  let y = 0;
  let checkedTarget = false;
  const direction = () => x < 0 ? "back" : "forward";
  const horizontal = () => Math.abs(x) > Math.abs(y) * DOMINANCE;
  const hide = (immediate = false) => progress(null, 0, false, immediate);
  const stopWheel = () => window.removeEventListener("wheel", wheel, true);
  function block() {
    blocked = true;
    stopWheel();
    hide();
  }
  function cancel() {
    active = false;
    block();
  }
  function wheel(event) {
    if (!active || blocked) return;
    if (event.defaultPrevented || event.deltaMode !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey
      || editing(document.activeElement) || event.composedPath().some(editing)) return block();
    x += event.deltaX;
    y += event.deltaY;
    // Vertical scrolling leaves the gesture path immediately: no DOM measurements,
    // indicator updates, or blocking wheel listener for the remainder of that gesture.
    if (Math.abs(y) > INTENT && Math.abs(y) >= Math.abs(x)) return block();
    if (Math.abs(x) <= INTENT || !horizontal()) return hide();
    if (!checkedTarget) {
      checkedTarget = true;
      if (scrollsHorizontally(event)) return block();
    }
    const next = direction();
    if (!canNavigate(next)) return hide();
    event.preventDefault();
    progress(next, (Math.abs(x) - INTENT) / (THRESHOLD - INTENT), Math.abs(x) >= THRESHOLD);
  }
  const unsubscribe = subscribe((phase) => {
    if (phase === "begin") {
      if (active) return;
      x = y = 0;
      checkedTarget = false;
      active = true;
      blocked = editing(document.activeElement) || [...document.querySelectorAll('[role="dialog"], .prompt-overlay, .scrim')]
        .some((node) => node.checkVisibility());
      hide();
      if (!blocked) window.addEventListener("wheel", wheel, { capture: true, passive: false });
    } else {
      const next = direction();
      const commit = phase === "end" && active && !blocked && !editing(document.activeElement)
        && horizontal() && Math.abs(x) >= THRESHOLD && canNavigate(next);
      cancel();
      if (commit) {
        hide(true);
        navigate(next);
      }
    }
  });
  const focus = (event) => { if (active && editing(event.target)) block(); };
  const key = (event) => { if (event.key === "Escape") cancel(); };
  document.addEventListener("focusin", focus);
  window.addEventListener("keydown", key);
  window.addEventListener("blur", cancel);
  window.addEventListener("hashchange", cancel);
  return () => {
    unsubscribe();
    cancel();
    document.removeEventListener("focusin", focus);
    window.removeEventListener("keydown", key);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("hashchange", cancel);
  };
}
