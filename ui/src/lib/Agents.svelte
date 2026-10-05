<script>
  import { tick, untrack } from "svelte";
  import { fetchAgentConversations, fetchAgentRunDetail } from "./api.js";
  import { prefs } from "./prefs.svelte.js";
  import { prKeyOf } from "./prKey.js";
  import { durationText, relativeTime } from "./time.js";
  import { agentLabel } from "./agentRuns.js";
  import {
    agentsHref,
    canonicalAgentsRoute,
    groupSessionEntries,
    isAgentsHash,
    parseAgentsRoute,
    resolveAgentsSelection,
    sameAgentsRoute,
    sessionActivity,
    sessionEntries,
    sessionTitle,
    workspaceStatus,
  } from "./agentWorkspace.js";
  import AgentTranscript from "./AgentTranscript.svelte";
  import Chevron from "./Chevron.svelte";

  let { active = true, refreshRevision = 0 } = $props();

  const POLL_MS = 5000;
  const READING_MODES = [
    { value: "conversation", label: "Conversation" },
    { value: "log", label: "Log tail" },
  ];
  // Within this distance of the end the reader counts as following live output.
  const FOLLOW_SLACK_PX = 48;
  const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  let conversations = $state([]);
  let listState = $state("loading");
  let listError = $state(null);
  let listSeq = 0;
  let listInFlight = false;

  // The URL owns selection; `route` is the settled request and is only rewritten when the hash changes.
  let route = $state(parseAgentsRoute(location.hash) ?? { kind: "latest" });
  let selection = $derived(listState === "ready" ? resolveAgentsSelection(route, conversations) : null);
  let conversation = $derived(selection?.conversation ?? null);
  let selectedKey = $derived(conversation ? prKeyOf(conversation.repo, conversation.number) : null);
  let selectedRunId = $derived(selection?.status === "ready" ? selection.runId : null);
  let selectedRun = $derived(conversation?.runs.find((run) => run.id === selectedRunId) ?? null);
  let latestRun = $derived(conversation?.runs[0] ?? null);
  let historical = $derived(Boolean(selectedRun && latestRun && selectedRun.id !== latestRun.id));
  let headRow = $derived(selection?.status === "ready" ? selectedRun : selection?.status === "no-runs" ? conversation?.agent : null);
  let headStatus = $derived(headRow ? workspaceStatus(headRow) : null);

  let query = $state("");
  let entries = $derived(sessionEntries(conversations, query.trim(), (row) => agentLabel(row, prefs.agents)));
  let groups = $derived(groupSessionEntries(entries));
  let orderedEntries = $derived(groups.flatMap((group) => group.entries));
  let focusKey = $derived(orderedEntries.some((entry) => entry.key === selectedKey) ? selectedKey : (orderedEntries[0]?.key ?? null));

  let detail = $state(null);
  let detailRunId = $state(null);
  let detailState = $state("idle");
  let detailError = $state(null);
  let refreshError = $state(null);
  let detailSeq = 0;
  const refreshingRuns = new Set();

  // Component memory only: each run keeps its reading mode, and each run+mode its scroll offset.
  const runModes = new Map();
  const readingOffsets = new Map();
  let mode = $state("conversation");
  let following = $state(true);
  let overflowing = $state(false);
  let newOutput = $state(false);
  let taskExpanded = $state(false);
  let taskOverflow = $state(false);
  let taskText = $state(null);
  // An offset waiting for asynchronous content (images, diagrams) to grow tall enough to restore it.
  let pendingOffset = null;

  let historyOpen = $state(false);
  let headHeight = $state(0);

  let root = $state(null);
  let searchInput = $state(null);
  let listEl = $state(null);
  let scroller = $state(null);
  let content = $state(null);
  let historyTrigger = $state(null);
  let historyPanel = $state(null);

  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function ago(iso) {
    const relative = relativeTime(iso);
    return relative === "now" ? "just now" : `${relative} ago`;
  }

  function when(iso) {
    return DATE_TIME.format(new Date(iso));
  }

  function runTiming(row) {
    if (row.state === "running") return `started ${ago(row.started_at)}`;
    if (row.ended_at) return `ended ${ago(row.ended_at)} · ran ${durationText(row.started_at, row.ended_at)}`;
    return `started ${ago(row.started_at)}`;
  }

  function repoName(repo) {
    return repo.slice(repo.indexOf("/") + 1);
  }

  function runNumber(conv, runId) {
    const index = conv.runs.findIndex((run) => run.id === runId);
    return index === -1 ? null : conv.runs.length - index;
  }

  async function loadConversations({ background = false } = {}) {
    if (background && listInFlight) return;
    const seq = ++listSeq;
    listInFlight = true;
    try {
      const next = await fetchAgentConversations();
      if (seq !== listSeq) return;
      const firstLoad = listState !== "ready";
      conversations = next;
      listError = null;
      listState = "ready";
      if (firstLoad) settleRoute();
      reconcileRun();
    } catch (error) {
      if (seq !== listSeq) return;
      listError = errorText(error);
      if (listState !== "ready") listState = "error";
    } finally {
      if (seq === listSeq) listInFlight = false;
    }
  }

  function retryList() {
    if (listState !== "ready") listState = "loading";
    loadConversations();
  }

  // Resolves the current Agents hash; a bare or run-less link settles to an explicit run in place, never as a new entry.
  function settleRoute() {
    const requested = parseAgentsRoute(location.hash);
    if (!requested) return;
    let next = requested;
    if (listState === "ready") {
      const canonical = canonicalAgentsRoute(requested, conversations);
      if (canonical) {
        window.history.replaceState(window.history.state, "", agentsHref(canonical.repo, canonical.number, canonical.runId));
        next = canonical;
      }
    }
    if (!sameAgentsRoute(next, route)) route = next;
    if (historyOpen) closeHistory(historyPanel?.contains(document.activeElement) ?? false);
    revealSelectedSession();
  }

  async function revealSelectedSession() {
    await tick();
    const link = listEl?.querySelector("a.session[aria-current]");
    if (!link) return;
    const box = link.getBoundingClientRect();
    const view = listEl.getBoundingClientRect();
    // the sticky group label covers the top of the list
    const top = view.top + 34;
    if (box.top < top) listEl.scrollTop -= top - box.top;
    else if (box.bottom > view.bottom - 8) listEl.scrollTop += box.bottom - view.bottom + 8;
  }

  $effect(() => {
    const onHash = () => {
      // While a PR page or another view owns the hash, the selection stays where the reader left it.
      if (isAgentsHash(location.hash)) settleRoute();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  $effect(() => {
    const id = selectedRunId;
    untrack(() => openRun(id));
  });

  function ownsRun(next) {
    return Boolean(conversation && next.run.id === detailRunId && next.run.repo === conversation.repo && next.run.number === conversation.number);
  }

  async function openRun(id, { force = false } = {}) {
    if (id === detailRunId && !force) return;
    const seq = ++detailSeq;
    detailRunId = id;
    detail = null;
    detailError = null;
    refreshError = null;
    following = true;
    overflowing = false;
    newOutput = false;
    taskExpanded = false;
    taskOverflow = false;
    pendingOffset = null;
    mode = (id !== null && runModes.get(id)) || "conversation";
    if (id === null) {
      detailState = "idle";
      return;
    }
    detailState = "loading";
    try {
      const next = await fetchAgentRunDetail(id);
      if (seq !== detailSeq) return;
      if (!next || !ownsRun(next)) {
        detailState = "missing";
        return;
      }
      detail = next;
      detailState = "ready";
      await tick();
      if (seq === detailSeq) restoreReading();
    } catch (error) {
      if (seq !== detailSeq) return;
      detailError = errorText(error);
      detailState = "error";
    }
  }

  // Refreshes the open run in place, so expanded tools and the reading mode survive; follows the end only while the reader is there.
  async function refreshRun() {
    const id = detailRunId;
    if (id === null || detailState !== "ready" || refreshingRuns.has(id)) return;
    const seq = detailSeq;
    refreshingRuns.add(id);
    let next;
    try {
      next = await fetchAgentRunDetail(id);
    } catch (error) {
      if (seq === detailSeq) refreshError = errorText(error);
      return;
    } finally {
      refreshingRuns.delete(id);
    }
    if (seq !== detailSeq) return;
    if (!next || !ownsRun(next)) {
      detail = null;
      detailState = "missing";
      return;
    }
    const follow = following;
    if (!follow && next.rawLog !== detail.rawLog) newOutput = true;
    detail = next;
    refreshError = null;
    if (follow) {
      await tick();
      if (seq === detailSeq && following) scrollToEnd();
    }
  }

  // The list can see a run end before the transcript does; refetch so state, end time, reason and final output agree.
  function reconcileRun() {
    if (detailState !== "ready" || !detail) return;
    const listed = conversation?.runs.find((run) => run.id === detailRunId);
    if (!listed) return;
    const shown = detail.run;
    if (listed.state !== shown.state || listed.ended_at !== shown.ended_at || listed.exit_reason !== shown.exit_reason) refreshRun();
  }

  $effect(() => {
    refreshRevision;
    if (!active) return;
    untrack(() => {
      loadConversations();
      if (detail?.run.state === "running") refreshRun();
    });
    const timer = setInterval(() => {
      loadConversations({ background: true });
      if (detail?.run.state === "running") refreshRun();
    }, POLL_MS);
    return () => clearInterval(timer);
  });

  function readingKey() {
    return `${detailRunId}:${mode}`;
  }

  function measureOverflow() {
    overflowing = scroller.scrollHeight > scroller.clientHeight + 1;
  }

  function scrollToEnd() {
    following = true;
    newOutput = false;
    if (scroller?.clientHeight) scroller.scrollTop = scroller.scrollHeight;
  }

  // Opening a run starts at its latest output and outcome unless this run and mode were already being read.
  function restoreReading() {
    if (detailState !== "ready" || !scroller?.clientHeight) return;
    measureOverflow();
    const saved = readingOffsets.get(readingKey());
    if (!saved || saved.following) {
      pendingOffset = null;
      scrollToEnd();
      return;
    }
    following = false;
    scroller.scrollTop = saved.top;
    pendingOffset = Math.abs(scroller.scrollTop - saved.top) > 2 ? saved.top : null;
  }

  function onReaderScroll(event) {
    // a hidden reader reports zero geometry; a run still loading has nothing to remember yet
    if (event.currentTarget !== scroller || !scroller.clientHeight || detailState !== "ready") return;
    const top = scroller.scrollTop;
    if (pendingOffset !== null) {
      if (Math.abs(top - pendingOffset) > 2) return;
      pendingOffset = null;
    }
    following = scroller.scrollHeight - top - scroller.clientHeight <= FOLLOW_SLACK_PX;
    if (following) newOutput = false;
    measureOverflow();
    readingOffsets.set(readingKey(), { top, following });
  }

  function releaseRestore(event) {
    if (scroller?.contains(event.target)) pendingOffset = null;
  }

  function jumpToLatest() {
    pendingOffset = null;
    scrollToEnd();
    scroller?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      if (!scroller?.clientHeight || detailState !== "ready") return;
      measureOverflow();
      if (following) {
        scroller.scrollTop = scroller.scrollHeight;
      } else if (pendingOffset !== null) {
        scroller.scrollTop = pendingOffset;
        if (Math.abs(scroller.scrollTop - pendingOffset) <= 2) pendingOffset = null;
      }
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  });
  $effect(() => {
    const text = taskText;
    if (!text || taskExpanded) return;
    const observer = new ResizeObserver(() => {
      if (taskText === text && !taskExpanded) taskOverflow = text.scrollHeight > text.clientHeight + 1;
    });
    observer.observe(text);
    return () => observer.disconnect();
  });


  // A hidden reader can lose its offset; returning (e.g. Back from Open PR) puts the reader where it was.
  $effect(() => {
    if (!active) return;
    untrack(() => tick().then(restoreReading));
  });

  async function setMode(next) {
    if (next === mode || detailRunId === null) return;
    mode = next;
    runModes.set(detailRunId, next);
    pendingOffset = null;
    newOutput = false;
    await tick();
    restoreReading();
  }

  async function openHistory() {
    historyOpen = true;
    await tick();
    (historyPanel?.querySelector("a[aria-current]") ?? historyPanel?.querySelector("a"))?.focus();
  }

  function closeHistory(restoreFocus) {
    if (!historyOpen) return;
    historyOpen = false;
    if (restoreFocus) historyTrigger?.focus();
  }

  function onHistoryFocusOut(event) {
    if (!historyPanel?.contains(event.target)) return;
    const next = event.relatedTarget;
    if (next && (historyPanel?.contains(next) || historyTrigger?.contains(next))) return;
    closeHistory(false);
  }

  function moveFocus(event, links, onBeforeFirst = null) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const index = links.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && index === 0 && onBeforeFirst) {
      onBeforeFirst();
      return;
    }
    const target = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
    links[Math.max(0, Math.min(links.length - 1, target))]?.focus();
  }

  function sessionLinks() {
    return listEl ? [...listEl.querySelectorAll("a.session")] : [];
  }

  function onSearchKeydown(event) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      const first = orderedEntries[0];
      if (!first) return;
      event.preventDefault();
      location.hash = agentsHref(first.conversation.repo, first.conversation.number);
    } else if (event.key === "ArrowDown") {
      const first = sessionLinks()[0];
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  }

  function clearSearch() {
    query = "";
    searchInput?.focus();
  }

  // Escape unwinds one layer at a time: run history, then the search text, then focus.
  function onWorkspaceKeydown(event) {
    releaseRestore(event);
    if (event.defaultPrevented || event.isComposing) return;
    if (event.target.closest?.(".modes") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = READING_MODES.findIndex((readingMode) => readingMode.value === mode);
      const next = READING_MODES[event.key === "Home" ? 0 : event.key === "End" ? READING_MODES.length - 1 : (index + 1) % READING_MODES.length].value;
      setMode(next).then(() => document.getElementById(`agents-mode-${next}`)?.focus());
      return;
    }
    if (historyPanel?.contains(event.target)) moveFocus(event, [...historyPanel.querySelectorAll("a.history-run")]);
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (historyOpen) {
      event.preventDefault();
      closeHistory(true);
      return;
    }
    const focused = document.activeElement;
    if (focused === searchInput && query) {
      event.preventDefault();
      query = "";
      return;
    }
    if (focused && focused !== document.body && root?.contains(focused)) {
      event.preventDefault();
      focused.blur();
    }
  }
