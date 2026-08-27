<script>
  import { relativeTime } from "./time.js";
  import { renderMarkdown, summarize } from "./markdown.js";
  import MutationBadge from "./MutationBadge.svelte";
  import Avatar from "./Avatar.svelte";
  import Reactions from "./Reactions.svelte";
  import Chevron from "./Chevron.svelte";
  import Kbd from "./Kbd.svelte";

  let { thread, pending, onReply, onToggleResolve, onRetry, onDiscard, inline = false } = $props();

  let replyDraft = $state("");
  let replySubmitting = $state(false);
  let resolveSubmitting = $state(false);
  let expanded = $state(false);

  let resolveMutation = $derived(pending.find((m) => m.kind === "resolve-thread"));
  let replyMutations = $derived(pending.filter((m) => m.kind === "reply-to-thread"));
  let effectiveResolved = $derived(
    resolveMutation?.state === "pending" ? resolveMutation.payload.resolved : thread.isResolved,
  );
  let showFull = $derived(!effectiveResolved || expanded);

  let firstComment = $derived(thread.comments.nodes[0]);
  let loc = $derived(`${thread.path}${thread.line !== null ? ":" + thread.line : ""}`);
  let summary = $derived(summarize(firstComment?.body ?? ""));

  function collapseFromHead(e) {
    if (!effectiveResolved) return;
    if (e.target.closest("button")) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e.type === "keydown") e.preventDefault();
    expanded = false;
  }

  let hunkTail = $derived.by(() => {
    if (inline || !firstComment?.diffHunk) return [];
    return firstComment.diffHunk
      .split("\n")
      .filter((l) => !l.startsWith("@@"))
      .slice(-4)
      .map((l) => ({ tone: l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx", text: l.slice(1) }));
  });

  async function submitReply() {
    if (replySubmitting || !replyDraft.trim()) return;
    const rootCommentId = thread.comments.nodes[0]?.databaseId;
    if (!rootCommentId) return;
    replySubmitting = true;
    try {
      await onReply(rootCommentId, replyDraft);
      replyDraft = "";
    } finally {
      replySubmitting = false;
    }
  }

  function onReplyKeydown(e) {
    if (e.isComposing || e.shiftKey || e.altKey) return;
    if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
    e.preventDefault();
    submitReply();
  }

  async function toggleResolve() {
    resolveSubmitting = true;
    try {
      await onToggleResolve();
    } finally {
      resolveSubmitting = false;
    }
  }
</script>

{#if !showFull}
  <button
    class="thread summary-row"
    class:conversation-thread={!inline}
    class:outdated={thread.isOutdated}
    onclick={() => (expanded = true)}
  >
    <Chevron direction="right" />
    <span class="tag resolved">resolved</span>
    <Avatar login={firstComment?.author?.login} url={firstComment?.author?.avatarUrl} size={16} />
    <span class="author">{firstComment?.author?.login ?? "ghost"}</span>
    <span class="loc mono">{loc}</span>
    <span class="summary-text">{summary}</span>
  </button>
{:else}
  <div class="thread" class:conversation-thread={!inline} class:outdated={thread.isOutdated}>
    <div
      class="thread-head"
      class:collapsible={effectiveResolved}
      role="button"
      tabindex="0"
      onclick={collapseFromHead}
      onkeydown={collapseFromHead}
    >
      {#if effectiveResolved}
        <button class="caret-btn" aria-label="Collapse thread" onclick={() => (expanded = false)}><Chevron /></button>
        <span class="tag resolved">resolved</span>
      {:else}
        <span class="tag open">unresolved</span>
      {/if}
      {#if thread.isOutdated}<span class="tag out">outdated</span>{/if}
      <span class="loc">{loc}</span>
      {#if resolveMutation}
        <MutationBadge
          state={resolveMutation.state}
          onRetry={() => onRetry(resolveMutation.id)}
          onDiscard={() => onDiscard(resolveMutation.id)}
        />
      {/if}
      <button class="resolve-btn" disabled={resolveSubmitting || !!resolveMutation} onclick={toggleResolve}>
        {effectiveResolved ? "Unresolve" : "Resolve"}
      </button>
    </div>
    {#if hunkTail.length}
      <div class="hunk mono">
        {#each hunkTail as row}
          <div class="hunk-line {row.tone}">
            <span class="sign">{row.tone === "add" ? "+" : row.tone === "del" ? "−" : " "}</span>{row.text}
          </div>
        {/each}
      </div>
    {/if}
    {#each thread.comments.nodes as comment}
      <div class="comment">
        <div class="comment-head">
          <Avatar login={comment.author?.login} url={comment.author?.avatarUrl} />
          <span class="author">{comment.author?.login ?? "ghost"}</span>
          <span class="when">{relativeTime(comment.createdAt)}</span>
        </div>
        <div class="md">{@html renderMarkdown(comment.body)}</div>
        <Reactions reactions={comment.reactions} />
      </div>
    {/each}
    {#each replyMutations as m (m.id)}
      <div class="comment">
        <div class="comment-head">
          <span class="author">you</span>
          <MutationBadge state={m.state} onRetry={() => onRetry(m.id)} onDiscard={() => onDiscard(m.id)} />
        </div>
        <div class="md">{@html renderMarkdown(m.payload.body)}</div>
      </div>
    {/each}
    <div class="reply">
      <textarea placeholder="Reply…" data-reply-for={thread.id} bind:value={replyDraft} onkeydown={onReplyKeydown}></textarea>
      <button class="btn shortcut-action" disabled={!replyDraft.trim() || replySubmitting} onclick={submitReply}>
        {replySubmitting ? "Posting…" : "Reply"}
        {#if replyDraft.trim() && !replySubmitting}<Kbd keys={["cmd", "enter"]} />{/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .shortcut-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .thread {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-raised);
    padding: 10px 12px;
  }
  .thread.outdated {
    opacity: 0.55;
  }
  .thread.conversation-thread {
    margin-bottom: 14px;
    padding: 16px 18px;
    box-shadow: var(--shadow-surface);
  }
  .summary-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .summary-row:hover {
    border-color: var(--text-faint);
  }
  .summary-row .author {
    color: var(--text-dim);
    font-weight: 600;
    font-size: 11px;
    flex: none;
  }
  /* a long path must not set the row's minimum width, or it widens the whole
     conversation column on a narrow screen */
  .summary-row .loc {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-faint);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary-text {
    flex: 1;
    min-width: 0;
    color: var(--text-faint);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .caret-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 0;
  }
  .thread-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    margin-bottom: 8px;
  }
  .conversation-thread .thread-head {
    margin-bottom: 12px;
  }
  .tag {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
  }
  .tag.open {
    color: var(--review);
    background: var(--review-bg);
  }
  .tag.resolved {
    color: var(--ready);
    background: var(--ready-bg);
  }
  .tag.out {
    color: var(--text-faint);
    background: var(--wait-bg);
  }
  .loc {
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .resolve-btn {
    margin-left: auto;
    background: none;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-dim);
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .resolve-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-faint);
  }
  .resolve-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hunk {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--code-block-bg);
    padding: 6px 0;
    margin-bottom: 10px;
    font-size: 12px;
    line-height: 1.55;
    overflow-x: auto;
  }
  .hunk-line {
    /* the tinted row has to cover the scrolled width, not just the viewport */
    width: max-content;
    min-width: 100%;
    padding: 0 10px;
    white-space: pre;
  }
  .hunk-line.add {
    background: var(--add-bg);
    color: var(--code-fg);
  }
  .hunk-line.del {
    background: var(--del-bg);
    color: var(--code-fg);
  }
  .hunk-line.ctx {
    color: var(--text-dim);
  }
  .hunk-line .sign {
    display: inline-block;
    width: 12px;
    color: var(--text-faint);
  }
  .hunk-line.add .sign {
    color: var(--add-gutter);
  }
  .hunk-line.del .sign {
    color: var(--del-gutter);
  }
  .comment + .comment {
    border-top: 1px solid var(--border-soft);
    margin-top: 8px;
    padding-top: 8px;
  }
  .comment-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 2px;
  }
  .conversation-thread .comment-head {
    margin-bottom: 6px;
  }
  .author {
    color: var(--text);
    font-weight: 600;
  }
  .when {
    color: var(--text-faint);
  }
  .reply {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    border-top: 1px solid var(--border-soft);
    padding-top: 10px;
  }
  .conversation-thread .reply {
    align-items: flex-end;
    gap: 12px;
    margin-top: 16px;
    padding-top: 16px;
  }
  .reply textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    min-height: 32px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12.5px;
    padding: 6px 8px;
  }
  .conversation-thread .reply textarea {
    height: 36px;
    min-height: 36px;
    padding: 7px 12px;
    line-height: 1.45;
  }
  .conversation-thread .reply textarea::-webkit-resizer {
    opacity: 0;
  }
  .reply textarea:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .btn {
    flex: none;
    align-self: flex-start;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    padding: 6px 12px;
    cursor: pointer;
  }
  .conversation-thread .btn {
    min-height: 36px;
    padding: 8px 14px;
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .btn:hover:not(:disabled) {
    border-color: var(--text-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .thread {
    border-radius: 10px;
    background: var(--panel);
    box-shadow: var(--shadow-surface);
  }
  .tag {
    padding: 2px 7px;
    border-radius: 999px;
    font-family: var(--sans);
    letter-spacing: 0.01em;
  }
  .resolve-btn,
  .btn {
    min-height: 32px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
  }
  .resolve-btn:disabled,
  .btn:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
    opacity: 1;
  }
  .conversation-thread .btn:disabled {
    background: var(--brand-disabled);
    box-shadow: none;
    color: var(--on-brand);
  }
  @media (hover: hover) and (pointer: fine) {
    .resolve-btn:hover:not(:disabled),
    .btn:hover:not(:disabled) {
      background: var(--surface);
      border-color: transparent;
    }
    .conversation-thread .btn:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  .resolve-btn:active:not(:disabled),
  .btn:active:not(:disabled) {
    transform: scale(0.99);
  }
  .reply textarea {
    border-radius: 8px;
  }
  .reply textarea:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }

  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .thread {
      padding: 12px;
    }
    .thread-head {
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .thread-head .loc {
      flex: 1 1 auto;
      min-width: 80px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .resolve-btn,
    .btn {
      min-height: var(--mobile-control-min-height);
    }
    .reply {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .reply textarea {
      width: 100%;
      min-height: calc(var(--mobile-control-min-height) + var(--mobile-control-min-height)) !important;
      padding: 10px 12px;
    }
    .reply .btn {
      width: 100%;
      align-self: stretch;
    }
    .reply :global(.kbd) {
      display: none;
    }
  }
</style>
