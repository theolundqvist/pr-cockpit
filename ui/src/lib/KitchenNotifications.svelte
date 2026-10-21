<script>
  import { tick, untrack } from "svelte";
  import { prKey } from "./prKey.js";
  import { prefs } from "./prefs.svelte.js";

  let { active = true, refreshRevision = 0, pollCompletedAt = null } = $props();
  let items = $state([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state(null);
  let hasMore = $state(false);
  let panel = $state();
  let trigger = $state();
  let open = $state(false);
  let filter = $state("all");
  let sequence = 0;
  let instant = $state(false);
  const storageKey = "cockpit:kitchen-seen";
  function readSeen() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  let seen = $state(readSeen());
  const eventKey = (pr) => `${prKey(pr)}:${pr.terminalAt}`;
  const isUnread = (pr) => seen[eventKey(pr)] === false || (!seen[eventKey(pr)] && Date.parse(pr.terminalAt) > Number(seen.readThrough ?? 0));
  let remaining = $derived(items.filter((pr) => Date.parse(pr.terminalAt) > Number(seen.clearedThrough ?? 0)));
  let unreadCount = $derived(remaining.filter(isUnread).length);
  // Rows carry mergedByMe only while the setting is on; turning it off falls back to All.
  let shownFilter = $derived(filter === "mine" && !prefs.mergedByMeNotificationsEnabled ? "all" : filter);
  let mine = $derived(remaining.filter((pr) => pr.mergedByMe === true));
  let visible = $derived(shownFilter === "unread" ? remaining.filter(isUnread) : shownFilter === "mine" ? mine : remaining);
  let moreUncleared = $derived(hasMore && (!items.length || Date.parse(items.at(-1).terminalAt) > Number(seen.clearedThrough ?? 0)));
  function clearNotifications() {
    // Keep the source history intact and dismiss older, unloaded pages as well.
    const next = { ...readSeen(), clearedThrough: Math.max(Date.now(), ...items.map((pr) => Date.parse(pr.terminalAt)).filter(Number.isFinite)) };
    localStorage.setItem(storageKey, JSON.stringify(next));
    seen = next;
    panel?.querySelector(".notification-filter")?.focus();
  }

  function setRead(pr, read) {
    const next = { ...readSeen() };
    if (read) next[eventKey(pr)] = true;
    else next[eventKey(pr)] = false;
    localStorage.setItem(storageKey, JSON.stringify(next));
    seen = next;
    if (shownFilter === "unread" && read) tick().then(() => panel?.querySelector(".notification-link, .notification-filter")?.focus());
  }
  function markAllRead() {
    const next = { ...readSeen() };
    // A watermark also acknowledges older pages that have not been loaded yet.
    for (const key of Object.keys(next)) if (typeof next[key] === "boolean") next[key] = true;
    next.readThrough = Date.now();
    for (const pr of items) next[eventKey(pr)] = true;
    localStorage.setItem(storageKey, JSON.stringify(next));
    seen = next;
  }
  async function load(more = false) {
    const request = ++sequence;
    loading = true;
    error = null;
    try {
      const limit = more ? 100 : Math.max(100, Math.min(200, items.length));
      const response = await fetch(`/api/kitchen-history?limit=${limit}&offset=${more ? items.length : 0}`);
      if (!response.ok) throw new Error(response.status === 404
        ? "Notifications need the updated Cockpit server. Update Cockpit and retry."
        : "Couldn't load notifications. Try again.");
      const result = await response.json();
      if (request !== sequence) return;
      const retained = !more && items.length > limit;
      const rows = more ? [...items, ...result.prs] : retained ? [...result.prs, ...items] : result.prs;
      items = [...new Map(rows.map((pr) => [prKey(pr), pr])).values()].sort((a, b) => b.terminalAt.localeCompare(a.terminalAt));
      if (!retained) hasMore = result.hasMore;
      loaded = true;
    } catch (cause) {
      if (request === sequence) error = cause.message;
    } finally {
      if (request === sequence) loading = false;
    }
  }
  function positionPanel() {
    if (!panel || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    panel.style.top = `${bounds.bottom + 8}px`;
    panel.style.right = `${Math.max(16, Math.min(window.innerWidth - bounds.right, window.innerWidth - Math.min(396, window.innerWidth - 32) - 16))}px`;
    panel.style.setProperty("--available-height", `${Math.max(160, window.innerHeight - bounds.bottom - 32)}px`);
  }
  function prepareToggle(event) {
    instant = event.detail === 0;
    positionPanel();
  }
  function close(keyboard = false) {
    instant = keyboard;
    panel?.hidePopover();
    trigger?.focus();
  }
  $effect(() => {
    if (!active) { panel?.hidePopover(); return; }
    refreshRevision;
    pollCompletedAt;
    prefs.mergedByMeNotificationsEnabled;
    untrack(() => load());
    return () => { sequence++; };
  });
  $effect(() => {
    const onStorage = (event) => { if (event.key === storageKey || event.key === null) seen = readSeen(); };
    const onHash = () => panel?.hidePopover();
    const onKey = (event) => {
      if (!open) return;
      // The panel owns keyboard input; queue shortcuts must not act underneath it.
      event.stopImmediatePropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (event.key === "Tab") {
        const controls = [...panel.querySelectorAll("button:not(:disabled), a")];
        const index = controls.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    const reposition = () => { if (open) positionPanel(); };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("storage", onStorage);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  const time = (value) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

<button class="notification-trigger" bind:this={trigger} aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"} aria-expanded={open} aria-controls="kitchen-notifications" popovertarget="kitchen-notifications" popovertargetaction="toggle" onclick={prepareToggle} title="Notifications">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
  {#if unreadCount}<span class="notification-count" aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</span>{/if}
</button>
<div id="kitchen-notifications" class="notifications" data-instant={instant} popover="auto" bind:this={panel} role="dialog" aria-label="Notifications"
  onbeforetoggle={(event) => { open = event.newState === "open"; if (open) positionPanel(); }}
  ontoggle={(event) => { if (event.newState === "open" && instant) tick().then(() => panel?.querySelector(".notification-filter")?.focus()); }}>
  <div class="notification-head"><strong>Notifications</strong><button class="close-notifications" aria-label="Close notifications" onclick={(event) => close(event.detail === 0)}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></div>
  <div class="notification-toolbar">
    <div class="notification-filters">
      <button class="notification-filter" class:chosen={shownFilter === "all"} aria-pressed={shownFilter === "all"} onclick={() => filter = "all"}>All <span class="filter-count">{remaining.length > 99 ? "99+" : remaining.length}</span></button>
      <button class="notification-filter" class:chosen={shownFilter === "unread"} aria-pressed={shownFilter === "unread"} onclick={() => filter = "unread"}>Unread <span class="filter-count">{unreadCount > 99 ? "99+" : unreadCount}</span></button>
      {#if prefs.mergedByMeNotificationsEnabled}
        <button class="notification-filter" class:chosen={shownFilter === "mine"} aria-pressed={shownFilter === "mine"} onclick={() => filter = "mine"}>Merged by me <span class="filter-count">{mine.length > 99 ? "99+" : mine.length}</span></button>
      {/if}
    </div>
    <button class="mark-all" disabled={!unreadCount} onclick={markAllRead}>Mark all read</button>
  </div>
  <div class="notification-list">
    {#if error}<div class="notification-empty" role="alert">{error}<button class="retry" onclick={() => load()}>Retry</button></div>
    {:else if !loaded}<div class="notification-empty" role="status">Loading notifications…</div>
    {:else if !visible.length}<div class="notification-empty">{shownFilter === "unread" ? "You're all caught up." : shownFilter === "mine" ? "No PRs merged by you." : "No notifications."}</div>{/if}
    {#each visible as pr (prKey(pr))}
      <div class="notification-item" class:unread={isUnread(pr)}>
        <a class="notification-link" href={`#/pr/${pr.repo}/${pr.number}`} onclick={() => { setRead(pr, true); panel.hidePopover(); }}>
          <span class="notification-title" title={pr.title}>{pr.title}</span>
          {#if pr.author}<span class="notification-author">Author @{pr.author}</span>{/if}
          <span class="notification-meta"><span><span class="merged">Merged</span> · {pr.repo.split("/").at(-1)} #{pr.number}</span><time datetime={pr.terminalAt}>{time(pr.terminalAt)}</time></span>
        </a>
        <button class="read-toggle" aria-label={`${isUnread(pr) ? "Mark as read" : "Mark as unread"}: ${pr.title}`} title={isUnread(pr) ? "Mark as read" : "Mark as unread"} onclick={() => setRead(pr, isUnread(pr))}><span class:filled={isUnread(pr)}></span></button>
      </div>
    {/each}
    {#if moreUncleared}<button class="load-more" disabled={loading} onclick={() => load(true)}>{loading ? "Loading…" : "Load older notifications"}</button>{/if}
  </div>
  {#if remaining.length}
    <div class="notification-footer"><button class="clear-notifications" onclick={clearNotifications}>Clear notifications</button></div>
  {/if}
</div>

<style>
  button { font: inherit; cursor: pointer; color: inherit; background: transparent; border: 0; touch-action: manipulation; }
  button:disabled { opacity: .4; cursor: default; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--native-focus); outline-offset: -2px; }
  .notification-trigger { position: relative; display: inline-grid; place-items: center; width: 34px; height: 34px; padding: 0; border-radius: 50%; color: var(--text-dim); flex: none; }
  .notification-trigger[aria-expanded="true"] { background: var(--surface-hover); color: var(--text); }
  .notification-count, .filter-count { display: inline-grid; place-items: center; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 999px; font-size: 10px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; flex: none; }
  .notification-count { position: absolute; top: -4px; right: -6px; background: var(--native-accent); color: var(--native-on-accent); border: 2px solid var(--bg); min-width: 22px; height: 22px; pointer-events: none; }
  .notifications { position: fixed; inset: 98px 24px auto auto; margin: 0; width: min(396px, calc(100vw - 32px)); max-height: var(--available-height, calc(100dvh - 130px)); box-sizing: border-box; padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); color: var(--text); box-shadow: var(--shadow-dialog); font-family: var(--sans); font-size: 13px; overflow: hidden; transform-origin: top right; opacity: 0; transform: translateY(-3px) scale(.98); pointer-events: none;
    transition: opacity 100ms cubic-bezier(.23, 1, .32, 1), transform 100ms cubic-bezier(.23, 1, .32, 1), display 100ms allow-discrete, overlay 100ms allow-discrete;
  }
  .notifications:popover-open { opacity: 1; transform: none; pointer-events: auto; transition-duration: 160ms; }
  @starting-style { .notifications:popover-open { opacity: 0; transform: translateY(-3px) scale(.98); } }
  .notifications[data-instant="true"] { transition: none; }
  .notification-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 8px 16px; }
  .notification-head strong { font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
  .close-notifications { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--text-dim); }
  .notification-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 0 12px 10px; border-bottom: 1px solid var(--border-soft); }
  .notification-filters { display: flex; gap: 4px; }
  .notification-filter { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 8px; border-radius: 8px; color: var(--text-dim); font-size: 12px; }
  .notification-filter.chosen { background: var(--surface); color: var(--text); }
  .filter-count { background: var(--surface-hover); color: var(--text-dim); }
  .chosen .filter-count { background: var(--panel); color: var(--text); }
  .mark-all { font-size: 11px; color: var(--text-dim); padding: 6px 4px; border-radius: 6px; white-space: nowrap; }
  .notification-list { max-height: min(480px, calc(var(--available-height, 600px) - 132px)); overflow: auto; overscroll-behavior: contain; padding: 4px; }
  .notification-item { display: flex; align-items: center; border-radius: 9px; margin: 2px 0; }
  .notification-item.unread { background: color-mix(in srgb, var(--native-accent) 4%, var(--panel)); }
  .notification-link { flex: 1; min-width: 0; padding: 12px 0 12px 12px; color: inherit; text-decoration: none; display: flex; flex-direction: column; gap: 6px; border-radius: 8px; }
  .notification-title { line-height: 1.45; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .unread .notification-title { font-weight: 600; }
  .notification-author { color: var(--text-dim); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .notification-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--text-faint); font-size: 10px; line-height: 1.5; }
  .merged { color: var(--text-dim); }
  .read-toggle { display: grid; place-items: center; width: 30px; height: 30px; flex: none; padding: 0; margin: 0 8px; border-radius: 50%; }
  .read-toggle span { box-sizing: border-box; display: block; width: 8px; height: 8px; border: 1px solid var(--text-faint); border-radius: 50%; }
  .read-toggle .filled { background: var(--native-accent); border-color: var(--native-accent); }
  .notification-footer { padding: 6px 12px; border-top: 1px solid var(--border-soft); display: flex; justify-content: flex-end; }
  .clear-notifications { padding: 6px 4px; border-radius: 6px; color: var(--text-dim); font-size: 11px; }
  .notification-empty { padding: 28px 16px; color: var(--text-dim); line-height: 1.5; text-align: center; }
  .retry { margin: 12px auto 0; display: block; text-decoration: underline; }
  .load-more { display: block; padding: 12px; width: 100%; color: var(--text-dim); font-size: 12px; border-radius: 8px; }
  @media (hover: hover) and (pointer: fine) {
    .notification-trigger:hover, .close-notifications:hover, .read-toggle:hover, .notification-filter:hover, .mark-all:not(:disabled):hover, .load-more:hover, .clear-notifications:hover { background: var(--surface-hover); color: var(--text); }
    .notification-item:hover { background: var(--surface); }
    button:not(:disabled):active { transform: scale(.97); }
  }
  @media (prefers-reduced-motion: reduce) { .notifications, .notifications:popover-open { transition: none; transform: none; } }
</style>
