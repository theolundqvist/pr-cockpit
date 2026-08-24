<script>
  import Kbd from "./Kbd.svelte";

  let { keys } = $props();
</script>

<div class="keybar">
  <div class="keybar-content">
    {#each keys as { key, label }}
      <span class="hint">
        <Kbd keys={key} />
        <span class="label">{label}</span>
      </span>
    {/each}
  </div>
</div>

<style>
  .keybar {
    position: fixed;
    left: 0;
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
    width: fit-content;
    max-width: 100%;
    justify-content: center;
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
  .label {
    font-family: var(--sans);
    color: var(--text-dim);
    letter-spacing: 0;
  }
</style>
