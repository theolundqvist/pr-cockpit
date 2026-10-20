<script>
  import { tick, untrack } from "svelte";
  import { prKey } from "./prKey.js";

  let { active = true, refreshRevision = 0, pollCompletedAt = null } = $props();
  let items = $state([]);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state(null);
  let hasMore = $state(false);
  let panel = $state();
  let trigger = $state();
  let open = $state(false);
  let unreadOnly = $state(false);
  let sequence = 0;
  let panelTop = $state(98);
  let panelRight = $state(24);
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
  let unreadCount = $derived(items.filter(isUnread).length);
  let visible = $derived(unreadOnly ? items.filter(isUnread) : items);

  function setRead(pr, read) {
    const next = { ...readSeen() };
    if (read) next[eventKey(pr)] = true;
    else next[eventKey(pr)] = false;
    localStorage.setItem(storageKey, JSON.stringify(next));
    seen = next;
    if (unreadOnly && read) tick().then(() => panel?.querySelector(".notification-link, .notification-filter")?.focus());
  }
  function markAllRead() {
    const next = { ...readSeen() };
    // A watermark also acknowledges older pages that have not been loaded yet.
    for (const key of Object.keys(next)) if (key !== "readThrough") next[key] = true;
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
  async function toggle() {
    if (open) return close();
    const bounds = trigger.getBoundingClientRect();
    panelTop = bounds.bottom + 8;
    panelRight = Math.max(16, window.innerWidth - bounds.right);
    panel.showPopover();
    await tick();
    panel.querySelector(".notification-filter")?.focus();
  }
  function close() {
    panel?.hidePopover();
    trigger?.focus();
  }
  $effect(() => {
    if (!active) { panel?.hidePopover(); return; }
    refreshRevision;
    pollCompletedAt;
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
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const controls = [...panel.querySelectorAll("button:not(:disabled), a")];
        const index = controls.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  const time = (value) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

<button class="notification-trigger" bind:this={trigger} aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"} aria-expanded={open} aria-controls="kitchen-notifications" onclick={toggle} title="Notifications">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
  {#if unreadCount}<span class="notification-count">{unreadCount}</span>{/if}
</button>
<div id="kitchen-notifications" class="notifications" style:top={`${panelTop}px`} style:right={`${panelRight}px`} popover="auto" bind:this={panel} role="dialog" aria-label="Notifications" ontoggle={(event) => { open = event.newState === "open"; }}>
  <div class="notification-head"><strong>Notifications</strong><button aria-label="Close notifications" onclick={close}>×</button></div>
  <div class="notification-toolbar">
    <div class="notification-filters">
      <button class="notification-filter" class:chosen={!unreadOnly} aria-pressed={!unreadOnly} onclick={() => unreadOnly = false}>All</button>
      <button class="notification-filter" class:chosen={unreadOnly} aria-pressed={unreadOnly} onclick={() => unreadOnly = true}>Unread {#if unreadCount}<span>{unreadCount}</span>{/if}</button>
    </div>
    <button class="mark-all" disabled={!unreadCount} onclick={markAllRead}>Mark all read</button>
  </div>
  <div class="notification-list">
    {#if error}<div class="notification-empty" role="alert">{error}<button class="retry" onclick={() => load()}>Retry</button></div>
    {:else if !loaded}<div class="notification-empty" role="status">Loading notifications…</div>
    {:else if !visible.length}<div class="notification-empty">{unreadOnly ? "You're all caught up." : "No Kitchen completions yet."}</div>{/if}
    {#each visible as pr (prKey(pr))}
      <div class="notification-item" class:unread={isUnread(pr)}>
        <a class="notification-link" href={`#/pr/${pr.repo}/${pr.number}`} onclick={() => { setRead(pr, true); panel.hidePopover(); }}>
          <span class="notification-title">{pr.title}</span>
          <span class="notification-meta"><span class="merged">Merged</span> · {pr.repo.split("/").at(-1)} #{pr.number}</span>
          <time datetime={pr.terminalAt}>{time(pr.terminalAt)}</time>
        </a>
        <button class="read-toggle" aria-label={`${isUnread(pr) ? "Mark as read" : "Mark as unread"}: ${pr.title}`} title={isUnread(pr) ? "Mark as read" : "Mark as unread"} onclick={() => setRead(pr, isUnread(pr))}><span class:filled={isUnread(pr)}></span></button>
      </div>
    {/each}
    {#if hasMore}<button class="load-more" disabled={loading} onclick={() => load(true)}>{loading ? "Loading…" : "Load older notifications"}</button>{/if}
  </div>
</div>

<style>
  button { font: inherit; cursor: pointer; color: inherit; background: transparent; border: 0; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--native-accent); outline-offset: -2px; }
  .notification-trigger { display: inline-flex; align-items: center; gap: 6px; padding: 7px; border-radius: 8px; color: var(--text-dim); }
  .notification-trigger:hover { background: var(--surface); color: var(--text); }
  .notification-count { border-radius: 10px; padding: 1px 5px; background: var(--native-accent); color: var(--native-on-accent); font-size: 10px; }
  .notifications { position: fixed; inset: 98px 24px auto auto; margin: 0; width: min(410px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--border-hover); border-radius: 12px; background: var(--panel); color: var(--text); box-shadow: 0 12px 40px #0004; font-family: var(--sans); font-size: 13px; }
  .notification-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
  .notification-head button { font-size: 22px; color: var(--text-dim); }
  .notification-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 0 12px 12px; border-bottom: 1px solid var(--border); }
  .notification-filters { display: flex; gap: 4px; }
  .notification-filter { padding: 5px 9px; border-radius: 6px; color: var(--text-dim); }
  .notification-filter.chosen { background: var(--surface); color: var(--text); }
  .mark-all { font-size: 11px; color: var(--text-dim); }
  .notification-list { max-height: min(540px, calc(100dvh - 220px)); overflow: auto; }
  .notification-item { display: flex; align-items: flex-start; border-bottom: 1px solid var(--border); }
  .notification-item.unread { background: color-mix(in srgb, var(--native-accent) 5%, transparent); }
  .notification-link { flex: 1; min-width: 0; padding: 14px 0 14px 16px; color: inherit; text-decoration: none; display: flex; flex-direction: column; gap: 5px; }
  .notification-title { line-height: 1.45; overflow-wrap: anywhere; }
  .unread .notification-title { font-weight: 600; }
  .notification-meta, time { color: var(--text-faint); font-size: 11px; }
  .merged { color: var(--text-dim); }
  .read-toggle { padding: 18px 16px; }
  .read-toggle span { display: block; width: 8px; height: 8px; border: 1px solid var(--text-faint); border-radius: 50%; }
  .read-toggle .filled { background: var(--native-accent); border-color: var(--native-accent); }
  .notification-empty { padding: 24px 16px; color: var(--text-dim); line-height: 1.5; }
  .retry { display: block; margin-top: 12px; text-decoration: underline; }
  .load-more { display: block; padding: 14px; width: 100%; color: var(--text-dim); }
</style>
