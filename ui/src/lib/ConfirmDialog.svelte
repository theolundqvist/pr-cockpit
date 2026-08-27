<script>
  import Kbd from "./Kbd.svelte";

  let { title, badge = null, confirmLabel = "Confirm", danger = false, icon = null, detail = null, onConfirm, onCancel } = $props();

  const titleId = $props.id();
  const detailId = `${titleId}-detail`;

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

    if (!controls.includes(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div class="confirm-layer">
  <button class="confirm-backdrop" type="button" tabindex="-1" aria-label="Dismiss {title}" onclick={onCancel}></button>
  <div
    class="confirm-dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={detail ? detailId : undefined}
    tabindex="-1"
    use:manageDialogFocus
    onkeydown={handleKeydown}
  >
    <div class="confirm-header">
      {#if icon}
        <span class="confirm-mark" aria-hidden="true">{@render icon()}</span>
      {/if}
      <h2 id={titleId}>{title}</h2>
      {#if badge}<span class="confirm-badge">{badge}</span>{/if}
    </div>

    {#if detail}
      <div class="confirm-detail" id={detailId}>{@render detail()}</div>
    {/if}

    <div class="confirm-actions">
      <button class="confirm-button secondary" type="button" aria-label="Cancel" onclick={onCancel}>
        <span>Cancel</span>
        <Kbd keys="esc" />
      </button>
      <button class="confirm-button primary" class:danger type="button" aria-label={confirmLabel} data-primary onclick={onConfirm}>
        <span>{confirmLabel}</span>
        <Kbd keys="enter" />
      </button>
    </div>
  </div>
</div>

<style>
  .confirm-layer {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .confirm-backdrop {
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

  .confirm-dialog {
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

  .confirm-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .confirm-mark {
    display: grid;
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    place-items: center;
    border-radius: 9px;
    background: var(--link-bg);
    color: var(--link);
  }

  .confirm-mark :global(svg) {
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

  .confirm-badge {
    margin-left: auto;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .confirm-detail {
    margin-top: 16px;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.45;
  }

  .confirm-actions {
    margin-top: 18px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-button {
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

  .confirm-button.secondary {
    background: var(--surface);
    color: var(--text);
  }

  .confirm-button.primary {
    background: var(--link);
    color: var(--on-brand);
    box-shadow: var(--shadow-control-filled);
  }

  .confirm-button.primary.danger {
    background: var(--fail);
    color: var(--on-brand);
  }

  @media (hover: hover) and (pointer: fine) {
    .confirm-button.secondary:hover {
      background: var(--surface);
    }

    .confirm-button.primary:hover {
      background: var(--brand-hover);
    }

    .confirm-button.primary.danger:hover {
      background: color-mix(in srgb, var(--fail) 88%, var(--text));
    }
  }

  .confirm-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--focus-ring), var(--shadow-control-outlined);
  }

  .confirm-button.primary:focus-visible {
    box-shadow: 0 0 0 3px var(--focus-ring), var(--shadow-control-filled);
  }

  .confirm-button:active {
    transform: scale(0.99);
  }

  @media (max-width: 520px) {
    .confirm-layer {
      padding: 16px;
    }

    .confirm-dialog {
      width: min(100%, calc(100vw - 32px));
      padding: 18px;
    }

    .confirm-actions {
      display: grid;
      grid-template-columns: 1fr 1.25fr;
    }
  }
</style>
