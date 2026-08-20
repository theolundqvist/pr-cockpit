<script>
  import { flash, dismissFlash } from "./flash.svelte.js";
</script>

{#if flash.message}
  <div class="flash-bar" role="status">
    <span>{flash.message}</span>
    <button type="button" class="dismiss" onclick={dismissFlash} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .flash-bar {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 520px;
    padding: 10px 12px 10px 16px;
    background: var(--panel);
    border: 1px solid var(--review);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: var(--text);
    font-size: 13px;
  }
  .dismiss {
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }
  .dismiss:hover {
    color: var(--text);
  }

  .flash-bar {
    bottom: calc(var(--keybar-height) + 16px);
    gap: 10px;
    min-height: 42px;
    padding: 10px 10px 10px 14px;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    border-color: transparent;
    border-radius: 10px;
    box-shadow: var(--shadow-dialog);
  }
  .dismiss {
    width: 22px;
    height: 22px;
    border-radius: 6px;
  }
  @media (hover: hover) and (pointer: fine) {
    .dismiss:hover {
      background: var(--surface);
    }
  }
</style>
