<script>
  import { tick, untrack } from "svelte";
  import { fetchAgentConversations, fetchAgentRunDetail } from "./api.js";
  import { prefs } from "./prefs.svelte.js";
  import { prKeyOf } from "./prKey.js";
  import { durationText, relativeTime } from "./time.js";
  import { agentLabel, runHealth, runStateLabel, runTone } from "./agentRuns.js";
  import AgentTranscript from "./AgentTranscript.svelte";

  let { active = true, refreshRevision = 0 } = $props();

  const POLL_MS = 5000;

  let conversations = $state([]);
  let listState = $state("loading");
  let listError = $state(null);
  let listSeq = 0;
  let listInFlight = false;

  let selectedKey = $state(null);
  let selectedRunId = $state(null);
  let runDetail = $state(null);
  let detailState = $state("idle");
  let detailError = $state(null);
  let refreshError = $state(null);
  let showRawLog = $state(false);
  let detailSeq = 0;
  let detailRefreshing = false;
  let detailEl = $state(null);

  let selected = $derived(conversations.find((c) => prKeyOf(c.repo, c.number) === selectedKey) ?? null);

  async function loadConversations({ background = false } = {}) {
    if (background && listInFlight) return;
    const seq = ++listSeq;
    listInFlight = true;
    try {
      const next = await fetchAgentConversations();
      if (seq !== listSeq) return;
      conversations = next;
      listError = null;
      listState = "ready";
      // A removed session takes its transcript with it; never keep showing a vanished selection.
      if (selectedKey && !next.some((c) => prKeyOf(c.repo, c.number) === selectedKey)) clearSelection();
      const currentRun = selected?.runs.find((run) => run.id === selectedRunId);
      const displayedRun = runDetail?.run;
      if (currentRun && displayedRun && (
        currentRun.state !== displayedRun.state ||
        currentRun.ended_at !== displayedRun.ended_at ||
        currentRun.exit_reason !== displayedRun.exit_reason
      )) refreshRunDetail();
    } catch (error) {
      if (seq !== listSeq) return;
      listError = error instanceof Error ? error.message : String(error);
      if (listState !== "ready") listState = "error";
    } finally {
      if (seq === listSeq) listInFlight = false;
    }
  }

  function clearSelection() {
    selectedKey = null;
    selectedRunId = null;
    runDetail = null;
    detailState = "idle";
    detailError = null;
    refreshError = null;
    detailSeq++;
  }

  function selectConversation(conversation) {
    const key = prKeyOf(conversation.repo, conversation.number);
    if (key === selectedKey) return;
    selectedKey = key;
    const newest = conversation.runs[0];
    if (newest) selectRun(newest.id);
    else {
      selectedRunId = null;
      runDetail = null;
      detailState = "idle";
      detailError = null;
      refreshError = null;
      detailSeq++;
    }
  }

  async function selectRun(id) {
    const seq = ++detailSeq;
    selectedRunId = id;
    runDetail = null;
    showRawLog = false;
    detailState = "loading";
    detailError = null;
    refreshError = null;
    try {
      const detail = await fetchAgentRunDetail(id);
      if (seq !== detailSeq) return;
      runDetail = detail;
      detailState = detail ? "ready" : "missing";
    } catch (error) {
      if (seq !== detailSeq) return;
      detailError = error instanceof Error ? error.message : String(error);
      detailState = "error";
    }
  }

  // Refreshes the open run in place, keeping expanded tool calls and the raw-log toggle; follows the tail only if the reader is already there.
  async function refreshRunDetail() {
    if (detailRefreshing) return;
    const seq = detailSeq;
    const id = selectedRunId;
    detailRefreshing = true;
    let detail;
    try {
      detail = await fetchAgentRunDetail(id);
    } catch (error) {
      if (seq === detailSeq && active) refreshError = error instanceof Error ? error.message : String(error);
      return;
    } finally {
      detailRefreshing = false;
    }
    if (seq !== detailSeq || id !== selectedRunId || !active || !detail) return;
    const scroller = scrollParent(detailEl);
    const atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40 : false;
    runDetail = detail;
    refreshError = null;
    if (atBottom) {
      await tick();
      scroller.scrollTop = scroller.scrollHeight;
    }
  }

  function scrollParent(element) {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  }

  $effect(() => {
    refreshRevision;
    if (!active) return;
    untrack(() => {
      loadConversations();
      if (runDetail?.run.state === "running") refreshRunDetail();
    });
    const timer = setInterval(() => {
      loadConversations({ background: true });
      if (selectedRunId && runDetail?.run.state === "running") refreshRunDetail();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  // The persisted agent row predates run history for older sessions, so the newer of the two decides the state.
  function latestSession(conversation) {
    const run = conversation.runs[0];
    if (!run) return conversation.agent;
    if (!conversation.agent) return run;
    return conversation.agent.started_at > run.started_at ? conversation.agent : run;
  }

  function lastActivity(conversation) {
    let latest = conversation.agent?.started_at ?? "";
    for (const run of conversation.runs) {
      const at = run.ended_at ?? run.started_at;
      if (at > latest) latest = at;
    }
    return latest;
  }

  function runTimeText(run) {
    if (run.state === "running") return `started ${relativeTime(run.started_at)}`;
    return run.ended_at ? `${relativeTime(run.ended_at)} · ran ${durationText(run.started_at, run.ended_at)}` : relativeTime(run.started_at);
  }
</script>

<div class="agents-view">
  {#if listState === "loading" && !conversations.length}
    <div class="empty" role="status">Loading agent conversations…</div>
  {:else if listState === "error" && !conversations.length}
    <div class="empty error" role="alert">
      Couldn’t load agent conversations: {listError}
      <button class="link" onclick={() => loadConversations()}>Retry</button>
    </div>
  {:else if !conversations.length}
    <div class="empty" role="status">No agent sessions yet. Agents started on a PR appear here.</div>
  {:else}
    <div class="agents-layout">
      <nav class="chat-list" aria-label="Agent conversations">
        {#if listError}
          <div class="list-error" role="alert">
            Couldn’t refresh: {listError}
            <button class="link" onclick={() => loadConversations()}>Retry</button>
          </div>
        {/if}
        {#each conversations as conversation (prKeyOf(conversation.repo, conversation.number))}
          {@const session = latestSession(conversation)}
          {@const activity = lastActivity(conversation)}
          <button
            class="chat"
            class:active={selectedKey === prKeyOf(conversation.repo, conversation.number)}
            aria-current={selectedKey === prKeyOf(conversation.repo, conversation.number) ? "true" : undefined}
            onclick={() => selectConversation(conversation)}
          >
            <span class="chat-dot {session ? runHealth(session) : 'idle'}" aria-hidden="true"></span>
            <span class="chat-main">
              <span class="chat-top">
                <span class="chat-title">{conversation.title || `${conversation.repo}#${conversation.number}`}</span>
                {#if activity}<time class="chat-time" datetime={activity}>{relativeTime(activity)}</time>{/if}
              </span>
              <span class="chat-meta">
                <span class="mono">{conversation.repo}#{conversation.number}</span>
                {#if session}<span>· {agentLabel(session, prefs.agents)}</span>{/if}
                {#if conversation.runs.length > 1}<span>· {conversation.runs.length} runs</span>{/if}
              </span>
              <span class="chat-preview">
                {#if session}<span class="badge {runTone(session)}">{runStateLabel(session)}</span>{/if}
                <span class="chat-brief">{conversation.runs[0] ? conversation.runs[0].brief.trim().split("\n")[0] : "No recorded runs"}</span>
              </span>
            </span>
          </button>
        {/each}
      </nav>

      <section class="chat-detail" bind:this={detailEl} aria-label="Agent conversation">
        {#if !selected}
          <div class="empty">Select a conversation</div>
        {:else}
          {@const session = latestSession(selected)}
          <header class="detail-head">
            <div class="detail-title-row">
              <h2 class="detail-title">{selected.title || `${selected.repo}#${selected.number}`}</h2>
              <a class="link" href="#/pr/{selected.repo}/{selected.number}/agents">Open PR</a>
            </div>
            <div class="detail-meta">
              <span class="mono">{selected.repo}#{selected.number}</span>
              {#if session}
                <span>· {agentLabel(session, prefs.agents)}</span>
                <span class="badge {runTone(session)}">{runStateLabel(session)}</span>
              {/if}
            </div>
          </header>

          {#if selected.runs.length}
            <div class="run-list" role="group" aria-label="Runs">
              {#each selected.runs as run (run.id)}
                <button class="run-chip" class:active={selectedRunId === run.id} aria-current={selectedRunId === run.id ? "true" : undefined} onclick={() => selectRun(run.id)} title={run.brief}>
                  <span class="badge {runTone(run)}">{agentLabel(run, prefs.agents)} {runStateLabel(run)}</span>
                  <span class="run-time">{runTimeText(run)}</span>
                </button>
              {/each}
            </div>
          {:else}
            <div class="empty">No transcript was recorded for this session{selected.agent ? ` (started ${relativeTime(selected.agent.started_at)})` : ""}.</div>
          {/if}

          {#if selectedRunId}
            {#if detailState === "loading"}
              <div class="empty" role="status">Loading…</div>
            {:else if detailState === "error"}
              <div class="empty error" role="alert">
                Couldn’t load this run: {detailError}
                <button class="link" onclick={() => selectRun(selectedRunId)}>Retry</button>
              </div>
            {:else if detailState === "missing"}
              <div class="empty">This run’s transcript is no longer available.</div>
            {:else if runDetail}
              <div class="run-detail-head">
                <span class="badge {runTone(runDetail.run)}">{agentLabel(runDetail.run, prefs.agents)} {runDetail.run.state}</span>
                <span class="run-time">
                  {relativeTime(runDetail.run.started_at)}
                  {#if runDetail.run.ended_at} · ran {durationText(runDetail.run.started_at, runDetail.run.ended_at)}{/if}
                </span>
                {#if runDetail.run.exit_reason}<span class="run-time">{runDetail.run.exit_reason}</span>{/if}
                <button class="link" onclick={() => (showRawLog = !showRawLog)}>{showRawLog ? "hide raw log" : "raw log"}</button>
              </div>
              {#if refreshError}<div class="list-error" role="alert">Couldn’t refresh this run: {refreshError}</div>{/if}
              <div class="run-brief">{runDetail.run.brief}</div>
              {#if !showRawLog && !runDetail.turns?.length}
                <div class="empty">{runDetail.run.state === "running" ? "Waiting for the agent’s first message…" : "No transcript output was recorded."}</div>
              {:else}
                <AgentTranscript turns={runDetail.turns ?? []} rawLog={runDetail.rawLog} {showRawLog} />
              {/if}
            {/if}
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .agents-view {
    padding: 4px 0 24px;
  }
  .agents-layout {
    display: grid;
    grid-template-columns: minmax(0, min(340px, 40%)) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  .chat-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .chat {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .chat.active {
    border-color: var(--text-dim);
  }
  .chat:focus-visible,
  .run-chip:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .chat-dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--wait);
  }
  .chat-dot.running {
    background: var(--review);
  }
  .chat-dot.failed {
    background: var(--fail);
  }
  .chat-dot.succeeded {
    background: var(--ready);
  }
  .chat-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .chat-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .chat-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .chat-time,
  .run-time {
    flex: none;
    color: var(--text-faint);
    font-size: 11px;
  }
  .chat-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
    color: var(--text-dim);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .chat-preview {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
  }
  .chat-brief {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
  .chat-detail {
    min-width: 0;
  }
  .detail-head {
    margin-bottom: 12px;
  }
  .detail-title-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .detail-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .run-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 14px;
  }
  .run-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: inherit;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .run-chip.active {
    border-color: var(--text-dim);
  }
  .run-detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .run-brief {
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .empty {
    padding: 12px 0;
    color: var(--text-faint);
    font-size: 12px;
  }
  .empty.error,
  .list-error {
    color: var(--fail);
  }
  .list-error {
    font-size: 12px;
    margin-bottom: 6px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover {
    color: var(--text);
  }
</style>
