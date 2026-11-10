<script>
  import { tick, untrack } from "svelte";
  import { fetchQuickGenerateConfig, fetchQuickGenerateModels, fetchVersion, quickGenerate } from "./api.js";
  import { ATTACHMENT_LIMITS, IMAGE_MIME_TYPES, attachmentKind, hasAttachmentSignature } from "../../../shared/quickGenerateAttachments.js";
  import { prefs } from "./prefs.svelte.js";
  import { isRecordingShortcut } from "./shortcutCapture.js";
  import { renderMarkdown } from "./markdown.js";
  import Kbd from "./Kbd.svelte";

  // The shell's standalone panel only hides, so the draft and result survive until the next ⌘⌥J.
  let { standalone = false } = $props();

  const KIND_NOUNS = { image: "images", pdf: "PDFs", text: "text files" };
  const OR_LIST = new Intl.ListFormat("en", { type: "disjunction" });
  const AND_LIST = new Intl.ListFormat("en", { type: "conjunction" });
  const INSPECT_TEXT_CHARS = 20000;
  const imageFormat = (mimeType) => mimeType.split("/")[1].toUpperCase();

  let open = $state(standalone);
  let prompt = $state("");
  let result = $state("");
  let error = $state(null);
  let captureError = $state(null);
  let generating = $state(false);
  let streamed = $state(false);
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
  let resultEl = $state(null);
  let dialogEl = $state(null);
  let fileInput = $state(null);
  // { id, name, mimeType, kind, size, blob, url (images), text (text files) }; kept with the draft while hidden.
  let attachments = $state.raw([]);
  let attachError = $state(null);
  let preparing = $state(0);
  let inspectedId = $state(null);
  let dropping = $state(false);
  let configRequest = null;
  let modelsRequest = null;
  let generateRequest = null;
  let copiedTimer = null;
  let attachQueue = Promise.resolve();
  let attachEpoch = 0;
  let attachSeq = 0;

  let enabled = $derived(prefs.quickGenerateEnabled);
  let modelReady = $derived(modelsKey === key && !modelsLoading && models.some((item) => item.id === model));
  let attachedBytes = $derived(attachments.reduce((sum, item) => sum + item.size, 0));
  let selectedModel = $derived(modelReady ? models.find((item) => item.id === model) : null);
  let selectedShortfalls = $derived(selectedModel ? shortfalls(selectedModel) : []);
  let compatNote = $derived.by(() => {
    if (!selectedShortfalls.length) return "";
    const reason = `${selectedModel.label} ${AND_LIST.format(selectedShortfalls)}.`;
    const capable = models.filter(accepts);
    if (!capable.length) {
      const keyLabel = config?.keys.find((item) => item.id === key)?.label ?? "this key";
      return `${reason} No ${keyLabel} model takes these attachments; choose another API key, or remove an attachment.`;
    }
    return `${reason} Choose ${capable[0].label}${capable.length > 1 ? " or another enabled model" : ""}, or remove an attachment.`;
  });
  let inspected = $derived(attachments.find((item) => item.id === inspectedId) ?? null);
  let canGenerate = $derived(
    enabled && !generating && !configLoading && !configError && !!key && modelReady && !preparing && !selectedShortfalls.length &&
      (prompt.trim().length > 0 || attachments.length > 0),
  );

  // Why a model can't take the current attachments, as phrases following its name. Capabilities and limits come
  // only from the backend catalog: no inputs means text alone, and a limit it doesn't state is the shared one.
  function shortfalls(item) {
    const inputs = item.inputs ?? ["text"];
    const limits = item.attachmentLimits ?? {};
    const found = [];
    const missing = [...new Set(attachments.map((entry) => entry.kind))].filter((kind) => !inputs.includes(kind));
    if (missing.length) found.push(`can't read ${OR_LIST.format(missing.map((kind) => KIND_NOUNS[kind]))}`);
    const images = attachments.filter((entry) => entry.kind === "image");
    if (images.length && inputs.includes("image")) {
      const formats = limits.imageMimeTypes ?? IMAGE_MIME_TYPES;
      if (images.some((entry) => !formats.includes(entry.mimeType))) found.push(`reads only ${OR_LIST.format(formats.map(imageFormat))} images`);
      const imageCount = limits.imageCount ?? ATTACHMENT_LIMITS.count;
      if (images.length > imageCount) found.push(`takes up to ${imageCount} ${imageCount === 1 ? "image" : "images"}`);
    }
    const totalBytes = limits.totalBytes ?? ATTACHMENT_LIMITS.totalBytes;
    if (attachedBytes > totalBytes) found.push(`takes up to ${sizeText(totalBytes)} of attachments`);
    return found;
  }

  const accepts = (item) => shortfalls(item).length === 0;

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  // Verifies the bytes, not just the declared type; anything else that decodes as UTF-8 without NULs is sent as text/plain.
  async function classify(file) {
    const declared = attachmentKind(file.type);
    if (declared === "image" || declared === "pdf") {
      const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      if (!hasAttachmentSignature(header, file.type)) return { problem: "its contents don't match its file type" };
      if (declared === "image") {
        try {
          (await createImageBitmap(file)).close();
        } catch {
          return { problem: "it couldn't be read as an image" };
        }
      }
      return { kind: declared, mimeType: file.type };
    }
    const unsupported = { problem: "only images, PDFs, and UTF-8 text files can be attached" };
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return unsupported;
    }
    if (text.includes("\0")) return unsupported;
    return { kind: "text", mimeType: declared === "text" ? file.type : "text/plain", text };
  }

  async function admit(file, epoch) {
    if (file.size > ATTACHMENT_LIMITS.fileBytes) return `it's larger than ${sizeText(ATTACHMENT_LIMITS.fileBytes)}`;
    if (attachments.length >= ATTACHMENT_LIMITS.count) return `Quick Generate takes up to ${ATTACHMENT_LIMITS.count} files`;
    if (attachedBytes + file.size > ATTACHMENT_LIMITS.totalBytes) return `attachments are limited to ${sizeText(ATTACHMENT_LIMITS.totalBytes)} in total`;
    const verdict = await classify(file);
    if (epoch !== attachEpoch) return null;
    if (verdict.problem) return verdict.problem;
    const item = {
      id: ++attachSeq,
      name: file.name || "pasted file",
      mimeType: verdict.mimeType,
      kind: verdict.kind,
      size: file.size,
      blob: file,
      url: verdict.kind !== "text" ? URL.createObjectURL(file) : null,
      text: verdict.text ?? null,
    };
    attachments = [...attachments, item];
    return null;
  }

  // Paste, drop and the file picker all land here. Batches run one at a time so the limits see every earlier file.
  function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const epoch = attachEpoch;
    attachError = null;
    preparing += 1;
    attachQueue = attachQueue
      .then(async () => {
        const problems = [];
        for (const file of files) {
          const problem = await admit(file, epoch);
          if (problem) problems.push(`Couldn't attach ${file.name || "the pasted file"}: ${problem}.`);
        }
        if (epoch === attachEpoch && problems.length) attachError = problems.join(" ");
      })
      .catch((e) => {
        if (epoch === attachEpoch) attachError = `Couldn't attach: ${message(e)}`;
      })
      .finally(() => {
        preparing -= 1;
      });
  }

  function removeAttachment(id) {
    const item = attachments.find((entry) => entry.id === id);
    if (!item) return;
    if (item.url) URL.revokeObjectURL(item.url);
    attachments = attachments.filter((entry) => entry !== item);
    if (inspectedId === id) inspectedId = null;
    attachError = null;
  }

  function clearAttachments() {
    attachEpoch += 1;
    for (const item of attachments) if (item.url) URL.revokeObjectURL(item.url);
    attachments = [];
    inspectedId = null;
    attachError = null;
  }

  function onPaste(e) {
    const data = e.clipboardData;
    if (!enabled || !data) return;
    const files = [...data.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const richText = (data.types.includes("text/html") || data.types.includes("text/rtf")) && data.getData("text/plain").length > 0;
    if (richText) return;
    e.preventDefault();
    addFiles(files);
  }

  const carriesFiles = (e) => e.dataTransfer?.types.includes("Files");

  // Files dropped anywhere over the panel are taken, never left for the window to navigate to.
  function onDragOver(e) {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = enabled ? "copy" : "none";
    dropping = enabled;
  }

  function onDragLeave(e) {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) dropping = false;
  }

  function onDrop(e) {
    dropping = false;
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (enabled) addFiles(e.dataTransfer.files);
  }

  function onPicked(e) {
    addFiles(e.currentTarget.files);
    e.currentTarget.value = "";
  }

  // A selection made elsewhere in this window; the panel's own prompt and result never count.
  function domSelection() {
    const active = document.activeElement;
    if (active && dialogEl?.contains(active)) return "";
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|url|email|tel)$/.test(active.type))) {
      return active.selectionStart == null ? "" : active.value.slice(active.selectionStart, active.selectionEnd);
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || (dialogEl && dialogEl.contains(selection.anchorNode))) return "";
    return selection.toString();
  }

  // A nonempty selection becomes the whole prompt; no selection leaves the draft. The result and attachments always stay.
  async function openWith(selectedText, captureMessage = null) {
    captureError = typeof captureMessage === "string" ? captureMessage : null;
    const replace = typeof selectedText === "string" && selectedText.length > 0;
    if (replace) prompt = selectedText;
    await show();
    if (replace) promptEl?.setSelectionRange(prompt.length, prompt.length);
  }

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

  // The shell never reloads its hidden panel, so an update reaches this page when it next opens.
  let loadedRev = null;
  function reloadIfUpdated() {
    fetchVersion().then(({ rev }) => {
      if (!rev) return;
      if (loadedRev === null) loadedRev = rev;
      else if (rev !== loadedRev && !generating && !preparing && !prompt && !result && !attachments.length) location.reload();
    }).catch(() => {});
  }

  // Reopening rereads keys so .env edits show up without a reload.
  async function show() {
    open = true;
    if (standalone) reloadIfUpdated();
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
    streamed = false;
    error = null;
    copied = false;
    let streamText = "";
    let frame = 0;
    // Fast models stream hundreds of pieces a second; rendering the reply's markdown once per frame keeps the panel responsive.
    const render = () => {
      frame = 0;
      const following = !resultEl || resultEl.scrollHeight - resultEl.scrollTop - resultEl.clientHeight < 24;
      result = streamText;
      streamed = true;
      if (following) tick().then(() => resultEl?.scrollTo({ top: resultEl.scrollHeight }));
    };
    try {
      const sent = attachments.map(({ name, mimeType, blob }) => ({ name, mimeType, blob }));
      const text = await quickGenerate({ key, model, prompt, attachments: sent }, (piece) => {
        if (request.signal.aborted) return;
        streamText += piece;
        frame ||= requestAnimationFrame(render);
      }, request.signal);
      if (!request.signal.aborted) result = text;
    } catch (e) {
      if (!request.signal.aborted) {
        if (streamText) result = streamText;
        error = message(e);
      }
    } finally {
      cancelAnimationFrame(frame);
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

  // Turning the feature off drops the draft's files along with their preview URLs.
  $effect(() => {
    if (!enabled) untrack(() => {
      cancelRequests();
      clearAttachments();
    });
  });

  $effect(() => () => {
    clearTimeout(copiedTimer);
    configRequest?.abort();
    modelsRequest?.abort();
    generateRequest?.abort();
    clearAttachments();
  });

  $effect(() => {
    const onOpen = (e) => openWith(e.detail?.selectedText, e.detail?.captureError);
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
        openWith(domSelection());
        return;
      }
      if (!open) return;
      // Keys typed here belong to the prompt, not to shortcuts underneath.
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        if (inspected) inspectedId = null;
        else close();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

{#if open}
  <div class="scrim" class:standalone onmousedown={close} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop} role="presentation">
    <div
      class="quick-generate"
      class:standalone
      class:dropping
      role="dialog"
      aria-label="Quick Generate"
      data-prompt-dialog
      tabindex="-1"
      bind:this={dialogEl}
      onmousedown={(e) => e.stopPropagation()}
      onpaste={onPaste}
    >
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
              <option value={item.id} disabled={item.id !== model && !accepts(item)}>{item.label}</option>
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
          rows="2"
          placeholder="What should it write?"
          spellcheck="true"
          aria-label="Prompt"
        ></textarea>

        {#if attachments.length}
          <ul class="attachments" aria-label="Attachments">
            {#each attachments as item (item.id)}
              <li class="attachment" class:inspected={item.id === inspectedId}>
                <button
                  class="attachment-open"
                  type="button"
                  title="{item.name} · {sizeText(item.size)}"
                  aria-pressed={item.id === inspectedId}
                  onclick={() => (inspectedId = inspectedId === item.id ? null : item.id)}
                >
                  {#if item.url}
                    <img class="thumb" src={item.url} alt="" />
                  {:else}
                    <span class="badge">{item.kind === "pdf" ? "PDF" : "TXT"}</span>
                  {/if}
                  <span class="attachment-name">{item.name}</span>
                </button>
                <button class="attachment-remove" type="button" aria-label="Remove {item.name}" onclick={() => removeAttachment(item.id)}>×</button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if compatNote}
          <p class="notice compat">{compatNote}</p>
        {/if}
        {#if captureError}
          <div class="error" role="status">
            <span>{captureError}</span>
            <button class="link" type="button" onclick={() => (captureError = null)}>Dismiss</button>
          </div>
        {/if}
        {#if attachError}
          <div class="error" role="alert">
            <span>{attachError}</span>
            <button class="link" type="button" onclick={() => (attachError = null)}>Dismiss</button>
          </div>
        {/if}

        {#if configError}
          <div class="error" role="alert">
            <span>Couldn't read API keys: {configError}</span>
            <button class="link" type="button" onclick={loadConfig}>Try again</button>
          </div>
        {:else if config && !config.keys.length}
          <p class="notice">
            No API keys found in {config.envFiles.join(", ") || "the key file"}. Add CEREBRAS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY, or choose another file in Settings → Agents &amp; merging.
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
        {#if inspected}
          <div class="inspect" role="region" aria-label="Attachment preview">
            <div class="inspect-head">
              <span class="inspect-name">{inspected.name}</span>
              <span class="inspect-meta">{inspected.mimeType} · {sizeText(inspected.size)}</span>
              <button class="link" type="button" onclick={() => (inspectedId = null)}>Close</button>
            </div>
            {#if inspected.kind === "image"}
              <img class="inspect-image" src={inspected.url} alt={inspected.name} />
            {:else if inspected.kind === "text"}
              <pre class="inspect-text">{inspected.text.slice(0, INSPECT_TEXT_CHARS)}</pre>
              {#if inspected.text.length > INSPECT_TEXT_CHARS}
                <p class="inspect-note">Showing the first {INSPECT_TEXT_CHARS.toLocaleString()} characters; the whole file is sent.</p>
              {/if}
            {:else}
              <iframe class="inspect-pdf" src={inspected.url} title={inspected.name}></iframe>
            {/if}
          </div>
        {/if}
        {#if result}
          <div class="result md" class:stale={generating && !streamed} bind:this={resultEl} aria-label="Generated text" aria-busy={generating}>{@html renderMarkdown(result)}</div>
        {/if}

        <div class="foot">
          <input type="file" multiple hidden bind:this={fileInput} onchange={onPicked} />
          <button
            class="btn"
            type="button"
            title="Attach images, PDFs, or text files. You can also paste or drop them."
            disabled={attachments.length >= ATTACHMENT_LIMITS.count}
            onclick={() => fileInput?.click()}
          >Attach</button>
          <span class="status" aria-live="polite">{generating ? "Generating…" : preparing ? "Reading files…" : copied ? "Copied." : ""}</span>
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
    padding: 0;
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
    width: 100%;
    height: 100%;
    max-height: none;
    border-color: var(--border-hover);
    box-shadow: none;
  }
  .quick-generate.standalone .foot {
    margin-top: auto;
  }
  .quick-generate:focus {
    outline: none;
  }
  .quick-generate.dropping {
    outline: 2px dashed var(--link);
    outline-offset: -4px;
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
    min-height: 73px;
    max-height: min(40vh, 208px);
    field-sizing: content;
    padding: 14px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: 15px/1.5 var(--sans);
    resize: none;
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
    max-width: none;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    color: var(--text);
    font: 14px/1.6 var(--sans);
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
  .attachments {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    max-height: 72px;
    overflow-y: auto;
    margin: 0;
    padding: 0 12px 10px 16px;
    list-style: none;
  }
  .attachment {
    display: inline-flex;
    align-items: center;
    max-width: min(220px, 100%);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .attachment.inspected {
    box-shadow: inset 0 0 0 1px var(--link);
  }
  .attachment-open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 28px;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--text);
    font: 12px var(--sans);
    cursor: pointer;
  }
  .thumb,
  .badge {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 4px;
  }
  .thumb {
    object-fit: cover;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font: 8.5px var(--mono);
  }
  .attachment-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attachment-remove {
    flex: none;
    width: 24px;
    height: 28px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-faint);
    font: 15px/1 var(--sans);
    cursor: pointer;
  }
  .notice.compat {
    padding: 0 16px 10px;
  }
  .inspect {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 96px;
    overflow: hidden;
    border-top: 1px solid var(--border);
  }
  .inspect-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px 8px 16px;
  }
  .inspect-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font: 500 12.5px var(--sans);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inspect-meta {
    flex: 1;
    color: var(--text-faint);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .inspect-image {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 0 16px 12px;
    object-fit: contain;
  }
  .inspect-pdf {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    border: 0;
  }
  .inspect-text {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 0 16px 12px;
    color: var(--text);
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .inspect-note {
    margin: 0;
    padding: 0 16px 12px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .attachment-open:focus-visible,
  .attachment-remove:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: -2px;
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) {
      background: var(--surface-hover);
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    .attachment-remove:hover {
      color: var(--text);
    }
  }
  @media (max-width: 620px) {
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
