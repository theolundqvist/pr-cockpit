<script>
  import { fetchUpdateAvailable, triggerUpdate } from "./api.js";
  import { showFlash } from "./flash.svelte.js";

  let available = $state(false);
  let updating = $state(false);

  async function poll() {
    try {
      available = await fetchUpdateAvailable();
    } catch {}
  }

  $effect(() => {
    poll();
    const timer = setInterval(poll, 30 * 60 * 1000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") poll();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  async function update() {
    if (updating) return;
    updating = true;
    try {
      await triggerUpdate();
      setTimeout(() => (updating = false), 60000);
    } catch (err) {
      updating = false;
      showFlash(`Update failed: ${err.message}`);
    }
  }
</script>

{#if available}
  <button class="update mono" class:updating disabled={updating} onclick={update}>
    {updating ? "updating…" : "update ready"}
  </button>
{/if}

<style>
  .update {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--link);
    background: var(--link-bg);
    border: 1px solid var(--link);
    border-radius: 6px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .update::before {
    content: "↑";
    font-size: 12px;
  }
  .update:hover:not(:disabled) {
    background: var(--link-bg-hover);
  }
  .update:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .update:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }

  .update {
    min-height: 28px;
    padding: 3px 10px;
    font-family: var(--sans);
    font-weight: 600;
    letter-spacing: 0;
    border-color: transparent;
    border-radius: 7px;
  }
</style>
