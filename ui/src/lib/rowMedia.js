// Queue thumbnails load only while their row is near the viewport and unload once it scrolls away, which
// also stops animations nobody can see. A hidden list keeps its sources: nothing paints there, and showing
// it again must not reload every thumbnail. A few loads run at once, so first-time conversions never hold
// every connection the API needs.
const MAX_LOADING = 3;
const pending = [];
const loading = new Set();
const sources = new WeakMap();
let observer;

function pump() {
  while (loading.size < MAX_LOADING && pending.length) {
    const img = pending.shift();
    loading.add(img);
    img.src = sources.get(img);
  }
}

function settle(img) {
  if (loading.delete(img)) pump();
}

function show(img) {
  if (img.hasAttribute("src") || pending.includes(img)) return;
  pending.push(img);
  pump();
}

function hide(img) {
  const index = pending.indexOf(img);
  if (index >= 0) pending.splice(index, 1);
  img.removeAttribute("src");
  settle(img);
}

export function lazyThumbnail(img, src) {
  sources.set(img, src);
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) show(entry.target);
      else if (entry.target.getClientRects().length) hide(entry.target);
    }
  }, { rootMargin: "240px 0px" });
  const loaded = () => {
    delete img.dataset.failed;
    settle(img);
  };
  const failed = () => {
    img.dataset.failed = "";
    settle(img);
  };
  img.addEventListener("load", loaded);
  img.addEventListener("error", failed);
  observer.observe(img);
  return {
    update(next) {
      if (next === sources.get(img)) return;
      sources.set(img, next);
      if (img.hasAttribute("src")) img.src = next;
    },
    destroy() {
      observer.unobserve(img);
      hide(img);
      img.removeEventListener("load", loaded);
      img.removeEventListener("error", failed);
    },
  };
}
