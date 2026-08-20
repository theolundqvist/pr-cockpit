<script>
  let src = $state(null);
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let nw = $state(0);
  let nh = $state(0);
  let drag = null;

  function openFrom(img) {
    if (!img.naturalWidth || !img.naturalHeight) return;
    nw = img.naturalWidth;
    nh = img.naturalHeight;
    const fit = Math.min((innerWidth * 0.94) / nw, (innerHeight * 0.94) / nh);
    scale = Math.min((img.getBoundingClientRect().width * 1.75) / nw, fit);
    tx = (innerWidth - nw * scale) / 2;
    ty = (innerHeight - nh * scale) / 2;
    src = img.currentSrc || img.src;
  }

  function onDocClick(e) {
    if (src !== null) return;
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.closest(".md")) return;
    e.preventDefault();
    openFrom(img);
  }

  function onKey(e) {
    if (src === null || e.key !== "Escape") return;
    e.stopPropagation();
    src = null;
  }

  // the overlay outlives the PR view it was opened from, so a route change must dismiss it
  function onNavigate() {
    src = null;
  }

  $effect(() => {
    document.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("hashchange", onNavigate);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("hashchange", onNavigate);
    };
  });

  function onWheel(e) {
    e.preventDefault();
    const next = Math.min(8, Math.max(0.1, scale * Math.exp(-e.deltaY * 0.0022)));
    tx = e.clientX - ((e.clientX - tx) * next) / scale;
    ty = e.clientY - ((e.clientY - ty) * next) / scale;
    scale = next;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!drag) return;
    tx += e.clientX - drag.x;
    ty += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY, moved: true };
  }

  function onPointerUp(e) {
    const moved = drag?.moved;
    drag = null;
    if (!moved && e.target.tagName !== "IMG") src = null;
  }
</script>

{#if src !== null}
  <div
    class="lightbox"
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
  >
    <img {src} alt="" draggable="false" style="width: {nw}px; height: {nh}px; transform: translate({tx}px, {ty}px) scale({scale});" />
  </div>
{/if}

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 200;
    overflow: hidden;
    background: rgba(8, 10, 14, 0.82);
    cursor: grab;
    touch-action: none;
  }
  .lightbox:active {
    cursor: grabbing;
  }
  .lightbox img {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    max-width: none;
    user-select: none;
  }
</style>
