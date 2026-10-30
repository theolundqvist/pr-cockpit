<script module>
  // A queued quick action keeps the next menu's quick actions disabled until it settles.
  let quickActionBusy = $state(false);
</script>

<script>
  import { onMount, tick } from "svelte";
  import { enqueueMutation, fetchMutations, fetchPrDetail, fetchPrDetailSnapshot, repoQuickActions } from "./api.js";
  import { labelsAfterMutations } from "./appliedLabels.js";
  import { showFlash } from "./flash.svelte.js";
  import Kbd from "./Kbd.svelte";
  import { presentMutationError } from "./mutationError.js";
  import { prefs } from "./prefs.svelte.js";
  import { QUICK_ACTIONS } from "./prRowActions.js";
  import { committedQuickActionsCache, quickActionMutation, resolveQuickActions } from "./quickActions.js";

  // `anchor` is the row the menu opened on; `pointer` is where. A `growable` host (the embed frame) grows its
  // viewport to fit the menu, so the menu keeps to the pointer instead of the viewport's bottom edge, reports
  // the bottom edge it needs through `onextent`, and survives the resulting resize.
  let { pr, actions, anchor, pointer, takenKeys = new Set(), showKeys = false, growable = false, onClose, onextent = () => {} } = $props();

  let node = $state();
  let x = $state(0);
  let y = $state(0);
  let closed = false;
  let menuQuickActions = $state([]);
  let menuQuickActionsLoading = $state(false);
  let menuQuickActionsError = $state("");
  let quickSubmenu = $state(null);
  let quickSubmenuNode = $state();
  let quickSubmenuTrigger = $state();
  let quickSubmenuCloseTimer;
  let offersQuickActions = $derived(actions.some((action) => action.id === QUICK_ACTIONS));

  function close() {
    if (closed) return;
    closed = true;
    onClose();
  }

  const zoom = () => Number.parseFloat(getComputedStyle(node.closest("#app")).zoom) || 1;

  function reportExtent() {
    if (!growable || closed || !node) return;
    const bottom = Math.max(node.getBoundingClientRect().bottom, quickSubmenuNode?.getBoundingClientRect().bottom ?? 0);
    onextent(Math.ceil(bottom + 8));
  }

  async function position(pointerX = null, pointerY = null) {
    await tick();
    if (closed || !node) return;
    const rect = node.getBoundingClientRect();
    const scale = zoom();
    const left = Math.max(8, Math.min(pointerX ?? rect.left, window.innerWidth - rect.width - 8));
    const top = growable ? Math.max(8, pointerY ?? rect.top) : Math.max(8, Math.min(pointerY ?? rect.top, window.innerHeight - rect.height - 8));
    x += (left - rect.left) / scale;
    y += (top - rect.top) / scale;
    await tick();
    reportExtent();
  }

  onMount(() => {
    // Right-clicking a scrolled row can deliver an already-queued scroll event after the menu opens.
    // Dismiss only when an ancestor actually moves from the menu's opening position.
    const scrollPositions = new Map();
    for (let element = anchor; element; element = element.parentElement) {
      scrollPositions.set(element, [element.scrollLeft, element.scrollTop]);
    }
    const outside = (event) => { if (!node?.contains(event.target)) close(); };
    const scroll = (event) => {
      if (node?.contains(event.target)) return;
      const element = event.target === document ? document.scrollingElement : event.target;
      const start = scrollPositions.get(element);
      if (!start || element.scrollLeft !== start[0] || element.scrollTop !== start[1]) close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scroll, true);
    if (!growable) window.addEventListener("resize", close);
    menuQuickActionsLoading = offersQuickActions && pr.state === "OPEN";
    position(pointer.x, pointer.y).then(() => {
      if (closed) return;
      node.querySelector("button")?.focus({ preventScroll: true });
      if (menuQuickActionsLoading) void loadContextActions();
    });
    return () => {
      closed = true;
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", close);
      cancelQuickSubmenuClose();
    };
  });

  async function loadContextActions(attempt = 0) {
    const current = () => !closed;
    try {
      let committed = committedQuickActionsCache.get(pr.repo) ?? null;
      let config;
      try {
        config = await repoQuickActions(pr.repo);
      } catch {
        if (!current()) return;
        menuQuickActionsError = "Couldn't load repository quick actions.";
      }
      if (!current()) return;
      if (config?.status === "fetching" && attempt < 10) {
        setTimeout(() => { if (current()) void loadContextActions(attempt + 1); }, 1500);
        return;
      }
      if (config?.status === "ok") {
        committed = config.content;
        committedQuickActionsCache.set(pr.repo, committed);
      } else if (config?.status === "not-found") {
        committed = null;
        committedQuickActionsCache.delete(pr.repo);
      } else {
        menuQuickActionsError = "Couldn't load repository quick actions.";
      }
      const resolved = resolveQuickActions({
        committed,
        personal: prefs.personalQuickActions,
        repo: pr.repo,
        takenKeys,
      });
      if (resolved.errors.length) menuQuickActionsError = "Quick actions configuration needs correcting.";
      if (resolved.actions.length) {
        const snapshot = await fetchPrDetailSnapshot(pr.repo, pr.number, { prefetch: true });
        if (!current()) return;
        const detail = snapshot?.detail ?? await fetchPrDetail(pr.repo, pr.number, { view: false });
        if (!current()) return;
        if (detail.state !== "OPEN") {
          menuQuickActionsLoading = false;
          return;
        }
        const mutations = await fetchMutations(pr.repo, pr.number);
        if (!current()) return;
        const labels = labelsAfterMutations(detail.labels.nodes.map((label) => label.name), mutations);
        menuQuickActions = resolved.actions.map((action) => ({ ...action, done: action.kind === "label" && labels.has(action.value) }));
      }
      menuQuickActionsLoading = false;
    } catch {
      if (current()) {
        menuQuickActionsError = "Couldn't load quick actions.";
        menuQuickActionsLoading = false;
      }
    } finally {
      if (current() && !menuQuickActionsLoading) {
        await position();
        if (current() && quickSubmenuTrigger?.matches(":hover")) void openQuickSubmenu();
      }
    }
  }

  async function openQuickSubmenu(focus = false) {
    if (closed || !menuQuickActions.length || quickActionBusy) return;
    cancelQuickSubmenuClose();
    const scale = zoom();
    const maxWidth = Math.min(320, (window.innerWidth - 16) / scale);
    const maxHeight = (window.innerHeight - 16) / scale;
    quickSubmenu = { x: 0, y: 0, maxWidth, maxHeight: growable ? null : maxHeight };
    await tick();
    if (!quickSubmenuNode || !quickSubmenuTrigger || closed) return;
    const rect = quickSubmenuNode.getBoundingClientRect();
    const parent = node.getBoundingClientRect();
    const trigger = quickSubmenuTrigger.getBoundingClientRect();
    const right = parent.right - 4;
    const left = Math.max(8, right + rect.width <= window.innerWidth - 8 ? right : parent.left - rect.width + 4);
    const top = growable ? Math.max(8, trigger.top - 4) : Math.max(8, Math.min(trigger.top - 4, window.innerHeight - rect.height - 8));
    quickSubmenu = { ...quickSubmenu, x: (left - rect.left) / scale, y: (top - rect.top) / scale };
    await tick();
    reportExtent();
    if (focus) (quickSubmenuNode.querySelector("button:not(:disabled)") ?? quickSubmenuNode).focus();
  }

  function cancelQuickSubmenuClose() {
    clearTimeout(quickSubmenuCloseTimer);
  }

  function closeQuickSubmenu(focusTarget = quickSubmenuTrigger) {
    cancelQuickSubmenuClose();
    if (quickSubmenuNode?.contains(document.activeElement)) focusTarget?.focus();
    quickSubmenu = null;
  }

  function scheduleQuickSubmenuClose(focusTarget = quickSubmenuTrigger) {
    cancelQuickSubmenuClose();
    quickSubmenuCloseTimer = setTimeout(() => {
      if (!closed) closeQuickSubmenu(focusTarget);
    }, 200);
  }

  async function runQuickAction(action) {
    if (quickActionBusy || action.done) return;
    quickActionBusy = true;
    close();
    try {
      await enqueueMutation(pr.repo, pr.number, quickActionMutation(action.kind, action.value));
      showFlash(`Queued ${action.label} for #${pr.number}.`);
    } catch (error) {
      showFlash(presentMutationError(action.kind === "label" ? `add label ${action.value}` : `post ${action.label}`, error).message);
    } finally {
      quickActionBusy = false;
    }
  }

  function run(action) {
    close();
    action.run();
  }

  function onKey(event) {
    const menu = event.target.closest('[role="menu"]');
    if ((event.key === "Escape" || event.key === "ArrowLeft") && menu === quickSubmenuNode) {
      closeQuickSubmenu();
      event.preventDefault();
    } else if (event.key === "Escape" || event.key === "Tab") {
      close();
      if (event.key === "Escape") event.preventDefault();
    } else if (event.key === "ArrowRight" && event.target === quickSubmenuTrigger) {
      void openQuickSubmenu(true);
      event.preventDefault();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      if (menu === node) closeQuickSubmenu();
      const buttons = [...menu.querySelectorAll(":scope > button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
      event.preventDefault();
    }
    event.stopPropagation();
  }
</script>

<div
  class="pr-context-menu"
  bind:this={node}
  role="menu"
  tabindex="-1"
  aria-label={`Actions for #${pr.number}`}
  style="left:{x}px;top:{y}px"
  oncontextmenu={(event) => event.preventDefault()}
  onkeydown={onKey}
  onfocus={() => closeQuickSubmenu()}
  onmouseleave={() => scheduleQuickSubmenuClose()}
  onmouseover={(event) => { const button = event.target.closest("button"); if (button && button.closest('[role="menu"]') === node) { if (button === quickSubmenuTrigger) cancelQuickSubmenuClose(); else scheduleQuickSubmenuClose(button); } }}
>
  {#each actions as action (action.id)}
    {#if action.id !== QUICK_ACTIONS}
      <button role="menuitem" class:keyed={showKeys} disabled={action.disabled} onclick={() => run(action)}>
        <span>{action.label}</span>
        {#if showKeys && action.key}<Kbd keys={action.key} />{/if}
      </button>
    {:else if menuQuickActionsLoading || menuQuickActionsError || menuQuickActions.length}
      <button
        role="menuitem"
        class="quick-submenu-trigger"
        bind:this={quickSubmenuTrigger}
        aria-haspopup="menu"
        aria-expanded={!!quickSubmenu}
        disabled={menuQuickActionsLoading || (!!menuQuickActionsError && !menuQuickActions.length) || quickActionBusy}
        title={menuQuickActionsError}
        onmouseenter={() => openQuickSubmenu()}
        onmousemove={() => { if (!quickSubmenu) void openQuickSubmenu(); }}
        onclick={() => openQuickSubmenu(true)}
      >
        <span>{menuQuickActionsLoading ? "Loading quick actions…" : menuQuickActionsError && !menuQuickActions.length ? "Quick actions unavailable" : "Quick actions"}</span>
        <span aria-hidden="true">›</span>
      </button>
    {/if}
  {/each}
  {#if quickSubmenu}
    <div
      class="pr-context-menu pr-quick-actions-menu"
      bind:this={quickSubmenuNode}
      role="menu"
      tabindex="-1"
      aria-label="Quick actions"
      style="left:{quickSubmenu.x}px;top:{quickSubmenu.y}px;max-width:{quickSubmenu.maxWidth}px;{quickSubmenu.maxHeight == null ? '' : `max-height:${quickSubmenu.maxHeight}px`}"
      onmouseenter={cancelQuickSubmenuClose}
    >
      {#each menuQuickActions as action (action.id)}
        <button
          role="menuitem"
          disabled={quickActionBusy || action.done}
          title={action.kind === "label" ? `Add label “${action.value}”` : `Comment “${action.value}”`}
          onclick={() => runQuickAction(action)}
        >{action.label}{action.done ? " ✓" : ""}</button>
      {/each}
      {#if menuQuickActionsError}<div class="quick-actions-error" role="status">{menuQuickActionsError}</div>{/if}
    </div>
  {/if}
</div>

<style>
  .pr-context-menu {
    position: fixed;
    z-index: 100;
    min-width: 174px;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel-raised);
    box-shadow: var(--shadow-sm);
  }
  .pr-context-menu button {
    display: block;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    font: 12px var(--sans);
    text-align: left;
    cursor: pointer;
  }
  .pr-context-menu button:hover:not(:disabled), .pr-context-menu button:focus-visible:not(:disabled) {
    outline: none;
    background: var(--surface-hover);
  }
  .pr-context-menu button:disabled {
    color: var(--text-dim);
    cursor: default;
    opacity: 0.55;
  }
  .pr-context-menu .quick-submenu-trigger,
  .pr-context-menu button.keyed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .pr-quick-actions-menu {
    overflow-y: auto;
    overflow-wrap: anywhere;
  }
  .quick-actions-error {
    padding: 7px 9px;
    color: var(--text-dim);
    font: 12px var(--sans);
  }
</style>
