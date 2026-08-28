<script>
  let { status, conclusion = null } = $props();

  const terminalFailures = {
    failure: true,
    timed_out: true,
    action_required: true,
    startup_failure: true,
    stale: true,
  };

  let tone = $derived.by(() => {
    const value = conclusion ?? status;
    if (value === "success") return "ready";
    if (terminalFailures[value]) return "fail";
    if (["queued", "pending", "waiting", "requested", "in_progress"].includes(status)) return "wait";
    return "neutral";
  });
</script>

<span class="status-icon {tone}" aria-label={conclusion ?? status}>
  {#if tone === "ready"}
    <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"></circle><path d="m4.6 8.1 2.2 2.2 4.7-4.8"></path></svg>
  {:else if tone === "fail"}
    <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"></circle><path d="m5.4 5.4 5.2 5.2m0-5.2-5.2 5.2"></path></svg>
  {:else if tone === "wait"}
    <svg class="status-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle></svg>
  {:else}
    <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M5.5 8h5"></path></svg>
  {/if}
</span>

<style>
  .status-icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    flex: none;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }
  .status-icon.ready { color: var(--ready); }
  .status-icon.fail { color: var(--fail); }
  .status-icon.wait { color: var(--review); }
  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }
  .ready circle,
  .fail circle {
    fill: currentColor;
    stroke: none;
  }
  .ready path,
  .fail path {
    stroke: var(--native-on-accent);
    stroke-width: 1.5;
  }
  .status-spinner circle {
    stroke-dasharray: 24 14;
    transform-origin: center;
    animation: status-spin 0.9s linear infinite;
  }
  @keyframes status-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-spinner circle { animation: none; }
  }
</style>
