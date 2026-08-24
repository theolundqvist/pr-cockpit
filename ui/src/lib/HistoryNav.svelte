<script>
  import { history, goBack, goForward } from "./history.svelte.js";
  import { isTypingTarget } from "./dom.js";
  import Kbd from "./Kbd.svelte";

  let { backFallback = null } = $props();

  function navigateBack() {
    if (backFallback) location.hash = backFallback;
    else if (history.canBack) goBack();
  }

  $effect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "H") {
        navigateBack();
        e.preventDefault();
      } else if (e.key === "L") {
        goForward();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
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
    {#if history.canBack || backFallback}<Kbd keys={["shift", "h"]} />{/if}
  </button>
  <button class="arrow" disabled={!history.canForward} onclick={goForward} title="Forward" aria-label="Forward">
    <span aria-hidden="true">→</span>
    {#if history.canForward}<Kbd keys={["shift", "l"]} />{/if}
  </button>
</div>

<style>
  .histnav {
    display: flex;
    gap: 3px;
    -webkit-app-region: no-drag;
  }
  .arrow {
    width: auto;
    min-width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 4px;
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
