<script>
  import Kbd from "./Kbd.svelte";

  let { url, impact, onClose } = $props();

  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function openGithub() {
    window.open(url, "_blank", "noopener");
    onClose();
  }
</script>

<div class="qm-backdrop" onclick={onClose} role="presentation">
  <div class="qm" role="dialog" aria-modal="true" aria-label={`GitHub quota exhausted. Available at ${clock(impact.restoresAt)}`} onclick={(e) => e.stopPropagation()}>
    <div class="qm-title">GitHub quota exhausted</div>
    <div class="qm-reset">Available <strong>{clock(impact.restoresAt)}</strong></div>
    <div class="qm-actions">
      <button class="qm-btn shortcut-action" type="button" onclick={onClose}>
        Cancel <Kbd keys="enter" /><span aria-hidden="true">/</span><Kbd keys="esc" />
      </button>
      <button class="qm-btn primary" type="button" onclick={openGithub}>Merge on GitHub</button>
    </div>
  </div>
</div>

<style>
  .qm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--text) 22%, transparent);
    backdrop-filter: blur(4px);
  }

  .qm {
    width: min(400px, calc(100vw - 48px));
    padding: 20px;
    border: 1px solid var(--fail);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
  }

  .qm-title {
    color: var(--fail);
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .qm-reset {
    margin: 8px 0 18px;
    color: var(--text-dim);
    font-size: 12px;
  }

  .qm-reset strong {
    color: var(--text);
  }

  .qm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .qm-btn {
    min-height: 32px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    transition: background-color 140ms ease, transform 140ms var(--ease-out);
  }
  .shortcut-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .qm-btn.primary {
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }

  .qm-btn:hover {
    background: var(--surface-hover);
  }
  .qm-btn.primary:hover {
    background: var(--brand-hover);
  }
  .qm-btn:active {
    transform: scale(0.99);
  }
</style>
