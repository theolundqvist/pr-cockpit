<script>
  import { history, goBack, goForward } from "./history.svelte.js";
  import { attachHistoryGesture } from "./trackpadNavigation.js";

  const supported = window.cockpitShell?.trackpadNavigationSupported && window.cockpitShell?.onTrackpadNavigationPhase;
  let back = $state(null);
  let forward = $state(null);
  $effect(() => {
    if (!supported || !back || !forward) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    return attachHistoryGesture({
      subscribe: window.cockpitShell.onTrackpadNavigationPhase,
      canNavigate: (direction) => direction === "back" ? history.canBack : history.canForward,
      navigate: (direction) => direction === "back" ? goBack() : goForward(),
      progress: (direction, amount, armed) => {
        for (const [name, node] of [["back", back], ["forward", forward]]) {
          const visible = direction === name;
          const p = visible ? Math.min(1, Math.max(0, amount)) : 0;
          const sign = name === "back" ? 1 : -1;
          node.dataset.armed = String(visible && armed);
          node.style.opacity = visible ? "1" : "0";
          node.style.transition = visible || reduced.matches ? "none" : "transform 160ms ease-out, opacity 160ms ease-out";
          node.style.transform = `translate3d(${sign * (reduced.matches ? 16 : -56 + p * 72)}px, -50%, 0)`;
        }
      },
    });
  });
</script>

{#if supported}
  <div class="gesture-edges" aria-hidden="true">
    <div class="gesture-arrow back" bind:this={back} data-history-gesture="back" data-armed="false">
      <svg viewBox="0 0 24 24"><path d="m13 6-6 6 6 6M7 12h12" /></svg>
    </div>
    <div class="gesture-arrow forward" bind:this={forward} data-history-gesture="forward" data-armed="false">
      <svg viewBox="0 0 24 24"><path d="m11 6 6 6-6 6M17 12H5" /></svg>
    </div>
  </div>
{/if}

<style>
  .gesture-edges { position: fixed; inset: 0 0 0 var(--app-rail-width, 0px); overflow: hidden; pointer-events: none; z-index: 70; }
  .gesture-arrow { position: absolute; top: 50%; display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; background: var(--panel); color: var(--text-dim); box-shadow: var(--shadow-surface); opacity: 0; }
  .back { left: 0; transform: translate3d(-56px, -50%, 0); }
  .forward { right: 0; transform: translate3d(56px, -50%, 0); }
  .gesture-arrow:global([data-armed="true"]) { color: var(--link); }
  svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
