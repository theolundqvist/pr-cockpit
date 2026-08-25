<script>
  import { fetchAuthStatus, startGithubSetup } from "./api.js";

  let { initialStatus, onReady, onClose } = $props();

  let status = $state(initialStatus);
  let working = $state(false);
  let watchingInstall = $state(false);
  let copiedCode = null;
  let codeCopied = $state(false);
  const titleId = "github-setup-title";

  $effect(() => {
    if (status?.state === "ready") onReady(status);
  });

  $effect(() => {
    if (status?.state !== "authorizing" && !watchingInstall) return;
    const timer = setTimeout(refresh, status?.state === "authorizing" ? 800 : 2000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const code = status?.userCode;
    if (!code || code === copiedCode) return;
    copiedCode = code;
    codeCopied = false;
    void navigator.clipboard.writeText(code).then(
      () => (codeCopied = true),
      () => {},
    );
  });
  async function refresh() {
    try {
      status = await fetchAuthStatus(status.requiredScopes);
      if (status.state !== "missing-cli") watchingInstall = false;
    } catch (error) {
      status = { ...status, state: "error", error: error.message };
    }
  }

  async function beginSetup() {
    if (working) return;
    working = true;
    try {
      status = await startGithubSetup(status.requiredScopes);
      watchingInstall = status.state === "missing-cli";
    } catch (error) {
      status = { ...status, state: "error", error: error.message };
    } finally {
      working = false;
    }
  }

  function manageDialogFocus(node) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => node.querySelector("[data-primary]")?.focus({ preventScroll: true }));
    return {
      destroy() {
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      },
    };
  }

  function openVerification() {
    window.open(status.verificationUrl || "https://github.com/login/device", "_blank", "noopener");
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
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  let title = $derived(
    status?.state === "missing-cli" ? "Install GitHub CLI"
      : status?.state === "missing-auth" ? "Connect GitHub"
        : status?.state === "missing-scopes" ? "Allow GitHub access"
          : status?.state === "authorizing" ? "Finish on GitHub"
            : "GitHub setup failed",
  );

  let actionLabel = $derived(
    working ? "Opening…"
      : status?.state === "missing-cli" ? "Open install guide"
        : status?.state === "missing-auth" ? "Connect GitHub"
          : status?.state === "missing-scopes" ? "Allow access"
            : "Retry",
  );
</script>

<div class="github-setup-layer">
  <button class="github-setup-backdrop" type="button" tabindex="-1" aria-label="Close GitHub setup" onclick={onClose}></button>
  <div class="github-setup-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" use:manageDialogFocus onkeydown={handleKeydown}>
    <h2 id={titleId}>{title}</h2>

    {#if status?.state === "authorizing"}
      {#if status.userCode}
        <div class="device-code" aria-label={`GitHub device code ${status.userCode}`}>{status.userCode}</div>
        <p>{codeCopied ? "Code copied. Continue in your browser." : "Continue in your browser."}</p>
      {:else}
        <p>Opening GitHub…</p>
      {/if}
    {:else if status?.state === "missing-cli"}
      <p>{watchingInstall ? "Waiting for GitHub CLI…" : "Install it, then return here."}</p>
    {:else if status?.state === "missing-auth"}
      <p>Sign in to continue.</p>
    {:else if status?.state === "missing-scopes"}
      <p>Grant {status.missingScopes.join(" and ")} access.</p>
    {:else}
      <p>{status?.error || "Try again."}</p>
    {/if}

    <div class="github-setup-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      {#if status?.state === "authorizing"}
        <button class="primary" type="button" data-primary onclick={openVerification}>Open GitHub</button>
      {:else}
        <button class="primary" type="button" data-primary disabled={working} onclick={beginSetup}>{actionLabel}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .github-setup-layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .github-setup-backdrop {
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

  .github-setup-dialog {
    position: relative;
    width: min(390px, calc(100vw - 48px));
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 14px;
    outline: none;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
    color: var(--text);
  }

  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  p {
    margin: 8px 0 18px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .device-code {
    margin: 16px 0 0;
    color: var(--text);
    font-family: var(--mono);
    font-size: 24px;
    font-weight: 650;
    letter-spacing: 0.08em;
  }

  .github-setup-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .github-setup-actions button {
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
  }

  .github-setup-actions button.primary {
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }

  .github-setup-actions button:disabled {
    opacity: 0.55;
  }
</style>
