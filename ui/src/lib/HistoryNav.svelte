<script>
  import { history, goBack, goForward } from "./history.svelte.js";
  import { isTypingTarget } from "./dom.js";

  $effect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "H") {
        goBack();
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
  <button class="arrow" disabled={!history.canBack} onclick={goBack} title="Back (⇧H)" aria-label="Back">←</button>
  <button class="arrow" disabled={!history.canForward} onclick={goForward} title="Forward (⇧L)" aria-label="Forward">→</button>
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
