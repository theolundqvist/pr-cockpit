<script>
  import Kbd from "./Kbd.svelte";

  let { number, headRef, baseRef, methodLabel, force = false, onConfirm, onCancel } = $props();

  let titleId = $derived(`merge-decision-title-${number}`);

  function manageDialogFocus(node) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusPrimary = () => node.querySelector("[data-primary]")?.focus({ preventScroll: true });
    queueMicrotask(focusPrimary);

    return {
      destroy() {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      },
    };
  }

  function focusableElements(node) {
    return [...node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  }

  function handleKeydown(event) {
    event.stopPropagation();

    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key !== "Tab") return;
    const controls = focusableElements(event.currentTarget);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div class="merge-decision-layer">
  <button class="merge-decision-backdrop" type="button" tabindex="-1" aria-label="Cancel merge confirmation" onclick={onCancel}></button>
  <div
    class="merge-decision-dialog"
    class:force
    role="alertdialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    use:manageDialogFocus
    onkeydown={handleKeydown}
  >
    <div class="decision-header">
      {#if !force}
        <span class="decision-mark" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M4 4.5h4.5a3 3 0 0 1 3 3v4"></path><path d="m8.8 9.3 2.7 2.7 2.7-2.7"></path><circle cx="3.3" cy="4.5" r="1.3"></circle></svg>
        </span>
      {/if}
      <h2 id={titleId}>{force ? "Force-merge" : "Merge"} #{number}?</h2>
      <span class="method-label">{methodLabel}</span>
    </div>

    <div class="merge-route" aria-label={`${headRef} into ${baseRef}`}>
      <span class="route-ref">{headRef}</span>
      <svg class="route-arrow" viewBox="0 0 20 12" aria-hidden="true"><path d="M1 6h16m-4-4 4 4-4 4"></path></svg>
      <span class="route-ref">{baseRef}</span>
    </div>

    <div class="decision-actions">
      <button class="decision-button secondary" type="button" aria-label="Cancel merge" onclick={onCancel}>
        <span>Cancel</span>
        <Kbd keys="esc" />
      </button>
      <button class="decision-button primary" class:danger={force} type="button" aria-label={force ? "Force-merge pull request" : "Merge pull request"} data-primary onclick={onConfirm}>
        <span>{force ? "Force-merge" : "Merge"}</span>
        <Kbd keys="enter" />
      </button>
    </div>
  </div>
</div>

<style>
  .merge-decision-layer {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .merge-decision-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: color-mix(in srgb, var(--text) 22%, transparent);
    box-shadow: none;
    backdrop-filter: blur(5px);
    cursor: default;
  }

  .merge-decision-dialog {
    position: relative;
    width: min(430px, calc(100vw - 48px));
    overflow: hidden;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 14px;
    outline: none;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
    color: var(--text);
  }

  .decision-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .decision-mark {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    place-items: center;
    border-radius: 9px;
    background: var(--link-bg);
    color: var(--link);
  }

  .decision-mark svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  h2 {
    margin: 0;
    color: var(--text);
    font-family: var(--sans);
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .merge-route {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
    align-items: center;
    gap: 9px;
    margin: 16px 0 18px;
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

  .method-label {
    margin-left: auto;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .decision-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .decision-button {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    box-shadow: var(--shadow-control-outlined);
  }

  .decision-button.secondary {
    background: var(--surface);
    color: var(--text);
  }

  .decision-button.primary {
    background: var(--link);
    color: var(--on-brand);
    box-shadow: var(--shadow-control-filled);
  }

  .decision-button.primary.danger {
    background: var(--fail);
    color: var(--on-brand);
  }

  @media (hover: hover) and (pointer: fine) {
    .decision-button.secondary:hover {
      background: var(--surface);
    }

    .decision-button.primary:hover {
      background: var(--brand-hover);
    }

    .decision-button.primary.danger:hover {
      background: color-mix(in srgb, var(--fail) 88%, var(--text));
    }
  }

  .decision-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--focus-ring), var(--shadow-control-outlined);
  }

  .decision-button.primary:focus-visible {
    box-shadow: 0 0 0 3px var(--focus-ring), var(--shadow-control-filled);
  }

  .decision-button:active {
    transform: scale(0.99);
  }

  @media (max-width: 520px) {
    .merge-decision-layer {
      padding: 16px;
    }

    .merge-decision-dialog {
      width: min(100%, calc(100vw - 32px));
      padding: 18px;
    }

    .decision-actions {
      display: grid;
      grid-template-columns: 1fr 1.25fr;
    }
  }
</style>
