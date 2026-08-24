<script>
  import { history, goBack, goForward } from "./history.svelte.js";

  let { backFallback = null } = $props();

  function navigateBack() {
    if (backFallback) location.hash = backFallback;
    else if (history.canBack) goBack();
  }

</script>

<div class="histnav">
  <button
    class="arrow"
    disabled={!history.canBack && !backFallback}
    onclick={navigateBack}
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