</script>

<div class="agents-workspace" bind:this={root} onkeydown={onWorkspaceKeydown} onfocusout={onHistoryFocusOut} onwheel={releaseRestore} onpointerdown={releaseRestore} ontouchstart={releaseRestore} role="presentation">
  <aside class="sessions" aria-label="Agent sessions">
    <div class="search" role="search">
      <label class="search-field">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.75" cy="8.75" r="4.75" /><path d="m12.25 12.25 3.5 3.5" /></svg>
        <span class="sr-only">Search agent sessions</span>
        <input
          bind:this={searchInput}
          bind:value={query}
          onkeydown={onSearchKeydown}
          placeholder="Search sessions"
          aria-controls="agents-session-list"
          aria-describedby="agents-search-count"
          spellcheck="false"
          autocomplete="off"
        />
        {#if query}<button class="search-clear" type="button" aria-label="Clear search" onclick={clearSearch}>×</button>{/if}
      </label>
      <span class="sr-only" id="agents-search-count" aria-live="polite">{query.trim() ? `${entries.length} matching ${entries.length === 1 ? "session" : "sessions"}` : ""}</span>
    </div>

    {#if listError && listState === "ready"}
      <div class="list-alert" role="alert">
        Couldn’t refresh sessions: {listError}
        <button class="text-button" type="button" onclick={() => loadConversations()}>Retry</button>
      </div>
    {/if}

    <div class="session-list" id="agents-session-list" bind:this={listEl} onkeydown={(event) => moveFocus(event, sessionLinks(), () => searchInput?.focus())} role="presentation">
      {#if listState === "loading"}
        <p class="list-note" role="status">Loading sessions…</p>
      {:else if listState === "error"}
        <div class="list-note error" role="alert">
          Couldn’t load agent sessions: {listError}
          <button class="text-button" type="button" onclick={retryList}>Retry</button>
        </div>
      {:else if !conversations.length}
        <p class="list-note">No sessions yet.</p>
      {:else if !entries.length}
        <p class="list-note">
          No sessions match “{query.trim()}”.
          <button class="text-button" type="button" onclick={clearSearch}>Clear search</button>
        </p>
      {:else}
        {#each groups as group (group.id)}
          <section class="group" aria-labelledby="agents-group-{group.id}">
            <h3 class="group-label" id="agents-group-{group.id}">
              <span>{group.label}</span>
              <span class="group-count">{group.entries.length}</span>
            </h3>
            <ul class="group-list">
              {#each group.entries as entry (entry.key)}
                {@const item = entry.conversation}
                {@const activity = sessionActivity(item)}
                <li>
                  <a
                    class="session"
                    class:selected={entry.key === selectedKey}
                    href={agentsHref(item.repo, item.number)}
                    aria-current={entry.key === selectedKey ? "true" : undefined}
                    tabindex={entry.key === focusKey ? 0 : -1}
                  >
                    <span class="dot {entry.status.tone}" title={entry.status.label} aria-hidden="true"></span>
                    <span class="session-body">
                      <span class="session-title" title={sessionTitle(item)}>{sessionTitle(item)}</span>
                      <span class="session-meta">
                        <span class="sr-only">{entry.status.label}{entry.status.reason ? `, ${entry.status.reason}` : ""}.</span>
                        <span class="session-ref" title="{item.repo}#{item.number}">{repoName(item.repo)}#{item.number}</span>
                        {#if entry.statusRow}<span class="session-agent">{agentLabel(entry.statusRow, prefs.agents)}</span>{/if}
                        {#if activity}<time class="session-time" datetime={activity} title={when(activity)}>{relativeTime(activity)}</time>{/if}
                      </span>
                      {#if entry.snippet}<span class="session-snippet">{entry.snippet}</span>{/if}
                    </span>
                  </a>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>
  </aside>

  <section class="pane" aria-label="Agent conversation">
    {#if selection === null}
      <!-- the session list reports loading and load failures -->
    {:else if selection.status === "invalid"}
      <div class="notice">
        <h2>This link doesn’t point to an agent session</h2>
        {#if conversations.length}
          <p>Choose a session from the list.</p>
          <p class="notice-actions"><a class="text-link" href="#/agents">Open the latest session</a></p>
        {/if}
      </div>
    {:else if selection.status === "missing-session"}
      <div class="notice">
        <h2>Agent session not found</h2>
        <p>Cockpit has no agent session for <span class="mono">{route.repo}#{route.number}</span>. It may have been removed.</p>
        <p class="notice-actions">
          {#if conversations.length}<a class="text-link" href="#/agents">Open the latest session</a>{/if}
          <a class="text-link" href="#/pr/{route.repo}/{route.number}">Open PR</a>
        </p>
      </div>
    {:else if selection.status === "none"}
      <div class="notice">
        {#if conversations.length}
          <p>Select a session to read its conversation.</p>
        {:else}
          <h2>No agent sessions yet</h2>
          <p>Agents started on a pull request appear here with their conversation and run history.</p>
        {/if}
      </div>
    {:else}
      {@const conv = conversation}
      {@const selectedNumber = selectedRunId === null ? null : runNumber(conv, selectedRunId)}
      <header class="pane-head" bind:clientHeight={headHeight}>
        <div class="column">
          <div class="head-top">
            <h2 class="conv-title" title={sessionTitle(conv)}>{sessionTitle(conv)}</h2>
            <a class="head-button pr-link" href="#/pr/{conv.repo}/{conv.number}/agents" title="Open pull request {conv.repo}#{conv.number}" aria-label="Open pull request {conv.repo}#{conv.number}">
              <span class="mono">{conv.repo}#{conv.number}</span>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5h6v6M11.25 4.75 4.5 11.5" /></svg>
            </a>
          </div>
          <div class="head-meta">
            <span class="head-facts">
              {#if headStatus}
                <span class="status">
                  <span class="dot {headStatus.tone}" class:live={headStatus.tone === "working"} aria-hidden="true"></span>
                  <span class="status-label">{headStatus.label}</span>
                  {#if headStatus.reason}<span class="status-reason">· {headStatus.reason}</span>{/if}
                </span>
              {/if}
              {#if headRow}<span>{agentLabel(headRow, prefs.agents)}</span>{/if}
              {#if headRow}<span title={when(headRow.started_at)}>{runTiming(headRow)}</span>{/if}
            </span>
            <span class="head-tools">
              {#if selection.status === "ready"}
                <span class="modes" role="tablist" aria-label="Reading mode">
                  {#each READING_MODES as readingMode (readingMode.value)}
                    <button type="button" id="agents-mode-{readingMode.value}" role="tab" aria-selected={mode === readingMode.value} aria-controls="agents-reader" tabindex={mode === readingMode.value ? 0 : -1} onclick={() => setMode(readingMode.value)}>{readingMode.label}</button>
                  {/each}
                </span>
              {/if}
              {#if conv.runs.length > 1}
                <button
                  class="history-trigger"
                  type="button"
                  bind:this={historyTrigger}
                  aria-expanded={historyOpen}
                  aria-controls="agents-run-history"
                  onclick={() => (historyOpen ? closeHistory(false) : openHistory())}
                >
                  <span>{selectedNumber ? `Run ${selectedNumber} of ${conv.runs.length}` : `${conv.runs.length} ${conv.runs.length === 1 ? "run" : "runs"}`}</span>
                  <Chevron size={12} />
                </button>
              {/if}
            </span>
          </div>
          {#if historical}
            {@const latestStatus = workspaceStatus(latestRun)}
            <div class="historical">
              <span>Earlier run from {when(selectedRun.started_at)}. Latest is run {conv.runs.length}, {latestStatus.label.toLowerCase()}.</span>
              <a class="text-link" href={agentsHref(conv.repo, conv.number, latestRun.id)}>Return to latest</a>
            </div>
          {/if}
          {#if refreshError}
            <p class="refresh-alert" role="alert">Couldn’t refresh this run: {refreshError}. Showing the last loaded output.</p>
          {/if}
        </div>
      </header>

      <div class="reader-wrap">
        {#snippet readerContent()}
          <div class="column reader-column" bind:this={content}>
            {#if selection.status === "no-runs"}
              <div class="reader-notice">
                <p class="notice-title">No runs were recorded for this session.</p>
                <p class="muted">Sessions started before run history keep only their latest state.</p>
              </div>
            {:else if selection.status === "choose-run"}
              <div class="reader-notice">
                <p class="notice-title">This session has {conv.runs.length === 1 ? "a run" : `${conv.runs.length} runs`} now.</p>
                <p class="notice-actions"><a class="text-link" href={agentsHref(conv.repo, conv.number, latestRun.id)}>Open the latest run</a></p>
              </div>
            {:else if selection.status === "missing-run"}
              <div class="reader-notice">
                <p class="notice-title">That run isn’t part of this session.</p>
                {#if selection.owner}
                  <p class="muted">It belongs to <span class="mono">{selection.owner.repo}#{selection.owner.number}</span>, {sessionTitle(selection.owner)}.</p>
                {/if}
                <p class="notice-actions">
                  {#if selection.owner}<a class="text-link" href={agentsHref(selection.owner.repo, selection.owner.number, selection.runId)}>Open it in its session</a>{/if}
                  {#if latestRun}<a class="text-link" href={agentsHref(conv.repo, conv.number, latestRun.id)}>Open this session’s latest run</a>{/if}
                </p>
              </div>
            {:else if detailState === "loading"}
              <p class="reader-note" role="status">Loading transcript…</p>
            {:else if detailState === "error"}
              <div class="reader-notice" role="alert">
                <p class="notice-title">Couldn’t load this run: {detailError}</p>
                <p class="notice-actions"><button class="text-button" type="button" onclick={() => openRun(selectedRunId, { force: true })}>Retry</button></p>
              </div>
            {:else if detailState === "missing"}
              <div class="reader-notice">
                <p class="notice-title">This run’s transcript is no longer available.</p>
                {#if latestRun && latestRun.id !== selectedRunId}
                  <p class="notice-actions"><a class="text-link" href={agentsHref(conv.repo, conv.number, latestRun.id)}>Open the latest run</a></p>
                {/if}
              </div>
            {:else if detail}
              {#if mode === "conversation"}
                <section class="brief" aria-label="Task">
                  <span class="brief-label">Task</span>
                  <p class="brief-text" class:expanded={taskExpanded} bind:this={taskText}>{detail.run.brief}</p>
                  {#if taskOverflow || taskExpanded}
                    <button class="text-button task-toggle" type="button" aria-expanded={taskExpanded} onclick={() => (taskExpanded = !taskExpanded)}>{taskExpanded ? "Show less" : "Show full task"}</button>
                  {/if}
                </section>
                {#if !detail.turns.length}
                  <p class="reader-note">
                    {detail.run.state === "running" ? "Waiting for the agent’s first message…" : "No conversation output was recorded for this run."}
                    {#if detail.rawLog}<button class="text-button" type="button" onclick={() => setMode("log")}>Read the log tail</button>{/if}
                  </p>
                {/if}
              {/if}
              {#key detailRunId}
                <AgentTranscript variant="conversation" turns={detail.turns} rawLog={detail.rawLog} showRawLog={mode === "log"} />
              {/key}
            {/if}
          </div>
        {/snippet}
        {#if selection.status === "ready"}
          <div class="reader" id="agents-reader" bind:this={scroller} onscroll={onReaderScroll} tabindex="0" role="tabpanel" aria-labelledby="agents-mode-{mode}">
            {@render readerContent()}
          </div>
        {:else}
          <div class="reader" id="agents-reader" bind:this={scroller} onscroll={onReaderScroll} tabindex="-1" role="region" aria-label="Session">
            {@render readerContent()}
          </div>
        {/if}
        {#if detail && !following && overflowing}
          <button class="jump" type="button" onclick={jumpToLatest}>
            {#if newOutput}<span class="jump-dot" aria-hidden="true"></span><span class="sr-only">New output.</span>{/if}
            <span>Jump to latest</span>
            <Chevron size={12} />
          </button>
        {/if}
      </div>

      {#if historyOpen}
        <div class="history-layer" style:top="{headHeight + 6}px">
          <div class="column history-anchor">
            <nav
              class="history-panel"
              id="agents-run-history"
              aria-label="Run history"
              tabindex="-1"
              bind:this={historyPanel}
            >
              <div class="history-head">
                <span class="history-title">Run history</span>
                <span class="history-count">{conv.runs.length} {conv.runs.length === 1 ? "run" : "runs"}</span>
                {#if historical}<a class="text-link history-latest" href={agentsHref(conv.repo, conv.number, latestRun.id)}>Return to latest</a>{/if}
              </div>
              <ol class="history-list">
                {#each conv.runs as run, index (run.id)}
                  {@const status = workspaceStatus(run)}
                  <li>
                    <a
                      class="history-run"
                      class:selected={run.id === selectedRunId}
                      href={agentsHref(conv.repo, conv.number, run.id)}
                      aria-current={run.id === selectedRunId ? "true" : undefined}
                    >
                      <span class="dot {status.tone}" aria-hidden="true"></span>
                      <span class="history-body">
                        <span class="history-line">
                          <span class="history-name">Run {conv.runs.length - index}</span>
                          <span>{agentLabel(run, prefs.agents)}</span>
                          <span class="history-status">{status.label}{status.reason ? ` · ${status.reason}` : ""}</span>
                          {#if index === 0}<span class="tag">Latest</span>{/if}
                          {#if run.id === selectedRunId}<span class="tag current">Viewing</span>{/if}
                        </span>
                        <span class="history-when">
                          <time datetime={run.started_at}>{when(run.started_at)}</time>
                          {#if run.state === "running"} · running{:else if run.ended_at} · ran {durationText(run.started_at, run.ended_at)}{/if}
                        </span>
                        <span class="history-brief">{run.brief}</span>
                      </span>
                    </a>
                  </li>
                {/each}
              </ol>
            </nav>
          </div>
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .agents-workspace {
    --sessions-bg: color-mix(in srgb, var(--surface) 40%, var(--panel));
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: clamp(248px, 25%, 316px) minmax(0, 1fr);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--panel);
    overflow: hidden;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  /* Session list */
  .sessions {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--sessions-bg);
  }
  .search {
    flex: none;
    padding: 12px 12px 6px;
  }
  .search-field {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 6px 0 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--text-faint);
    cursor: text;
  }
  .search-field:focus-within {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .search-field svg {
    flex: none;
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .search-field input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font-size: 13px;
  }
  .search-field input:focus-visible {
    outline: none;
  }
  .search-field input::placeholder {
    color: var(--text-faint);
  }
  .search-clear {
    flex: none;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-faint);
    font-size: 16px;
    line-height: 1;
  }
  .search-clear:hover {
    background: var(--ghost-hover);
    color: var(--text);
  }
  .list-alert {
    flex: none;
    margin: 4px 12px 6px;
    font-size: 12px;
    line-height: 17px;
    color: var(--fail);
  }
  .session-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 8px 14px;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll) transparent;
  }
  .list-note {
    margin: 10px 8px;
    font-size: 12.5px;
    line-height: 18px;
    color: var(--text-dim);
  }
  .list-note.error {
    color: var(--fail);
  }
  .group-label {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    padding: 10px 8px 5px;
    background: var(--sessions-bg);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    color: var(--text-dim);
  }
  .group-count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    font-weight: 400;
  }
  .group-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0 0 6px;
    padding: 0;
    list-style: none;
  }
  .session {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr);
    column-gap: 10px;
    padding: 8px 10px 9px 9px;
    border-radius: var(--radius-md);
    color: var(--text);
    text-decoration: none;
  }
  .session:hover {
    background: var(--ghost-hover);
  }
  .session.selected {
    background: color-mix(in srgb, var(--text) 7.5%, transparent);
  }
  .session:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--link);
  }
  .session .dot {
    margin-top: 6px;
  }
  .session-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .session-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
    overflow-wrap: anywhere;
  }
  .session-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    line-height: 16px;
    color: var(--text-faint);
  }
  .session-ref {
    flex: none;
    max-width: 62%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-dim);
  }
  .session-agent {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-agent::before {
    content: "· ";
  }
  .session-time {
    flex: none;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .session-snippet {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 12px;
    line-height: 16px;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  /* One quiet state indicator, shared by the list, header, history and run end. */
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--wait);
  }
  .dot.neutral {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--text-faint);
  }
  .dot.working {
    background: var(--link);
  }
  .dot.attention {
    background: var(--fail);
  }
  .dot.completed {
    background: var(--ready);
  }
  .dot.merged {
    background: var(--merged);
  }
  .dot.live {
    animation: agents-live 1.8s var(--ease-standard) infinite;
  }
  @keyframes agents-live {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--link) 45%, transparent);
    }
    70%,
    100% {
      box-shadow: 0 0 0 5px color-mix(in srgb, var(--link) 0%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.live {
      animation: none;
    }
  }

  /* Conversation pane */
  .pane {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .column {
    width: 100%;
    max-width: 840px;
    margin: 0 auto;
    padding: 0 26px;
  }
  .pane-head {
    flex: none;
    padding: 16px 0 12px;
    border-bottom: 1px solid var(--border);
  }
  .head-top {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .conv-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    font-size: 17px;
    font-weight: 600;
    line-height: 24px;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  .head-button,
  .history-trigger {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--text);
    font-size: 12.5px;
    text-decoration: none;
    white-space: nowrap;
  }
  .head-button:hover,
  .history-trigger:hover,
  .history-trigger[aria-expanded="true"] {
    border-color: var(--border-hover);
    background: var(--ghost-hover);
  }
  .history-trigger {
    padding-right: 7px;
    font-variant-numeric: tabular-nums;
  }
  .pr-link {
    max-width: 46%;
    padding-right: 8px;
    color: var(--text-dim);
  }
  .pr-link:hover {
    color: var(--text);
  }
  .pr-link .mono {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .pr-link svg {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .head-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-top: 8px;
  }
  .head-facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 12px;
    min-width: 0;
    font-size: 12.5px;
    line-height: 18px;
    color: var(--text-dim);
  }
  .head-ref {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .status-label {
    color: var(--text);
    font-weight: 500;
  }
  .head-tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .modes {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--surface);
  }
  .modes button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-dim);
    font-size: 12.5px;
    white-space: nowrap;
  }
  .modes button:hover {
    color: var(--text);
  }
  .modes button[aria-selected="true"] {
    background: var(--panel);
    color: var(--text);
    box-shadow: var(--shadow-control-selected);
  }
  .historical {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 16px;
    margin-top: 12px;
    padding: 7px 12px;
    border-radius: var(--radius-md);
    background: var(--surface);
    font-size: 12.5px;
    line-height: 18px;
    color: var(--text-dim);
  }
  .refresh-alert {
    margin: 10px 0 0;
    font-size: 12.5px;
    line-height: 18px;
    color: var(--fail);
  }

  .reader-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .reader {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll) transparent;
  }
  .reader:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--focus-ring);
  }
  .reader-column {
    padding-top: 22px;
    padding-bottom: 56px;
  }
  .reader-note {
    margin: 0 0 18px;
    font-size: 13px;
    line-height: 20px;
    color: var(--text-dim);
  }
  .reader-note .text-button {
    margin-left: 6px;
  }
  .reader-notice {
    margin: 24px 0;
    font-size: 13.5px;
    line-height: 21px;
    color: var(--text);
  }
  .reader-notice p {
    margin: 0 0 6px;
  }
  .reader-notice .notice-title {
    font-weight: 600;
  }
  .muted {
    color: var(--text-dim);
  }
  .brief {
    margin: 0 0 22px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface) 45%, var(--panel));
  }
  .brief-label {
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    color: var(--text-faint);
  }
  .brief-text {
    margin: 0;
    font-size: 13.5px;
    line-height: 21px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .brief-text:not(.expanded) { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
  .task-toggle { margin-top: 8px; }
  .jump {
    position: absolute;
    left: 50%;
    bottom: 16px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    color: var(--text);
    font-size: 12.5px;
    box-shadow: var(--shadow-surface);
    transform: translateX(-50%);
  }
  .jump:hover {
    background: color-mix(in srgb, var(--surface) 60%, var(--panel));
  }
  .jump:not(:disabled):active {
    transform: translateX(-50%) scale(0.98);
  }
  .jump-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--link);
  }

  /* Run history */
  .history-layer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 12px;
    z-index: 6;
    pointer-events: none;
  }
  .history-anchor {
    position: relative;
    height: 100%;
  }
  .history-panel {
    position: absolute;
    top: 0;
    right: 26px;
    width: min(460px, calc(100% - 52px));
    max-height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
    pointer-events: auto;
  }
  .history-panel:focus-visible {
    outline: none;
  }
  .history-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px 8px;
    font-size: 12px;
    line-height: 16px;
  }
  .history-title {
    font-weight: 600;
    color: var(--text);
  }
  .history-count {
    color: var(--text-faint);
  }
  .history-latest {
    margin-left: auto;
  }
  .history-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .history-run {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr);
    column-gap: 10px;
    padding: 8px 10px 9px 9px;
    border-radius: var(--radius-md);
    color: var(--text);
    text-decoration: none;
  }
  .history-run:hover {
    background: var(--ghost-hover);
  }
  .history-run.selected {
    background: color-mix(in srgb, var(--text) 7.5%, transparent);
  }
  .history-run:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--link);
  }
  .history-run .dot {
    margin-top: 6px;
  }
  .history-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .history-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    font-size: 12.5px;
    line-height: 18px;
    color: var(--text-dim);
  }
  .history-name {
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .history-status {
    color: var(--text);
  }
  .tag {
    padding: 0 6px;
    border-radius: 4px;
    background: var(--surface);
    font-size: 11px;
    line-height: 16px;
    color: var(--text-dim);
  }
  .tag.current {
    background: var(--link-bg);
    color: var(--link);
  }
  .history-when {
    font-size: 12px;
    line-height: 16px;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }
  .history-brief {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    margin-top: 2px;
    font-size: 12.5px;
    line-height: 17px;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }

  /* Notices and links */
  .notice {
    max-width: 520px;
    margin: 72px auto 0;
    padding: 0 26px;
    font-size: 13.5px;
    line-height: 21px;
    color: var(--text-dim);
  }
  .notice h2 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    line-height: 22px;
    color: var(--text);
  }
  .notice p {
    margin: 0 0 6px;
  }
  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin-top: 10px !important;
  }
  .text-link {
    color: var(--link);
    font-weight: 500;
    text-decoration: none;
  }
  .text-link:hover {
    text-decoration: underline;
  }
  .text-button {
    padding: 0;
    border: 0;
    background: none;
    color: var(--link);
    font-size: inherit;
    font-weight: 500;
  }
  .text-button:hover {
    text-decoration: underline;
  }

  @media (max-width: 1100px) {
    .column {
      padding: 0 20px;
    }
    .history-panel {
      right: 20px;
      width: min(440px, calc(100% - 40px));
    }
  }

  @media (max-width: 760px) {
    .agents-workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 38%) minmax(0, 1fr);
    }
    .sessions {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
