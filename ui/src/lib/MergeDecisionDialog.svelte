<script>
  import ConfirmDialog from "./ConfirmDialog.svelte";

  let { number, headRef, baseRef, methodLabel, force = false, onConfirm, onCancel } = $props();
</script>

<ConfirmDialog
  title="{force ? 'Force-merge' : 'Merge'} #{number}?"
  badge={methodLabel}
  confirmLabel={force ? "Force-merge" : "Merge"}
  danger={force}
  icon={force ? null : mergeIcon}
  detail={route}
  {onConfirm}
  {onCancel}
/>

{#snippet mergeIcon()}
  <svg viewBox="0 0 16 16"><path d="M4 4.5h4.5a3 3 0 0 1 3 3v4"></path><path d="m8.8 9.3 2.7 2.7 2.7-2.7"></path><circle cx="3.3" cy="4.5" r="1.3"></circle></svg>
{/snippet}

{#snippet route()}
  <div class="merge-route" aria-label={`${headRef} into ${baseRef}`}>
    <span class="route-ref">{headRef}</span>
    <svg class="route-arrow" viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6h16m-4-4 4 4-4 4"></path></svg>
    <span class="route-ref">{baseRef}</span>
  </div>
{/snippet}

<style>
  .merge-route {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
    align-items: center;
    gap: 9px;
    padding: 10px 12px;
    border-radius: 9px;
    background: var(--surface);
  }

  .route-ref {
    overflow: hidden;
    color: var(--text);
    font-family: var(--mono);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .route-arrow {
    width: 20px;
    fill: none;
    stroke: var(--text-faint);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.25;
  }
</style>
