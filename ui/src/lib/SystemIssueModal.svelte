<script>
  let { issue, onRetry, onClose } = $props();

  let working = $state(false);
  let actionError = $state("");
  const titleId = $props.id();

  let primaryLabel = $derived(
    issue.kind === "missing-git" ? "Install Git"
      : issue.kind === "disk-space" ? "Open data folder"
        : "Open repositories",
  );
  let primaryAvailable = $derived(issue.kind !== "disk-space" || Boolean(window.cockpitShell?.openDataFolder));

  function manageDialogFocus(node) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => node.querySelector("[data-primary]:not([disabled])")?.focus({ preventScroll: true }));
    return {
      destroy() {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      },
    };
  }

  function handleKeydown(event) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  async function runPrimary() {
    actionError = "";
    try {
      if (issue.kind === "repository-access") {
        location.hash = "#/settings/general";
        onClose();
      } else if (issue.kind === "disk-space") {
        const result = await window.cockpitShell?.openDataFolder();
        if (result?.error) throw new Error(result.error);
      } else if (window.cockpitShell?.installGit) {
        const result = await window.cockpitShell.installGit();
        if (result?.error) throw new Error(result.error);
      } else {
        window.open("https://git-scm.com/downloads", "_blank", "noopener");
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    }
  }

  async function retry() {
    working = true;
    actionError = "";
    try {
      await onRetry();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      working = false;
    }
  }
</script>

<div class="system-issue-layer">
  <button class="system-issue-backdrop" type="button" tabindex="-1" aria-label="Close system notice" onclick={onClose}></button>
  <div class="system-issue-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" use:manageDialogFocus onkeydown={handleKeydown}>
    <div class="system-issue-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M12 3 2.8 19h18.4L12 3Z" />
        <path d="M12 9v4.5M12 17h.01" />
      </svg>
    </div>
    <div class="system-issue-copy">
      <span class="system-issue-label">Action required</span>
      <h2 id={titleId}>{issue.title}</h2>
      <p>{issue.message}</p>
      {#if actionError}<p class="system-issue-error" role="alert">{actionError}</p>{/if}
    </div>
    <div class="system-issue-actions">
      <button type="button" onclick={onClose}>Later</button>
      <button type="button" disabled={working} onclick={retry}>{working ? "Checking…" : "Check again"}</button>
      <button class="primary" type="button" data-primary disabled={!primaryAvailable} onclick={runPrimary}>{primaryLabel}</button>
    </div>
  </div>
</div>

<style>
  .system-issue-layer {
    position: fixed;
    inset: 0;
    z-index: 65;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .system-issue-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: var(--modal-scrim);
    box-shadow: none;
    backdrop-filter: blur(5px);
    cursor: default;
  }
  .system-issue-dialog {
    position: relative;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 14px;
    width: min(480px, calc(100vw - 48px));
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 14px;
    outline: none;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
    color: var(--text);
  }
  .system-issue-mark {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border-radius: 10px;
    background: var(--review-bg);
    color: var(--review);
  }
  .system-issue-mark svg {
    width: 21px;
    height: 21px;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.6;
  }
  .system-issue-copy { min-width: 0; }
  .system-issue-label {
    color: var(--review);
    font: 600 10px/1.2 var(--sans);
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  h2 {
    margin: 4px 0 0;
    font: 600 18px/1.25 var(--sans);
    letter-spacing: -.015em;
  }
  p {
    margin: 8px 0 0;
    color: var(--text-dim);
    font: 13px/1.5 var(--sans);
  }
  .system-issue-error { color: var(--fail); }
  .system-issue-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .system-issue-actions button {
    min-height: 34px;
    padding: 0 13px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-dim);
    font: 500 12px/1 var(--sans);
    cursor: pointer;
  }
  .system-issue-actions button:hover:not(:disabled) { background: var(--ghost-hover); color: var(--text); }
  .system-issue-actions button.primary { border-color: var(--review); background: var(--review-bg); color: var(--review); }
  .system-issue-actions button:disabled { opacity: .45; cursor: not-allowed; }
  .system-issue-actions button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
</style>
