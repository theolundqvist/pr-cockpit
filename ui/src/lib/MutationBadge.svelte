<script>
  let { state, onRetry, onDiscard, pendingLabel = "POSTING…" } = $props();
</script>

{#if state === "pending"}
  <span class="badge wait">{pendingLabel}</span>
{:else if state === "failed"}
  <span class="badge fail">FAILED</span>
  <button class="link mono" onclick={onRetry}>retry</button>
  <button class="link mono" onclick={onDiscard}>discard</button>
{/if}

<style>
  .link {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .link:hover {
    color: var(--text);
  }
</style>
