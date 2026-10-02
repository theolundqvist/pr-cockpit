<script>
  import { tick, untrack } from "svelte";
  import { fetchQuickGenerateConfig, fetchQuickGenerateModels, quickGenerate } from "./api.js";
  import { prefs } from "./prefs.svelte.js";
  import { isRecordingShortcut } from "./shortcutCapture.js";
  import Kbd from "./Kbd.svelte";

  // The shell's standalone panel only hides, so the draft and result survive until the next ⌘⌥J.
  let { standalone = false } = $props();

  let open = $state(standalone);
  let prompt = $state("");
  let result = $state("");
  let error = $state(null);
  let generating = $state(false);
  let copied = $state(false);
  let config = $state(null);
  let configError = $state(null);
  let configLoading = $state(false);
  let key = $state("");
  let model = $state("");
  let models = $state([]);
  let modelsKey = $state(null);
  let modelsLoading = $state(false);
  let modelsError = $state(null);
  let promptEl = $state(null);
  let configRequest = null;
  let modelsRequest = null;
  let generateRequest = null;
  let copiedTimer = null;

  let enabled = $derived(prefs.quickGenerateEnabled);
  let modelReady = $derived(modelsKey === key && !modelsLoading && models.some((item) => item.id === model));
  let canGenerate = $derived(enabled && !generating && !configLoading && !configError && !!key && modelReady && prompt.trim().length > 0);

  const message = (e) => (e instanceof Error ? e.message : String(e));

  // A changed key file or saved default replaces this session's key and model choice. The
  // catalog is always reread, since the same key name may now hold another account's key.
  async function loadConfig() {
    configRequest?.abort();
    const request = new AbortController();
    configRequest = request;
    configLoading = true;
    try {
      const next = await fetchQuickGenerateConfig(request.signal);
      if (request.signal.aborted) return;
      const sourceChanged =
        next.envFiles.join("\n") !== config?.envFiles.join("\n") ||
        next.defaultKey !== config?.defaultKey ||
        next.defaultModel !== config?.defaultModel;
      config = next;
      configError = null;
      if (sourceChanged || !next.keys.some((item) => item.id === key)) {
        key = next.defaultKey;
        model = next.defaultModel;
      }
      modelsKey = null;
    } catch (e) {
      if (!request.signal.aborted) configError = message(e);
    } finally {
      if (!request.signal.aborted) configLoading = false;
    }
  }

  async function loadModels(forKey) {
    modelsRequest?.abort();
    const request = new AbortController();
    modelsRequest = request;
    modelsKey = forKey;
    modelsLoading = true;
    modelsError = null;
    models = [];
    try {
      const list = await fetchQuickGenerateModels(forKey, request.signal);
      if (request.signal.aborted) return;
      models = list;
      if (!list.some((item) => item.id === model)) {
        const saved = forKey === config?.defaultKey && list.some((item) => item.id === config?.defaultModel);
        model = saved ? config.defaultModel : (list[0]?.id ?? "");
      }
    } catch (e) {
      if (!request.signal.aborted) modelsError = message(e);
    } finally {
      if (!request.signal.aborted) modelsLoading = false;
    }
  }

  function cancelRequests() {
    configRequest?.abort();
    modelsRequest?.abort();
    generateRequest?.abort();
    configLoading = false;
    modelsLoading = false;
    modelsKey = null;
  }

  $effect(() => {
    if (open && enabled && config && !configLoading && key && modelsKey !== key) loadModels(key);
  });

  // Reopening rereads keys so .env edits show up without a reload.
  async function show() {
    open = true;
    if (enabled && (config || configError)) loadConfig();
    await tick();
    promptEl?.focus();
  }

  function close() {
    if (standalone) {
      location.hash = "#/quick-generate/close";
      return;
    }
    open = false;
  }

  // Hiding keeps a generation running; only disabling or unmounting cancels it.
  async function generate() {
    if (!canGenerate) return;
    const request = new AbortController();
    generateRequest = request;
    generating = true;
    error = null;
    copied = false;
    try {
      const text = await quickGenerate({ key, model, prompt }, request.signal);
      if (!request.signal.aborted) result = text;
    } catch (e) {
      if (!request.signal.aborted) error = message(e);
    } finally {
      generating = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(result);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1500);
    } catch (e) {
      error = `Copy failed: ${message(e)}`;
    }
  }

  $effect(() => {
    if (open && enabled && !config && !configError && !configLoading) loadConfig();
  });

  $effect(() => {
    prefs.quickGenerateEnvFile;
    if (enabled && untrack(() => config || configError)) loadConfig();
  });

  $effect(() => {
    if (!enabled) untrack(cancelRequests);
  });

  $effect(() => () => {
    clearTimeout(copiedTimer);
    configRequest?.abort();
    modelsRequest?.abort();
    generateRequest?.abort();
  });

  $effect(() => {
    const onOpen = () => show();
    window.addEventListener("cockpit:open-quick-generate", onOpen);
    return () => window.removeEventListener("cockpit:open-quick-generate", onOpen);
  });

  $effect(() => {
    if (!standalone) return;
    document.documentElement.classList.add("quick-generate-standalone-page");
    document.body.classList.add("quick-generate-standalone-page");
    untrack(show);
    return () => {
      document.documentElement.classList.remove("quick-generate-standalone-page");
      document.body.classList.remove("quick-generate-standalone-page");
    };
  });

  $effect(() => {
    function onKey(e) {
      if (isRecordingShortcut()) return;
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyJ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        show();
        return;
      }
      if (!open) return;
      // Keys typed here belong to the prompt, not to shortcuts underneath.
      e.stopImmediatePropagation();
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

{#if open}
  <div class="scrim" class:standalone onmousedown={close} role="presentation">
    <div class="quick-generate" class:standalone role="dialog" aria-label="Quick Generate" tabindex="-1" onmousedown={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="title">Quick Generate</span>
        {#if enabled && config?.keys.length}
          <select class="select" bind:value={key} aria-label="API key" disabled={generating}>
            {#each config.keys as item (item.id)}
              <option value={item.id}>{item.label}</option>
            {/each}
          </select>
          <select class="select" bind:value={model} aria-label="Model" disabled={generating || modelsLoading || !models.length}>
            {#if modelsLoading}
              <option value={model}>Loading models…</option>
            {:else if !models.length}
              <option value="">No models</option>
            {/if}
            {#each models as item (item.id)}
              <option value={item.id}>{item.label}</option>
            {/each}
          </select>
        {/if}
        <span class="esc">esc</span>
      </div>

      {#if prefs.loaded && !enabled}
        <p class="notice">Quick Generate is off. Turn it on in Settings → Agents &amp; merging.</p>
      {:else}
        <textarea
          class="prompt"
          bind:this={promptEl}
          bind:value={prompt}
          rows="5"
          placeholder="What should it write?"
          spellcheck="true"
          aria-label="Prompt"
        ></textarea>

        {#if configError}
          <div class="error" role="alert">
            <span>Couldn't read API keys: {configError}</span>
            <button class="link" type="button" onclick={loadConfig}>Try again</button>
          </div>
        {:else if config && !config.keys.length}
          <p class="notice">
            No API keys found in {config.envFiles.join(", ") || "the key file"}. Add CEREBRAS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY, or choose another file in Settings → Agents &amp; merging.
          </p>
        {/if}
        {#if modelsError}
          <div class="error" role="alert">
            <span>Couldn't list models: {modelsError}</span>
            <button class="link" type="button" onclick={() => (modelsKey = null)}>Try again</button>
          </div>
        {/if}
        {#if error}
          <div class="error" role="alert"><span>{error}</span></div>
        {/if}
        {#if result}
          <div class="result" class:stale={generating} aria-label="Generated text" aria-busy={generating}>{result}</div>
        {/if}

        <div class="foot">
          <span class="status" aria-live="polite">{generating ? "Generating…" : copied ? "Copied." : ""}</span>
          {#if result}
            <button class="btn" type="button" onclick={copy}>Copy</button>
          {/if}
          <button class="btn primary" type="button" disabled={!canGenerate} onclick={generate}>
            {generating ? "Generating…" : "Generate"}
            {#if canGenerate}<Kbd keys="cmd+enter" />{/if}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: var(--modal-scrim);
    backdrop-filter: blur(4px) saturate(85%);
  }
  .scrim.standalone {
    align-items: center;
    padding: 32px;
    background: transparent;
    backdrop-filter: none;
  }
  :global(html.quick-generate-standalone-page),
  :global(body.quick-generate-standalone-page) {
    background: transparent;
  }
  .quick-generate {
    display: flex;
    flex-direction: column;
    width: min(720px, 100%);
    max-height: calc(var(--general-height) - 24vh);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
  }
  .quick-generate.standalone {
    max-height: calc(var(--general-height) - 64px);
    box-shadow: 0 12px 28px rgb(0 0 0 / 0.16), 0 2px 6px rgb(0 0 0 / 0.1);
  }
  .quick-generate:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font: 500 14px var(--sans);
  }
  .select {
    max-width: 260px;
    min-height: 28px;
    padding: 3px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font: 12px var(--sans);
  }
  .select:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 1px;
  }
  .esc {
    flex: none;
    padding: 3px 5px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--surface);
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 9.5px;
  }
  .prompt {
    flex: none;
    width: 100%;
    box-sizing: border-box;
    min-height: 112px;
    max-height: 40vh;
    padding: 14px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: 15px/1.5 var(--sans);
    resize: vertical;
  }
  .prompt:focus {
    outline: none;
  }
  .prompt::placeholder {
    color: var(--text-faint);
  }
  .notice {
    margin: 0;
    padding: 12px 16px;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .error {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0 12px 10px;
    padding: 9px 12px;
    border-radius: var(--radius-sm);
    background: var(--fail-bg);
    color: var(--fail);
    font-size: 12.5px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .link {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font-size: 12px;
    cursor: pointer;
  }
  .result {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    color: var(--text);
    font: 14px/1.6 var(--sans);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    cursor: text;
  }
  .result.stale {
    opacity: 0.55;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 10px 16px;
    border-top: 1px solid var(--border);
  }
  .status {
    flex: 1;
    min-width: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 6px 14px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font: 500 13px var(--sans);
    cursor: pointer;
  }
  .btn.primary {
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .btn:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
    cursor: default;
  }
  .btn:focus-visible,
  .link:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) {
      background: var(--surface-hover);
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  @media (max-width: 620px) {
    .scrim.standalone {
      align-items: flex-start;
      padding: 16px 12px;
    }
    .select {
      max-width: 140px;
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .scrim {
      backdrop-filter: none;
    }
  }
</style>
