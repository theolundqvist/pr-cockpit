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
  // from the as=peek variant (832 px long side, so it stays sharp on Retina).
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
    // The aspect ratio is unknown until the image arrives; showing nothing beats a peek that jumps.
    peek = null;
    const image = new Image();
    image.src = mediaSrc(url, "peek");
    peekLoading = image;
    image.decode().then(() => {
      peekSizes.set(url, [image.naturalWidth, image.naturalHeight]);
      if (peekLoading === image && hovered === stack && !viewer) placePeek(stack, url, peekSizes.get(url));
    }, () => {});
  }

  function placePeek(stack, url, [naturalWidth, naturalHeight]) {
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
    // Fixed descendants of a zoomed #app use pre-zoom coordinates while rects use viewport coordinates.
    peek = { url, width, height, x: left / scale, y: top / scale, originX: (centerX - left) / scale, originY: (centerY - top) / scale };
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
  // Attachment URLs carry no type: an item that fails as an image is retried as a video, then marked failed.
  let kinds = $state({});
  let viewerNode = $state();
  let viewerSeq = 0;
  let prefetch = null;
  let current = $derived(items[index] ?? null);

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

  function step(delta) {
    if (total > 0) index = (index + delta + total) % total;
  }

  // Only the next item loads ahead; everything else waits until it is shown.
  function onShown(url) {
    shownUrl = url;
    const next = items[(items.indexOf(url) + 1) % items.length];
    if (!next || next === url || kinds[next] || prefetch?.url === next) return;
    const image = new Image();
    image.onerror = () => {
      if (!kinds[next]) kinds[next] = "video";
    };
    image.src = mediaSrc(next);
    prefetch = { url: next, image };
  }

  function onViewerClick(event) {
    if (event.target.closest(".mv-step, a")) return;
    if (event.target.closest(".mv-media")) step(1);
    else closeViewer();
  }

  // The viewer owns the keyboard while open, so list shortcuts never act on rows behind it.
  $effect(() => {
    if (!viewer) return;
    const onKey = (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape") closeViewer();
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.metaKey || event.ctrlKey || event.altKey) {
        event.stopImmediatePropagation();
        return;
      }
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
  <img
    class="media-peek"
    src={mediaSrc(peek.url, "peek")}
    alt=""
    style:width="{peek.width}px"
    style:height="{peek.height}px"
    style:translate="{peek.x}px {peek.y}px"
    style:transform-origin="{peek.originX}px {peek.originY}px"
    aria-hidden="true"
  />
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
      <span class="mv-count mono">{index + 1} / {total}</span>
      <span class="mv-close"><Kbd keys="esc" /></span>
    </header>
    <button class="mv-step prev" type="button" aria-label="Previous" disabled={total < 2} onclick={() => step(-1)}><Kbd keys="left" /></button>
    <div class="mv-stage">
      {#if current === null}
        <span class="mv-note">Loading…</span>
      {:else}
        {#each [current] as url (url)}
          {#if kinds[url] === "failed"}
            <a class="mv-note" href={url} target="_blank" rel="noopener">Couldn't load this attachment · open on GitHub</a>
          {:else}
            {#if shownUrl !== url}<span class="mv-note mv-loading">Loading…</span>{/if}
            {#if kinds[url] === "video"}
              <video
                class="mv-media"
                src={mediaSrc(url)}
                autoplay
                muted
                loop
                playsinline
                onloadeddata={() => onShown(url)}
                onerror={() => (kinds[url] = "failed")}
              ></video>
            {:else}
              <img
                class="mv-media"
                src={mediaSrc(url)}
                alt=""
                draggable="false"
                onload={() => onShown(url)}
                onerror={() => (kinds[url] = "video")}
              />
            {/if}
          {/if}
        {/each}
      {/if}
    </div>
    <button class="mv-step next" type="button" aria-label="Next" disabled={total < 2} onclick={() => step(1)}><Kbd keys="right" /></button>
  </div>
{/if}

<style>
  .media-peek {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 30;
    border-radius: 8px;
    background: var(--panel-raised);
    box-shadow: 0 0 0 1px var(--border), 0 12px 32px rgb(0 0 0 / 0.35);
    pointer-events: none;
    animation: peek-grow 120ms var(--ease-out, ease-out);
  }
  @keyframes peek-grow {
    from {
      scale: 0.125;
      opacity: 0.4;
    }
  }
  .media-viewer {
    position: fixed;
    inset: 0;
    z-index: 45;
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) 72px;
    grid-template-rows: auto minmax(0, 1fr);
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
  .mv-count {
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
  }
  .mv-media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
    user-select: none;
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
</style>
