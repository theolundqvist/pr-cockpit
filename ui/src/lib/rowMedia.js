// Queue thumbnails load only while their row is near the viewport and unload once it scrolls away. A hidden
// list keeps its sources: nothing paints there, and showing it again must not reload every thumbnail. A few
// loads run at once, so first-time conversions never hold every connection the API needs.
// Every card is a still, even for a GIF or video: dozens of looping cards kept the compositor redrawing the
// idle list. The response's x-media-kind names the source, and a card from a GIF or video carries
// data-kind so its stack can show a play glyph.
const MAX_LOADING = 3;
const pending = [];
const loading = new Map();
const sources = new WeakMap();
const objectUrls = new WeakMap();
let observer;

function pump() {
  while (loading.size < MAX_LOADING && pending.length) void load(pending.shift());
}

async function load(img) {
  const controller = new AbortController();
  loading.set(img, controller);
  try {
    const response = await fetch(sources.get(img), { signal: controller.signal });
    if (!response.ok) throw new Error(`thumbnail ${response.status}`);
    const blob = await response.blob();
    if (controller.signal.aborted) return;
    const kind = response.headers.get("x-media-kind");
    if (kind === "gif" || kind === "video") img.dataset.kind = kind;
    else delete img.dataset.kind;
    delete img.dataset.failed;
    const url = URL.createObjectURL(blob);
    objectUrls.set(img, url);
    img.src = url;
  } catch {
    if (!controller.signal.aborted) img.dataset.failed = "";
  } finally {
    if (loading.get(img) === controller) {
      loading.delete(img);
      pump();
    }
  }
}

function show(img) {
  if (img.hasAttribute("src") || loading.has(img) || pending.includes(img)) return;
  pending.push(img);
  pump();
}

function hide(img) {
  const index = pending.indexOf(img);
  if (index >= 0) pending.splice(index, 1);
  const controller = loading.get(img);
  if (controller) {
    controller.abort();
    loading.delete(img);
    pump();
  }
  img.removeAttribute("src");
  const url = objectUrls.get(img);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(img);
  }
}

export function lazyThumbnail(img, src) {
  sources.set(img, src);
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) show(entry.target);
      else if (entry.target.getClientRects().length) hide(entry.target);
    }
  }, { rootMargin: "240px 0px" });
  // A fetched card can still fail to decode.
  const failed = () => {
    if (img.hasAttribute("src")) img.dataset.failed = "";
  };
  img.addEventListener("error", failed);
  observer.observe(img);
  return {
    update(next) {
      if (next === sources.get(img)) return;
      const shown = img.hasAttribute("src") || loading.has(img);
      hide(img);
      sources.set(img, next);
      if (shown) show(img);
    },
    destroy() {
      observer.unobserve(img);
      hide(img);
      img.removeEventListener("error", failed);
    },
  };
}
