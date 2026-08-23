<script>
  let { state, onRetry, onDiscard, pendingLabel = "POSTING…" } = $props();
</script>

{#if state === "pending"}
  <span class="badge wait">{pendingLabel}</span>
{:else if state === "failed"}
  <span class="badge fail">FAILED</span>
  <button class="link" onclick={onRetry}>Retry</button>
  <button class="link" onclick={onDiscard}>Discard</button>
{/if}

<style>
  .link {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .link:hover {
    color: var(--text);
  }
</style>
