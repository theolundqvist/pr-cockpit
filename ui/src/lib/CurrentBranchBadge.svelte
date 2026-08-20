<script>
  let { label = "current" } = $props();
</script>

<span class="current-branch-badge" title="This PR branch is checked out locally" aria-label="This PR branch is checked out locally">
  <span class="dot" aria-hidden="true"></span>
  {label}
</span>

<style>
  .current-branch-badge {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 4px;
    padding: 3px 6px;
    border: 1px solid color-mix(in srgb, var(--ready) 28%, var(--border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--ready) 9%, transparent);
    color: var(--ready);
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 650;
    letter-spacing: 0.045em;
    line-height: 1;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
  }
</style>
