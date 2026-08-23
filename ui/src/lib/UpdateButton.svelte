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
    const timer = setInterval(poll, 5 * 60 * 1000);
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
  <button class="update" class:updating disabled={updating} aria-label={updating ? "Updating" : "Install update"} onclick={update}>
    {updating ? "Updating…" : "Install update"}
  </button>
{/if}

<style>
  .update {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--sans);
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
    min-height: 32px;
    padding: 0 12px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: 0;
    box-shadow: none;
    border-color: transparent;
    border-radius: 999px;
    transition: background-color 140ms ease, transform 140ms var(--ease-out);
  }
  .update:active:not(:disabled) {
    transform: scale(0.99);
  }
</style>
