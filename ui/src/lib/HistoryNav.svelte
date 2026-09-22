<script>
  import { history, goBackOrFallback, goForward } from "./history.svelte.js";

  let { backFallback = null } = $props();

</script>

<div class="histnav">
  <button class="arrow" onclick={() => (location.hash = "#/")} title="Home" aria-label="Home">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
    </svg>
  </button>
  <button
    class="arrow"
    disabled={!history.canBack && !backFallback}
    onclick={() => goBackOrFallback(backFallback)}
    title={backFallback ? "Back to inbox" : "Back"}
    aria-label={backFallback ? "Back to inbox" : "Back"}
  >
    <span aria-hidden="true">←</span>
  </button>
  <button class="arrow" disabled={!history.canForward} onclick={goForward} title="Forward" aria-label="Forward">
    <span aria-hidden="true">→</span>
  </button>
</div>

<style>
  .histnav {
    display: flex;
    gap: 3px;
    -webkit-app-region: no-drag;
  }
  .arrow {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 17px;
    cursor: pointer;
    -webkit-app-region: no-drag;
    transition: background 0.08s ease, color 0.08s ease;
  }
  .arrow:hover:not(:disabled) {
    background: var(--panel-raised);
    color: var(--text);
  }
  .arrow:disabled {
    color: var(--text-faint);
    opacity: 0.4;
    cursor: default;
  }
</style>
