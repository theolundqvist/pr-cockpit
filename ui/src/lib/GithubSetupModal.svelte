<script>
  import { onMount } from "svelte";
  import { fetchAuthStatus, startGithubSetup } from "./api.js";

  let { initialStatus, onReady, onClose } = $props();

  let status = $state(initialStatus);
  let working = $state(false);
  let watchingInstall = $state(false);
  let codeCopied = $state(false);
  let copyError = $state(false);
  let active = true;
  let request = 0;
  let timer = null;
  const titleId = "github-setup-title";

  onMount(() => {
    if (status?.state === "ready") acceptStatus(status);
    else if (status?.state === "authorizing") scheduleRefresh();
    else if (status?.state !== "error") void beginSetup();
    return () => {
      active = false;
      request += 1;
      clearTimeout(timer);
    };
  });

  function close() {
    active = false;
    request += 1;
    clearTimeout(timer);
    onClose();
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!active || (status?.state !== "authorizing" && !watchingInstall)) return;
    timer = setTimeout(refresh, status?.state === "authorizing" ? 800 : 2000);
  }

  function acceptStatus(next) {
    if (!active) return;
    if (next.userCode !== status?.userCode) {
      codeCopied = false;
      copyError = false;
    }
    status = next;
    if (status.state === "ready") {
      active = false;
      clearTimeout(timer);
      onReady(status);
      return;
    }
    scheduleRefresh();
  }

  async function refresh() {
    if (!active || working) return;
    clearTimeout(timer);
    const current = ++request;
    working = true;
    try {
      const next = await fetchAuthStatus(status.requiredScopes);
      if (!active || current !== request) return;
      const installed = watchingInstall && next.state !== "missing-cli";
      if (installed) watchingInstall = false;
      acceptStatus(next);
      if (active && installed && (next.state === "missing-auth" || next.state === "missing-scopes")) {
        working = false;
        void beginSetup();
      }
    } catch (error) {
      if (!active || current !== request) return;
      watchingInstall = false;
      status = { ...status, state: "error", error: error.message };
    } finally {
      if (active && current === request) working = false;
    }
  }

  async function beginSetup() {
    if (!active || working) return;
    clearTimeout(timer);
    const current = ++request;
    working = true;
    try {
      const next = await startGithubSetup(status.requiredScopes);
      if (!active || current !== request) return;
      watchingInstall = next.state === "missing-cli";
      acceptStatus(next);
    } catch (error) {
      if (!active || current !== request) return;
      watchingInstall = false;
      status = { ...status, state: "error", error: error.message };
    } finally {
      if (active && current === request) working = false;
    }
  }

  async function copyCode() {
    const code = status?.userCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      if (active && status?.userCode === code) {
        codeCopied = true;
        copyError = false;
      }
    } catch {
      if (active && status?.userCode === code) copyError = true;
    }
  }

  function manageDialogFocus(node) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      if (!node.isConnected) return;
      (node.querySelector("[data-primary]:not([disabled])") || node.querySelector("button:not([disabled])") || node).focus({ preventScroll: true });
    });
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
      close();
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

  let title = $derived(
    status?.state === "missing-cli" ? "Install GitHub CLI"
      : status?.state === "missing-auth" ? "Connect GitHub"
        : status?.state === "missing-scopes" ? "Allow GitHub access"
          : status?.state === "authorizing" ? "Finish on GitHub"
            : status?.state === "ready" ? "GitHub connected" : "Let's reconnect GitHub",
  );

  let actionLabel = $derived(
    working ? "Connecting…"
      : status?.state === "missing-cli" ? "Open install guide"
        : status?.state === "missing-auth" ? "Connect GitHub"
          : status?.state === "missing-scopes" ? "Allow access"
            : "Retry",
  );
</script>

<div class="github-setup-layer">
  <button class="github-setup-backdrop" type="button" tabindex="-1" aria-label="Close GitHub setup" onclick={close}></button>
  <div class="github-setup-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabindex="-1" use:manageDialogFocus onkeydown={handleKeydown}>
    <h2 id={titleId}>{title}</h2>

    {#if status?.state === "authorizing"}
      {#if status.userCode}
        <div class="device-code" aria-label={`GitHub device code ${status.userCode}`}>{status.userCode}</div>
        <p>Paste this code on GitHub, then approve access. This window will continue when you're connected.</p>
        <button class="copy-code" type="button" onclick={copyCode}>{codeCopied ? "Code copied" : "Copy code"}</button>
        {#if copyError}<p class="copy-error" role="status">Clipboard unavailable. Select and copy the code above.</p>{/if}
      {:else}
        <p role="status">Opening GitHub in your browser and waiting for a sign-in code…</p>
      {/if}
    {:else if status?.state === "missing-cli"}
      <p>{watchingInstall ? "Install GitHub CLI, then return here. We'll detect it and open browser sign-in. If the guide didn't open, try again below." : "Cockpit uses GitHub CLI to connect your account. Open its install guide, then return here."}</p>
    {:else if status?.state === "missing-auth"}
      <p>Continue in your browser to connect GitHub. No terminal sign-in needed.</p>
    {:else if status?.state === "missing-scopes"}
      <p>Approve {status.missingScopes?.join(" and ")} access on GitHub so Cockpit can work with your repositories and workflow files.</p>
    {:else if status?.state === "ready"}
      <p>Connected. Returning to setup…</p>
    {:else}
      <p role="alert">{status?.error || "GitHub could not connect. Try again, or check the connection if you have already signed in."}</p>
    {/if}

    <div class="github-setup-actions">
      <button type="button" onclick={close}>Cancel</button>
      {#if status?.state === "authorizing"}
        <button class="primary" type="button" data-primary onclick={openVerification}>Open GitHub</button>
      {:else}
        <button class="primary" type="button" data-primary disabled={working} onclick={beginSetup}>{actionLabel}</button>
      {/if}
    </div>
    {#if status?.state === "error"}
      <button class="check-connection" type="button" disabled={working} onclick={refresh}>Already signed in? Check connection</button>
    {:else if watchingInstall}
      <button class="check-connection" type="button" disabled={working} onclick={refresh}>Check installation</button>
    {/if}
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
    user-select: text;
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

  .copy-code, .check-connection {
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font-family: var(--sans);
    font-size: 12px;
    cursor: pointer;
  }
  .copy-code { margin-bottom: 20px; }
  .check-connection { margin-top: 18px; }
  .copy-error { font-size: 12px; }
  button:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
</style>
