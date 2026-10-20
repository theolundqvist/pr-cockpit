<script>
  import { tick } from "svelte";
  import { askView, fetchPrDetails, fetchPrDetailSnapshot, fetchPrDiff } from "./api.js";
  import { listedPrs } from "./listedPrs.svelte.js";
  import { isRecordingShortcut } from "./shortcutCapture.js";
  import { isPromptDialogOpen } from "./dom.js";
  import { renderMarkdown } from "./markdown.js";
  import Kbd from "./Kbd.svelte";

  let { route } = $props();

  const PAGE_TITLES = { settings: "Settings", actions: "Actions", actionsRun: "Workflow run", inbox: "Agents" };
  // Cached details are read in batches so a long list never builds one oversized URL.
  const DETAIL_BATCH = 150;

  let open = $state(false);
  let question = $state("");
  let asking = $state(false);
  let error = $state(null);
  let result = $state(null);
  let inputEl = $state(null);
  let request = null;

  let target = $derived(
    route.name === "detail"
      ? { kind: "pr", label: `${route.repo}#${route.number}` }
      : route.name === "inbox" && listedPrs.rows
        ? { kind: "list", label: `${listedPrs.title} · ${listedPrs.rows.length} PR${listedPrs.rows.length === 1 ? "" : "s"}` }
        : { kind: "page", label: PAGE_TITLES[route.name] ?? "This page" },
  );

  async function show() {
    open = true;
    await tick();
    inputEl?.focus();
    inputEl?.select();
  }

  function close() {
    request?.abort();
    open = false;
  }

  async function listView(signal) {
    const rows = listedPrs.rows ?? [];
    const keys = rows.map(({ pr }) => `${pr.repo}#${pr.number}`);
    const batches = [];
    for (let index = 0; index < keys.length; index += DETAIL_BATCH) batches.push(keys.slice(index, index + DETAIL_BATCH));
    const settled = await Promise.allSettled(batches.map((batch) => fetchPrDetails(batch)));
    if (signal.aborted) return null;
    const details = Object.assign({}, ...settled.map((entry) => (entry.status === "fulfilled" ? entry.value : {})));
    return {
      kind: "list",
      title: listedPrs.title,
      prs: rows.map(({ pr, section }, index) => ({
        key: keys[index],
        title: pr.title,
        author: pr.author,
        state: pr.state,
        isDraft: pr.isDraft,
        ciStatus: pr.ciStatus,
        reviewDecision: pr.reviewDecision,
        labels: (pr.labels ?? []).map((label) => label.name),
        section,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        body: details[keys[index]]?.body ?? "",
      })),
    };
  }

  async function prView(signal) {
    const [snapshot, diff] = await Promise.all([
      fetchPrDetailSnapshot(route.repo, route.number, { prefetch: true, view: false }),
      fetchPrDiff(route.repo, route.number, null, signal, true),
    ]);
    if (!snapshot) throw new Error("This PR hasn't loaded yet.");
    return {
      kind: "pr",
      key: `${route.repo}#${route.number}`,
      detail: snapshot.detail,
      diff: diff.ok ? new TextDecoder().decode(diff.bytes) : null,
    };
  }

  // innerText drops icon-only status markers, so their accessible names are read in their place.
  function pageText(root) {
    if (!root) return "";
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || !node.checkVisibility() || node.getAttribute("aria-hidden") === "true") return;
      const label = node.getAttribute("aria-label");
      if (label && !node.textContent.trim()) parts.push(` ${label} `);
      else for (const child of node.childNodes) walk(child);
      if (!getComputedStyle(node).display.startsWith("inline")) parts.push("\n");
    };
    walk(root);
    return parts.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function ask() {
    if (asking || !question.trim()) return;
    const controller = new AbortController();
    request = controller;
    asking = true;
    error = null;
    const label = target.label;
    if (result?.label !== label) result = null;
    try {
      const kind = target.kind;
      const view = kind === "list"
        ? await listView(controller.signal)
        : kind === "pr"
          ? await prView(controller.signal)
          : { kind: "page", title: label, text: pageText(document.querySelector(".app-main")) };
      if (!view) return;
      const answer = await askView({ question, view }, controller.signal);
      const titles = new Map(kind === "list" ? view.prs.map((pr) => [pr.key, pr.title]) : []);
      if (!controller.signal.aborted) result = { ...answer, label, titles };
    } catch (e) {
      if (!controller.signal.aborted) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (request === controller) asking = false;
    }
  }

  function openPr(key) {
    const [repo, number] = key.split("#");
    location.hash = `#/pr/${repo}/${number}`;
    close();
  }

  $effect(() => () => request?.abort());

  $effect(() => {
    function onKey(e) {
      if (isRecordingShortcut()) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "KeyJ") {
        if (!open && isPromptDialogOpen()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        show();
        return;
      }
      if (!open) return;
      // Keys typed here belong to the question, not to shortcuts underneath.
      e.stopImmediatePropagation();
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && !e.shiftKey && e.target === inputEl && !e.isComposing) ask();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

{#if open}
  <div class="scrim" onmousedown={close} role="presentation">
    <div class="ask" role="dialog" aria-label="Ask" data-prompt-dialog tabindex="-1" onmousedown={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="title">Ask about {target.label}</span>
        <span class="esc">esc</span>
      </div>
      <textarea
        class="question"
        bind:this={inputEl}
        bind:value={question}
        rows="2"
        placeholder={target.kind === "list" ? "Which of these…" : "What about this…"}
        spellcheck="true"
        aria-label="Question"
      ></textarea>

      {#if error}
        <div class="error" role="alert">{error}</div>
      {/if}

      {#if result}
        <div class="result" class:stale={asking} aria-busy={asking}>
          {#if result.label !== target.label}<p class="was">About {result.label}</p>{/if}
          <div class="answer md">{@html renderMarkdown(result.answer)}</div>
          {#if result.matches?.length}
            <ul class="matches" aria-label="Matching PRs">
              {#each result.matches as match (match.key)}
                <li>
                  <button type="button" class="match" onclick={() => openPr(match.key)}>
                    <span class="match-title">{result.titles.get(match.key) ?? match.key}</span>
                    <span class="match-key">{match.key}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if result.matches}
            <p class="meta">No PR matched.</p>
          {/if}
          {#if result.filters.length}
            <p class="meta">Checked {result.filters.map((filter) => `“${filter}”`).join(", then ")}</p>
          {/if}
          {#if result.sources?.length}
            <p class="meta">From {[...new Set(result.sources.map((source) => source.label))].join(" · ")}</p>
          {/if}
          {#if result.skipped}<p class="meta">Skipped {result.skipped} parts too large to read.</p>{/if}
        </div>
      {/if}

      <div class="foot">
        <span class="status" aria-live="polite">
          {#if asking}Reading…{:else if result}Qwen on {result.provider}{result.fallback ? ` (${result.fallback})` : ""}{/if}
        </span>
        <button class="btn primary" type="button" disabled={asking || !question.trim()} onclick={ask}>
          {asking ? "Asking…" : "Ask"}
          {#if !asking && question.trim()}<Kbd keys="enter" />{/if}
        </button>
      </div>
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
  .ask {
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
  .ask:focus {
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
    overflow: hidden;
    color: var(--text);
    font: 500 14px var(--sans);
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .question {
    flex: none;
    width: 100%;
    box-sizing: border-box;
    min-height: 64px;
    max-height: 30vh;
    padding: 14px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: 15px/1.5 var(--sans);
    resize: none;
  }
  .question:focus {
    outline: none;
  }
  .question::placeholder {
    color: var(--text-faint);
  }
  .error {
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
  .result {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    color: var(--text);
    font: 14px/1.6 var(--sans);
    overflow-wrap: anywhere;
    user-select: text;
  }
  .result.stale {
    opacity: 0.55;
  }
  .was,
  .meta {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }
  .was {
    margin-bottom: 6px;
  }
  .meta {
    margin-top: 10px;
  }
  .matches {
    margin: 10px -8px 0;
    padding: 0;
    list-style: none;
  }
  .match {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: 13px var(--sans);
    text-align: left;
    cursor: pointer;
  }
  .match-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .match-key {
    flex: none;
    color: var(--text-faint);
    font: 11.5px var(--mono);
  }
  .match:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: -2px;
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
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    padding: 6px 14px;
    border: 0;
    border-radius: 999px;
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
  .btn:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  @media (hover: hover) and (pointer: fine) {
    .match:hover {
      background: var(--surface-hover);
    }
    .btn.primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .scrim {
      backdrop-filter: none;
    }
  }
</style>
