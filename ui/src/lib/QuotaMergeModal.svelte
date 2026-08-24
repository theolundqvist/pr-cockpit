<script>
  import { quotaOutLabel } from "./quotaImpact.js";

  let { number, url, impact, onClose } = $props();

  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function openGithub() {
    window.open(url, "_blank", "noopener");
    onClose();
  }
</script>

<div class="qm-backdrop" onclick={onClose} role="presentation">
  <div class="qm" role="dialog" aria-modal="true" aria-label="Merge blocked by GitHub quota" onclick={(e) => e.stopPropagation()}>
    <div class="qm-title">{quotaOutLabel(impact)}</div>
    <p class="qm-body">
      Cockpit cannot merge #{number} right now: the merge needs GitHub API calls that would fail.
      Quota returns at <strong>{clock(impact.restoresAt)}</strong>, after which merging works here again.
    </p>
    <div class="qm-actions">
      <button class="qm-btn primary" type="button" onclick={openGithub}>Merge on GitHub</button>
      <button class="qm-btn" type="button" onclick={onClose}>Cancel</button>
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
    width: min(440px, calc(100vw - 48px));
    padding: 20px;
    border: 1px solid var(--fail);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
  }

  .qm-title {
    color: var(--fail);
    font-size: 12px;
    font-weight: 600;
  }

  .qm-body {
    margin: 9px 0 18px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.5;
  }

  .qm-body strong {
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
