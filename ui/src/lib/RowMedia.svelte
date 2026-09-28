<script>
  import { lazyThumbnail } from "./rowMedia.js";

  let { urls, count } = $props();
</script>

<!-- The deck's size depends only on how many cards it holds, so loading never shifts the row. -->
<span class="row-media" title={`${count} ${count === 1 ? "attachment" : "attachments"} in the description`}>
  <span class="deck" style:--cards={urls.length}>
    {#each urls as url, index (url)}
      <span class="card" style:--index={index}>
        <img alt="" width="52" height="32" decoding="async" draggable="false" use:lazyThumbnail={`/api/image?as=thumb&url=${encodeURIComponent(url)}`} />
      </span>
    {/each}
  </span>
  {#if count > urls.length}<span class="more mono">+{count - urls.length}</span>{/if}
</span>

<style>
  .row-media {
    flex: none;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
  }
  .deck {
    position: relative;
    width: calc(52px + (var(--cards) - 1) * 8px);
    height: 32px;
    contain: size layout;
  }
  /* Later cards sit behind the first, peeking out to the right like a fanned deck. */
  .card {
    position: absolute;
    top: 0;
    left: calc(var(--index) * 8px);
    z-index: calc(3 - var(--index));
    width: 52px;
    height: 32px;
    overflow: hidden;
    border-radius: 5px;
    background: var(--panel-raised);
    box-shadow: 0 0 0 1px var(--border), -2px 0 5px rgb(0 0 0 / 0.22);
    transform: rotate(calc(var(--index) * 5deg)) scale(calc(1 - var(--index) * 0.1));
    transform-origin: right center;
  }
  .card img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .card img:not([src]),
  .card img[data-failed] {
    visibility: hidden;
  }
  .more {
    min-width: 22px;
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
