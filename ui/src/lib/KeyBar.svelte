<script>
  let { keys } = $props();
</script>

<div class="keybar mono">
  <div class="keybar-content">
    {#each keys as { key, label }}
      <span class="hint">
        <kbd>{key}</kbd>
        <span class="label">{label}</span>
      </span>
    {/each}
  </div>
</div>

<style>
  .keybar {
    position: fixed;
    left: var(--app-rail-width, 0px);
    right: 0;
    bottom: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 var(--app-content-gutter, 24px);
    background: var(--panel);
    border-top: 1px solid var(--border);
    z-index: 20;
    overflow-x: auto;
  }
  .keybar-content {
    display: flex;
    box-sizing: border-box;
    width: min(var(--app-content-max-width, 1320px), 100%);
    min-height: 100%;
    align-items: center;
    gap: 16px;
    margin: 0 auto;
    padding-inline: 2px;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 1px 6px;
    min-width: 16px;
    text-align: center;
  }
  .label {
    font-size: 11.5px;
    color: var(--text-faint);
    letter-spacing: 0.02em;
  }

  .keybar {
    height: var(--keybar-height);
    padding: 0 var(--app-content-gutter, 28px);
    border-top-color: var(--border);
  }
  kbd {
    min-width: 20px;
    color: var(--text-dim);
    background: var(--surface);
    border-color: var(--border);
    border-bottom-width: 1px;
    border-radius: 5px;
    box-shadow: var(--shadow-xs);
  }
  .label {
    font-family: var(--sans);
    color: var(--text-dim);
    letter-spacing: 0;
  }
</style>
