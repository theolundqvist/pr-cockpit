<script>
  import { tick } from "svelte";
  import { DRAFT_PREFIX } from "../../../shared/prGrouping.ts";
  import { fetchPrMedia } from "./api.js";
  import { isTypingTarget } from "./dom.js";
  import Kbd from "./Kbd.svelte";

  // `list` delegates every row's media events, so rows carry no handlers of their own;
  // `prFor` names the PR behind a hovered or clicked `.row-media` stack.
  let { list = null, prFor } = $props();

  // The peek shows the whole front attachment in its own aspect ratio, 8x the 52 px card on its long side,
  // from the as=poster variant (832 px long side, so it stays sharp on Retina). Like the cards it is the first
  // frame; a GIF or video plays only in the viewer.
  const CARD_WIDTH = 52;
  const PEEK_LONG_SIDE = 416;
  const EDGE = 8;
  // A short hover intent keeps a pointer sweeping the list from flashing previews. Once one shows,
  // other stacks switch at once, and the grace keeps it up while the pointer crosses between rows.
  const PEEK_DELAY_MS = 90;
  const PEEK_GRACE_MS = 150;

  const mediaSrc = (url, as = null) => `/api/image?${as ? `as=${as}&` : ""}url=${encodeURIComponent(url)}`;

  let peek = $state.raw(null);
  let peeking = $derived(peek !== null);
  // Natural sizes of peek images already loaded, so a repeat hover opens at its final size at once.
  const peekSizes = new Map();
  let peekLoading = null;
  let hovered = null;
  let peekTimer = 0;

  function showPeek(stack) {
    const url = prFor(stack)?.media?.[0];
    if (!url || viewer || stack.querySelector("img")?.hasAttribute("data-failed")) return;
    if (peekSizes.has(url)) {
      placePeek(stack, url, peekSizes.get(url));
      return;
    }
    // The aspect ratio is unknown until the image arrives, so nothing shows before it and a peek already up
    // stays until its successor is ready: the box never opens at a guessed size and jumps.
    const image = new Image();
    image.src = mediaSrc(url, "poster");
    peekLoading = image;
    image.decode().then(() => {
      peekSizes.set(url, [image.naturalWidth, image.naturalHeight]);
      if (peekLoading === image && hovered === stack && !viewer) placePeek(stack, url, peekSizes.get(url));
    }, () => {
      if (peekLoading === image) hidePeek();
    });
  }

  function placePeek(stack, url, [naturalWidth, naturalHeight]) {
    peekLoading = null;
    const scale = Number.parseFloat(getComputedStyle(stack.closest("#app") ?? document.documentElement).zoom) || 1;
    const long = Math.max(naturalWidth, naturalHeight);
    const fit = Math.min(PEEK_LONG_SIDE / long, (innerWidth / scale - 2 * EDGE) / naturalWidth, (innerHeight / scale - 2 * EDGE) / naturalHeight);
    const width = naturalWidth * fit;
    const height = naturalHeight * fit;
    const rect = stack.getBoundingClientRect();
    const centerX = rect.left + (CARD_WIDTH / 2) * scale;
    const centerY = rect.top + rect.height / 2;
    const left = Math.max(EDGE, Math.min(centerX - (width / 2) * scale, innerWidth - width * scale - EDGE));
    const top = Math.max(EDGE, Math.min(centerY - (height / 2) * scale, innerHeight - height * scale - EDGE));
    // The front card's data-kind (set by lazyThumbnail) marks a GIF or video, which the peek shows with a play glyph.
    const moving = stack.querySelector("img")?.hasAttribute("data-kind") ?? false;
    // Fixed descendants of a zoomed #app use pre-zoom coordinates while rects use viewport coordinates.
    peek = { url, moving, width, height, x: left / scale, y: top / scale, originX: (centerX - left) / scale, originY: (centerY - top) / scale };
  }

  function hidePeek() {
    clearTimeout(peekTimer);
    peekLoading = null;
    peek = null;
  }

  $effect(() => {
    if (!list) return;
    const over = (event) => {
      if (event.pointerType !== "mouse") return;
      const stack = event.target.closest?.(".row-media");
      if (!stack || stack === hovered) return;
      hovered = stack;
      clearTimeout(peekTimer);
      if (peek) showPeek(stack);
      else peekTimer = setTimeout(() => showPeek(stack), PEEK_DELAY_MS);
    };
    const out = (event) => {
      if (!hovered || hovered.contains(event.relatedTarget)) return;
      hovered = null;
      clearTimeout(peekTimer);
      if (peek) peekTimer = setTimeout(hidePeek, PEEK_GRACE_MS);
    };
    // Capture runs before the row link, so a click on the stack opens the viewer instead of the PR.
    const click = (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const stack = event.target.closest?.(".row-media");
      const pr = stack && prFor(stack);
      if (!pr?.media?.length) return;
      event.preventDefault();
      event.stopPropagation();
      openViewer(pr, stack.closest("a.row")?.getAttribute("href"));
    };
    list.addEventListener("pointerover", over);
    list.addEventListener("pointerout", out);
    list.addEventListener("click", click, true);
    return () => {
      list.removeEventListener("pointerover", over);
      list.removeEventListener("pointerout", out);
      list.removeEventListener("click", click, true);
      hovered = null;
      hidePeek();
    };
  });

  // A scrolled or navigated list leaves the peek pointing at the wrong row.
  $effect(() => {
    if (!peeking) return;
    const dismiss = () => {
      hovered = null;
      hidePeek();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("hashchange", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("hashchange", dismiss);
    };
  });

  let viewer = $state.raw(null);
  let items = $state.raw([]);
  let total = $state(0);
  let index = $state(0);
  let shownUrl = $state(null);
  // Attachment URLs carry no type, so each item's poster still is fetched first: it paints at once and its
  // x-media-kind says how to show the item. "gif" and "video" play in <video> (a GIF as the server's MP4); a
  // GIF that cannot convert falls back to "gif-original" in <img>. "unknown" (no poster) tries <img>, then
  // <video>, as the viewer did before posters.
  let kinds = $state({});
  let viewerNode = $state();
  let videoNode = $state();
  let viewerSeq = 0;
  let prefetch = null;
  let current = $derived(items[index] ?? null);
  let playable = $derived(current !== null && (kinds[current] === "gif" || kinds[current] === "video"));

  async function openViewer(pr, rowHref) {
    const seq = ++viewerSeq;
    hovered = null;
    hidePeek();
    viewer = { pr, rowHref };
    items = pr.media;
    total = pr.mediaCount ?? pr.media.length;
    index = 0;
    shownUrl = null;
    kinds = {};
    probes = new Map();
    resetZoom();
    await tick();
    viewerNode?.focus();
    try {
      const media = await fetchPrMedia(pr.repo, pr.number);
      if (seq !== viewerSeq || !media.length) return;
      items = media;
      total = media.length;
    } catch {
      if (seq !== viewerSeq) return;
      total = items.length;
      index = Math.min(index, total - 1);
    }
  }

  function closeViewer(refocus = true) {
    if (!viewer) return;
    const href = viewer.rowHref;
    viewerSeq++;
    viewer = null;
    prefetch = null;
    if (refocus && href) list?.querySelector(`a.row[href="${CSS.escape(href)}"]`)?.focus({ preventScroll: true });
  }

  // One probe per item per opening, shared by the shown item and the prefetch of the next one.
  let probes = new Map();
  function probe(url) {
    let pending = probes.get(url);
    if (pending) return pending;
    const seq = viewerSeq;
    pending = fetch(mediaSrc(url, "poster"))
      .then(async (response) => {
        // Reading the body completes the cache entry the poster and <img> then paint from.
        await response.blob();
        return response.ok ? (response.headers.get("x-media-kind") ?? "image") : "unknown";
      })
      .catch(() => "unknown")
      .then((kind) => {
        if (seq === viewerSeq && !kinds[url]) kinds[url] = kind;
      });
    probes.set(url, pending);
    return pending;
  }

  $effect(() => {
    if (viewer && current) probe(current);
  });

  function step(delta) {
    if (total > 0) index = (index + delta + total) % total;
    resetZoom();
  }

  // Only the next item loads ahead: its kind and still, then its original or playable video. A GIF's MP4
  // conversion starts here, so stepping onto it plays at once; the one-byte range keeps the fetch small.
  async function onShown(url) {
    shownUrl = url;
    const next = items[(items.indexOf(url) + 1) % items.length];
    if (!next || next === url || prefetch?.url === next) return;
    const seq = viewerSeq;
    prefetch = { url: next };
    await probe(next);
    if (seq !== viewerSeq || prefetch?.url !== next) return;
    if (kinds[next] === "gif" || kinds[next] === "video") {
      fetch(mediaSrc(next, "video"), { headers: { range: "bytes=0-0" } }).then((response) => response.body?.cancel(), () => {});
    } else {
      const image = new Image();
      image.src = mediaSrc(next);
      prefetch = { url: next, image };
    }
  }

  // Zoom scales the fitted media about its centre and pans it by `x`/`y` viewport px, so the media never
  // leaves the area it covered at fit. `unit` is the #app zoom, which turns those px into the media's CSS px.
  const MAX_ZOOM = 8;
  let zoom = $state.raw({ scale: 1, x: 0, y: 0, unit: 1 });
  let drag = null;
  let dragged = false;

  function resetZoom() {
    zoom = { scale: 1, x: 0, y: 0, unit: 1 };
  }

  function clampedZoom(scale, x, y, width, height) {
    const maxX = ((scale - 1) * width) / 2;
    const maxY = ((scale - 1) * height) / 2;
    const unit = Number.parseFloat(getComputedStyle(viewerNode?.closest("#app") ?? document.documentElement).zoom) || 1;
    return { scale, x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)), unit };
  }

  // Keeps the point under (px, py) in place while the scale changes by `factor`.
  function zoomAt(factor, px, py) {
    const media = viewerNode?.querySelector(".mv-media");
    if (!media) return;
    const scale = Math.min(MAX_ZOOM, Math.max(1, zoom.scale * factor));
    if (scale === 1) {
      resetZoom();
      return;
    }
    const rect = media.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2 - zoom.x;
    const centerY = rect.top + rect.height / 2 - zoom.y;
    const ratio = scale / zoom.scale;
    zoom = clampedZoom(
      scale,
      px - centerX - (px - centerX - zoom.x) * ratio,
      py - centerY - (py - centerY - zoom.y) * ratio,
      rect.width / zoom.scale,
      rect.height / zoom.scale,
    );
  }

  function zoomStage(factor) {
    const stage = viewerNode?.querySelector(".mv-stage")?.getBoundingClientRect();
    if (stage) zoomAt(factor, stage.left + stage.width / 2, stage.top + stage.height / 2);
  }

  function onStageWheel(event) {
    if (!event.target.closest(".mv-media")) return;
    event.preventDefault();
    // A trackpad pinch arrives as ctrl+wheel with small deltas.
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022)), event.clientX, event.clientY);
  }

  function onMediaPointerDown(event) {
    dragged = false;
    if (event.button !== 0 || zoom.scale === 1) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, width: rect.width / zoom.scale, height: rect.height / zoom.scale };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onMediaPointerMove(event) {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 3) return;
    dragged = true;
    zoom = clampedZoom(zoom.scale, zoom.x + dx, zoom.y + dy, drag.width, drag.height);
    drag = { ...drag, x: event.clientX, y: event.clientY };
  }

  function onMediaPointerUp() {
    drag = null;
  }

  // Playback state of the current <video>; each item mounts a fresh element that autoplays and loops.
  const SPEEDS = [0.5, 1, 2];
  let paused = $state(false);
  let time = $state(0);
  let duration = $state(0);
  let rate = $state(1);
  // One frame, learned from the smallest gap between presented frames; 1/30 s until playback shows two.
  let frame = null;

  function onVideoStart(video) {
    paused = video.paused;
    time = 0;
    duration = 0;
    frame = null;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    let last = null;
    const onFrame = (_now, metadata) => {
      time = metadata.mediaTime;
      if (last !== null && metadata.mediaTime > last) frame = Math.min(frame ?? Infinity, metadata.mediaTime - last);
      last = metadata.mediaTime;
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback?.(onFrame);
  }

  function togglePlay() {
    if (!videoNode) return;
    if (videoNode.paused) void videoNode.play().catch(() => {});
    else videoNode.pause();
  }

  function stepFrame(direction) {
    if (!videoNode) return;
    videoNode.pause();
    videoNode.currentTime = Math.max(0, Math.min(duration || 0, videoNode.currentTime + direction * (frame ?? 1 / 30)));
    time = videoNode.currentTime;
  }

  function setRate(next) {
    rate = next;
    if (!videoNode) return;
    videoNode.defaultPlaybackRate = next;
    videoNode.playbackRate = next;
  }

  function clock(seconds) {
    const whole = Math.max(0, seconds || 0);
    return `${Math.floor(whole / 60)}:${(whole % 60).toFixed(1).padStart(4, "0")}`;
  }

  function onViewerClick(event) {
    if (event.target.closest(".mv-step, .mv-controls, a")) return;
    if (dragged) {
      dragged = false;
      return;
    }
    if (event.target.closest(".mv-media")) {
      // The second click of a double-click belongs to the zoom reset.
      if (event.detail > 1) return;
      if (playable) togglePlay();
      else if (zoom.scale === 1) step(1);
    } else closeViewer();
  }

  // The viewer owns the keyboard while open, so list shortcuts never act on rows behind it.
  $effect(() => {
    if (!viewer) return;
    const onKey = (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      // App shortcuts such as Cmd+0 keep their default but never reach the list.
      else if (event.metaKey || event.ctrlKey || event.altKey) {
        event.stopImmediatePropagation();
        return;
      } else if (event.key === " " && playable) togglePlay();
      else if (event.key === "," && playable) stepFrame(-1);
      else if (event.key === "." && playable) stepFrame(1);
      else if (event.key === "+" || event.key === "=") zoomStage(1.25);
      else if (event.key === "-" || event.key === "_") zoomStage(0.8);
      else if (event.key === "0") resetZoom();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onHash = () => closeViewer(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("hashchange", onHash);
    };
  });
</script>

{#if peek}
  <div
    class="media-peek"
    style:width="{peek.width}px"
    style:height="{peek.height}px"
    style:translate="{peek.x}px {peek.y}px"
    style:transform-origin="{peek.originX}px {peek.originY}px"
    aria-hidden="true"
  >
    <img src={mediaSrc(peek.url, "poster")} alt="" />
    {#if peek.moving}<span class="play-glyph"></span>{/if}
  </div>
{/if}

{#if viewer}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="media-viewer"
    role="dialog"
    aria-modal="true"
    aria-label="Description media for #{viewer.pr.number}"
    tabindex="-1"
    bind:this={viewerNode}
    onclick={onViewerClick}
  >
    <header class="mv-head">
      <span class="mv-title"><span class="mono">#{viewer.pr.number}</span> {viewer.pr.title.startsWith(DRAFT_PREFIX) ? viewer.pr.title.slice(DRAFT_PREFIX.length) : viewer.pr.title}</span>
      {#if zoom.scale > 1}<span class="mv-zoom mono">{Math.round(zoom.scale * 100)}% <Kbd keys="0" label="Reset zoom" /></span>{/if}
      <span class="mv-count mono">{index + 1} / {total}</span>
      <span class="mv-close"><Kbd keys="esc" /></span>
    </header>
    <button class="mv-step prev" type="button" aria-label="Previous" disabled={total < 2} onclick={() => step(-1)}><Kbd keys="left" /></button>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="mv-stage" onwheel={onStageWheel}>
      {#if current === null}
        <span class="mv-note">Loading…</span>
      {:else}
        {#each [current] as url (url)}
          {@const kind = kinds[url]}
          {#if kind === "failed"}
            <a class="mv-note" href={url} target="_blank" rel="noopener">Couldn't load this attachment · open on GitHub</a>
          {:else if kind === undefined}
            <span class="mv-note">Loading…</span>
          {:else}
            {#if shownUrl !== url}<span class="mv-note mv-loading">Loading…</span>{/if}
            {#if kind === "gif" || kind === "video"}
              <video
                class="mv-media"
                class:zoomed={zoom.scale > 1}
                src={mediaSrc(url, "video")}
                poster={mediaSrc(url, "poster")}
                style:transform="translate({zoom.x / zoom.unit}px, {zoom.y / zoom.unit}px) scale({zoom.scale})"
                autoplay
                muted
                loop
                playsinline
                bind:this={videoNode}
                bind:duration
                onloadstart={(event) => onVideoStart(event.currentTarget)}
                onloadeddata={() => onShown(url)}
                onplay={() => (paused = false)}
                onpause={() => (paused = true)}
                onpointerdown={onMediaPointerDown}
                onpointermove={onMediaPointerMove}
                onpointerup={onMediaPointerUp}
                ondblclick={resetZoom}
                onerror={() => (kinds[url] = kind === "gif" ? "gif-original" : "failed")}
              ></video>
            {:else}
              <img
                class="mv-media"
                class:zoomed={zoom.scale > 1}
                src={mediaSrc(url)}
                alt=""
                draggable="false"
                style:transform="translate({zoom.x / zoom.unit}px, {zoom.y / zoom.unit}px) scale({zoom.scale})"
                onload={() => onShown(url)}
                onpointerdown={onMediaPointerDown}
                onpointermove={onMediaPointerMove}
                onpointerup={onMediaPointerUp}
                ondblclick={resetZoom}
                onerror={() => (kinds[url] = kind === "unknown" ? "video" : "failed")}
              />
            {/if}
          {/if}
        {/each}
      {/if}
    </div>
    <button class="mv-step next" type="button" aria-label="Next" disabled={total < 2} onclick={() => step(1)}><Kbd keys="right" /></button>
    {#if playable}
      <div class="mv-controls">
        <button class="mv-play" type="button" aria-label={paused ? "Play" : "Pause"} onclick={togglePlay}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {#if paused}<path d="M5 3.5v9l7.5-4.5z" />{:else}<path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" />{/if}
          </svg>
        </button>
        <span class="mv-time mono">{clock(time)} / {clock(duration)}</span>
        <input
          class="mv-scrub"
          type="range"
          min="0"
          max={duration || 0}
          step="any"
          value={time}
          aria-label="Position"
          oninput={(event) => {
            if (videoNode) videoNode.currentTime = time = Number(event.currentTarget.value);
          }}
        />
        <span class="mv-speeds" role="group" aria-label="Speed">
          {#each SPEEDS as speed (speed)}
            <button class="mv-speed mono" type="button" aria-pressed={rate === speed} onclick={() => setRate(speed)}>{speed}×</button>
          {/each}
        </span>
        <span class="mv-hint"><Kbd keys="space" label="Play or pause" /> <Kbd keys=", / ." label="Previous or next frame" /></span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .media-peek {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 30;
    overflow: hidden;
    border-radius: 8px;
    background: var(--panel-raised);
    box-shadow: 0 0 0 1px var(--border), 0 12px 32px rgb(0 0 0 / 0.35);
    pointer-events: none;
    animation: peek-grow 120ms var(--ease-out, ease-out);
  }
  .media-peek img {
    display: block;
    width: 100%;
    height: 100%;
  }
  @keyframes peek-grow {
    from {
      scale: 0.125;
      opacity: 0.4;
    }
  }
  .play-glyph {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 44px;
    height: 44px;
    margin: -22px 0 0 -22px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.55) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M5.2 3.8v6.4L10.4 7z' fill='white'/%3E%3C/svg%3E") center / 44px no-repeat;
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.35);
  }
  .media-viewer {
    position: fixed;
    inset: 0;
    z-index: 45;
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) 72px;
    grid-template-rows: auto minmax(0, 1fr) auto;
    padding: 44px 0 28px;
    background: rgb(8 10 14 / 0.88);
    color: #e6e8ec;
    outline: none;
  }
  .mv-head {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 24px 14px;
    font-size: 13px;
  }
  .mv-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .mv-count,
  .mv-zoom {
    font-size: 12px;
    color: #aab0bb;
  }
  .mv-stage {
    position: relative;
    grid-row: 2;
    grid-column: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
  }
  .mv-media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
    user-select: none;
    cursor: zoom-in;
  }
  .mv-media.zoomed {
    cursor: grab;
  }
  .mv-media.zoomed:active {
    cursor: grabbing;
  }
  video.mv-media {
    cursor: pointer;
  }
  .mv-note {
    font-size: 13px;
    color: #aab0bb;
  }
  .mv-loading {
    position: absolute;
  }
  /* The side gutters are the step targets, so the media keeps the whole middle. */
  .mv-step {
    grid-row: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 8px;
    background: none;
  }
  .mv-step:hover {
    background: rgb(255 255 255 / 0.06);
  }
  .mv-step.prev {
    grid-column: 1;
  }
  .mv-step.next {
    grid-column: 3;
  }
  .mv-step:disabled {
    visibility: hidden;
  }
  .mv-controls {
    grid-row: 3;
    grid-column: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    width: min(720px, 100%);
    margin: 14px auto 0;
    font-size: 12px;
    color: #aab0bb;
  }
  .mv-controls button {
    border: 0;
    border-radius: 6px;
    background: rgb(255 255 255 / 0.08);
    color: #e6e8ec;
  }
  .mv-controls button:hover {
    background: rgb(255 255 255 / 0.14);
  }
  .mv-play {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
  }
  .mv-play svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }
  .mv-time {
    min-width: 92px;
  }
  .mv-scrub {
    flex: 1;
    min-width: 0;
    accent-color: #e6e8ec;
  }
  .mv-speeds {
    display: flex;
    gap: 4px;
  }
  .mv-speed {
    padding: 4px 7px;
    font-size: 11px;
  }
  .mv-controls .mv-speed[aria-pressed="true"] {
    background: #e6e8ec;
    color: #111318;
  }
  .mv-hint {
    display: flex;
    gap: 6px;
  }
</style>
