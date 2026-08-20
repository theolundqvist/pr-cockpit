const STEP = 140;
const PAGE_MARGIN = 60;
const EASE = 0.18;
const SNAP_PX = 1;

const animators = new WeakMap();

function animateTo(el, target) {
  const max = el.scrollHeight - el.clientHeight;
  target = Math.max(0, Math.min(max, target));
  const existing = animators.get(el);
  if (existing) {
    existing.target = target;
    return;
  }
  const a = { target, raf: 0 };
  animators.set(el, a);
  const tick = () => {
    const dist = a.target - el.scrollTop;
    if (Math.abs(dist) <= SNAP_PX) {
      el.scrollTop = a.target;
      animators.delete(el);
      return;
    }
    const move = dist * EASE;
    el.scrollTop += Math.abs(move) < 1 ? Math.sign(dist) : move;
    a.raf = requestAnimationFrame(tick);
  };
  a.raf = requestAnimationFrame(tick);
}

function targetOf(el) {
  return animators.get(el)?.target ?? el.scrollTop;
}

export function scrollStep(el, dir) {
  if (!el) return;
  animateTo(el, targetOf(el) + dir * STEP);
}

export function scrollPage(el, dir) {
  if (!el) return;
  animateTo(el, targetOf(el) + dir * (el.clientHeight - PAGE_MARGIN));
}

export function scrollEdge(el, edge) {
  if (!el) return;
  const a = animators.get(el);
  if (a) {
    cancelAnimationFrame(a.raf);
    animators.delete(el);
  }
  el.scrollTo({ top: edge === "top" ? 0 : el.scrollHeight, behavior: "auto" });
}

// caller drives start/release from button-down/button-up state, not per-keydown jumps
const HOLD_MAX_SPEED = 3200; // px/s, applied instantly on press
const HOLD_DECEL_TIME = 0.2; // s to decay to a stop after release
const MIN_TAP_STEP = 140; // px guaranteed even for a press released within one frame

const holders = new WeakMap();

export function holdScrollStart(el, dir) {
  if (!el) return;
  const a = animators.get(el);
  if (a) {
    cancelAnimationFrame(a.raf);
    animators.delete(el);
  }
  const existing = holders.get(el);
  if (existing && existing.dir === dir) {
    if (!existing.releasing) return;
    existing.releasing = false;
    existing.velocity = HOLD_MAX_SPEED;
    existing.startTop = existing.pos;
    existing.moved = 0;
    return;
  }
  if (existing) cancelAnimationFrame(existing.raf);
  const h = { dir, velocity: HOLD_MAX_SPEED, releasing: false, lastT: performance.now(), dtEMA: undefined, raf: 0, pos: el.scrollTop, startTop: el.scrollTop, moved: 0 };
  holders.set(el, h);
  const tick = (t) => {
    // clamp: the first rAF timestamp can predate lastT, and a negative dt scrolls against the key
    const rawDt = Math.max(0, (t - h.lastT) / 1000);
    h.lastT = t;
    let dt;
    if (rawDt > 0.05) {
      dt = h.dtEMA ?? rawDt;
    } else {
      dt = h.dtEMA === undefined ? rawDt : (h.dtEMA * 7 + rawDt) / 8;
      h.dtEMA = dt;
    }
    if (h.releasing) {
      h.velocity = Math.max(0, h.velocity - (HOLD_MAX_SPEED / HOLD_DECEL_TIME) * dt);
    }
    const max = el.scrollHeight - el.clientHeight;
    const prevPos = h.pos;
    h.pos = Math.max(0, Math.min(max, h.pos + h.dir * h.velocity * dt));
    el.scrollTop = Math.round(h.pos);
    h.moved += Math.abs(h.pos - prevPos);
    if (h.releasing && h.velocity <= 0.5) {
      if (h.moved < MIN_TAP_STEP) animateTo(el, h.startTop + h.dir * MIN_TAP_STEP);
      holders.delete(el);
      return;
    }
    h.raf = requestAnimationFrame(tick);
  };
  h.raf = requestAnimationFrame(tick);
}

export function holdScrollRelease(el) {
  const h = holders.get(el);
  if (h) h.releasing = true;
}

export function scrollAnimating(el) {
  return holders.has(el) || animators.has(el);
}

export function cancelHoldScroll(el) {
  const h = holders.get(el);
  if (!h) return;
  cancelAnimationFrame(h.raf);
  holders.delete(el);
}
