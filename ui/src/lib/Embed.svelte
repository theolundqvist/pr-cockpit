<script>
  import { untrack } from "svelte";
  import { clearReviewHandoff, enqueueMutation, fetchInbox, fetchPrDetail, fetchPrRows, fetchSettings, reorderPr, setArchived, setMergeApproval } from "./api.js";
  import { burstGate } from "./burstGate.js";
  import { connectEvents } from "./events.js";
  import { cookingStage, isBurnt } from "./cookingStage.js";
  import { inboxGroups, prStack } from "./inboxGroups.js";
  import { assignments, onAssignmentStorage, syncAssignments } from "./prAssignments.svelte.js";
  import { flash, showFlash } from "./flash.svelte.js";
  import { presentMutationError } from "./mutationError.js";
  import { prefs, setPrefs } from "./prefs.svelte.js";
  import { prKey, prKeyOf } from "./prKey.js";
  import { isApprovedForSafeMerge, prRowActionForKey, prRowActions } from "./prRowActions.js";
  import { classify } from "./whoseMove.js";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import FlashBar from "./FlashBar.svelte";
  import Kbd from "./Kbd.svelte";
  import PrRow from "./PrRow.svelte";
  import PrRowMenu from "./PrRowMenu.svelte";

  const MAX_KEYS = 100;
  const KEY_RE = /^([^/\s#]+\/[^/\s#]+)#([1-9]\d*)$/;
  const OVERLAY_RE = /[?&]overlay=1(?:&|$)/;
  const EVENT_BURST_WINDOW_MS = 250;
  const framed = window.parent !== window;
  // The page that frames this one; host messages from anywhere else are ignored.
  const hostOrigin = framed ? (location.ancestorOrigins?.[0] ?? (document.referrer ? new URL(document.referrer).origin : null)) : null;
  // Room a confirmation dialog or flash needs inside a frame that is otherwise only as tall as its rows.
  const DIALOG_HEIGHT = 220;
  const FLASH_HEIGHT = 96;

  // #/embed?keys=owner%2Frepo%2312,... — each key encoded on its own and joined by commas, in display order.
  // The frame posts {source: "pr-cockpit-embed"} messages to its parent: `size` with its content height and
  // `open` with a PR's prcockpit:// or GitHub URL. Adding `&overlay=1` opts into compact rows in the inbox's
  // sections, ordered by the user's grouping settings, that show Kitchen state and, inside a frame, an E control
  // per row (its button, or E on the focused row) posting `hide` with the
  // row's key exactly as requested. Hiding belongs to the host: Cockpit changes nothing on GitHub and keeps
  // showing the row until the host drops its key from the hash, so restoring the key undoes the hide.
  // Framed overlay rows also offer the inbox's row context menu and row keys. The frame posts `hover` with the
  // key under the pointer (null once it leaves), so a host whose page holds keyboard focus can forward keys
  // for that row as {source: "pr-cockpit-host", type: "key", key, shiftKey}; E there still means hide.
  // Set aside and reminders are left out: they live in Cockpit's own window storage, which a frame cannot reach.
  function parseKeys(hash) {
    const raw = /[?&]keys=([^&]*)/.exec(hash)?.[1] ?? "";
    const keys = [];
    for (const part of raw.split(",")) {
      let key;
      try {
        key = decodeURIComponent(part);
      } catch {
        continue;
      }
      if (KEY_RE.test(key) && !keys.includes(key)) keys.push(key);
      if (keys.length === MAX_KEYS) break;
    }
    return keys;
  }

  let keys = $state(parseKeys(location.hash));
  let overlay = $state(OVERLAY_RE.test(location.hash));
  let rows = $state({});
  let viewerLogin = $state(null);
  let content = $state(null);
  let visible = $derived(keys.filter((key) => rows[key]).map((key) => ({ key, pr: rows[key] })));
  // Overlay rows sit in the inbox's sections, in its order, under the user's grouping settings.
  let groups = $derived(overlay ? sections(visible) : []);
  let ordered = $derived(overlay ? groups.flatMap((group) => group.entries) : visible);

  function sections(entries) {
    const prs = entries.map((entry) => entry.pr);
    const keyOf = new Map(entries.map(({ key, pr }) => [pr, key]));
    return inboxGroups(prs, {
      stack: prStack(prs),
      grouping: prefs.prGrouping,
      assignments: assignments.values,
      viewerLogin,
      cooking: prefs.cookingSectionEnabled,
      readyReview: true,
      safeMergeApproval: prefs.safeMergeApprovalEnabled,
      listOrder: "queue",
    }).map(({ id, title, items }) => ({
      id,
      title,
      entries: items.filter((item) => item.pr).map(({ pr, stacked }) => ({ key: keyOf.get(pr), pr, stacked })),
    }));
  }

  $effect(() => {
    if (!overlay || prefs.prGrouping.mode !== "manual") return;
    syncAssignments();
    window.addEventListener("storage", onAssignmentStorage);
    return () => window.removeEventListener("storage", onAssignmentStorage);
  });

  // A key the server holds nothing for gets one ordinary detail read, which stores the PR; later
  // refreshes only read what is stored, so a PR that cannot load costs GitHub one request.
  const requested = new Set();
  let loadSeq = 0;

  async function loadRows(wanted) {
    if (!wanted.length) return [];
    const body = await fetchPrRows(wanted);
    viewerLogin = body.viewerLogin;
    const next = { ...rows };
    for (const key of wanted) {
      if (body.rows[key]) next[key] = body.rows[key];
      else delete next[key];
    }
    rows = next;
    return wanted.filter((key) => !body.rows[key]);
  }

  async function loadAll() {
    const seq = ++loadSeq;
    const wanted = keys;
    const missing = (await loadRows(wanted)).filter((key) => !requested.has(key));
    for (const key of missing) {
      if (seq !== loadSeq) return;
      requested.add(key);
      const [, repo, number] = KEY_RE.exec(key);
      try {
        await fetchPrDetail(repo, Number(number));
      } catch {
        continue;
      }
      await loadRows([key]);
    }
  }

  function report(error) {
    console.error("embed refresh failed:", error);
  }

  let refreshAll = false;
  const refreshKeys = new Set();
  const refresh = burstGate(() => {
    if (refreshAll) loadAll().catch(report);
    else if (refreshKeys.size) loadRows([...refreshKeys]).catch(report);
    refreshAll = false;
    refreshKeys.clear();
  }, EVENT_BURST_WINDOW_MS);

  function refreshEverything() {
    refreshAll = true;
    refresh.trigger();
  }

  $effect(() => {
    const onHash = () => {
      keys = parseKeys(location.hash);
      overlay = OVERLAY_RE.test(location.hash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  $effect(() => {
    keys;
    untrack(() => loadAll().catch(report));
  });

  $effect(() => {
    const disconnect = connectEvents(refreshEverything, (invalidation) => {
      if (invalidation.type === "inbox" || invalidation.type === "poll-complete") {
        refreshEverything();
      } else if (invalidation.type === "pr") {
        const key = prKeyOf(invalidation.repo, invalidation.number);
        if (!keys.includes(key)) return;
        refreshKeys.add(key);
        refresh.trigger();
      } else if (invalidation.type === "settings") {
        fetchSettings().then(setPrefs).catch(() => {});
      }
    });
    return () => {
      refresh.cancel();
      disconnect();
    };
  });

  $effect(() => {
    if (!framed || !content) return;
    const node = content;
    const observer = new ResizeObserver(() => {
      window.parent.postMessage({ source: "pr-cockpit-embed", type: "size", height: Math.ceil(node.getBoundingClientRect().height) }, "*");
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  const cockpitUrl = (pr) => `prcockpit://pr/${pr.repo}/${pr.number}`;
  const githubUrl = (pr) => `https://github.com/${pr.repo}/pull/${pr.number}`;

  function post(message) {
    window.parent.postMessage({ source: "pr-cockpit-embed", ...message }, "*");
  }

  function open(event, pr) {
    event.preventDefault();
    if (framed) post({ type: "open", url: cockpitUrl(pr) });
    else location.href = cockpitUrl(pr);
  }

  // Once the host drops a hidden row, focus that left with it moves to a neighbouring row so repeated E keeps
  // working; focus elsewhere, including in the host page, is never taken.
  let refocus = null;

  function hide(event, key) {
    const index = ordered.findIndex((entry) => entry.key === key);
    const fromKeyboard = event.type === "keydown" || event.detail === 0;
    refocus = fromKeyboard && event.currentTarget.parentElement.contains(document.activeElement)
      ? { hidden: key, next: (ordered[index + 1] ?? ordered[index - 1])?.key ?? null }
      : null;
    post({ type: "hide", key });
  }

  function hideOnKey(event, key) {
    if (event.target !== event.currentTarget || event.key.toLowerCase() !== "e") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.repeat) return;
    event.preventDefault();
    hide(event, key);
  }

  $effect(() => {
    const shown = visible.map((entry) => entry.key);
    if (!refocus || shown.includes(refocus.hidden)) return;
    const { next } = refocus;
    refocus = null;
    if (!next || !shown.includes(next) || !document.hasFocus() || document.activeElement !== document.body) return;
    content?.querySelector(`[data-embed-key="${CSS.escape(next)}"]`)?.focus();
  });

  let hovered = $state(null);
  let menu = $state(null);
  let menuRequest = 0;
  let menuExtent = $state(0);
  let confirmAction = $state(null);
  let floorHeight = $derived(Math.max(menu ? menuExtent : 0, confirmAction ? DIALOG_HEIGHT : 0, flash.message ? FLASH_HEIGHT : 0));
  let rowActionsEnabled = $derived(framed && overlay);

  function hover(key) {
    if (hovered === key) return;
    hovered = key;
    post({ type: "hover", key });
  }

  $effect(() => {
    if (hovered && !visible.some((entry) => entry.key === hovered)) hover(null);
  });

  function refreshRow(pr) {
    const key = keys.find((wanted) => wanted.toLowerCase() === prKey(pr).toLowerCase());
    if (key) loadRows([key]).catch(report);
  }

  async function failSoft(action, run) {
    try {
      await run();
    } catch (error) {
      showFlash(`Couldn't ${action}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Archive state and the next pin slot belong to the inbox, which this view does not load; read them per action.
  async function isArchivedInInbox(pr) {
    const { prs } = await fetchInbox(true);
    return prs.some((item) => prKey(item) === prKey(pr));
  }

  async function nextPinRank() {
    const { prs } = await fetchInbox();
    return Math.max(-1, ...prs.map((item) => item.rank).filter((rank) => rank != null)) + 1;
  }

  function embedRowActions(pr, key, archived) {
    const approved = isApprovedForSafeMerge(pr, prefs.safeMergeApprovalEnabled);
    const actions = prRowActions(pr, {
      archived,
      approvalEnabled: prefs.safeMergeApprovalEnabled,
      // E hides the row from this overlay, so Archive keeps only its menu entry here.
      keys: { archive: null },
      open: (target) => post({ type: "open", url: cockpitUrl(target) }),
      github: (target) => post({ type: "open", url: githubUrl(target) }),
      pin: (target) => failSoft("update the pin", async () => {
        await reorderPr(target.repo, target.number, target.rank != null ? null : await nextPinRank());
        refreshRow(target);
      }),
      clearReady: (target) => failSoft("clear marked ready", async () => {
        await clearReviewHandoff(target.repo, target.number);
        refreshRow(target);
      }),
      approve: (target) => failSoft("update safe-merge approval", async () => {
        await setMergeApproval(target.repo, target.number, !approved);
        refreshRow(target);
      }),
      archive: (target) => failSoft(archived ? "unarchive" : "archive", async () => {
        await setArchived(target.repo, target.number, !archived);
        showFlash(`${archived ? "Unarchived" : "Archived"} #${target.number}.`);
      }),
      quickActions: true,
      close: (target) => {
        confirmAction = {
          title: `Close #${target.number}?`,
          confirmLabel: "Close pull request",
          run: async () => {
            try {
              await enqueueMutation(target.repo, target.number, { kind: "close" });
              showFlash(`Queued closing #${target.number}.`);
            } catch (error) {
              showFlash(presentMutationError("close pull request", error).message);
            }
          },
        };
      },
    });
    actions.push({ id: "hide", label: "Hide from this overlay", key: "e", disabled: false, run: () => post({ type: "hide", key }) });
    return actions;
  }

  async function openMenu(event, key, pr) {
    event.preventDefault();
    const request = ++menuRequest;
    const anchor = event.currentTarget;
    const pointer = { x: event.clientX, y: event.clientY };
    let archived = false;
    try {
      archived = await isArchivedInInbox(pr);
    } catch (error) {
      report(error);
    }
    if (request !== menuRequest || !rows[key]) return;
    menuExtent = 0;
    menu = { request, key, pr, anchor, pointer, actions: embedRowActions(pr, key, archived) };
  }

  function closeMenu() {
    menu = null;
  }

  async function runRowKey(key, shiftKey) {
    const target = hovered;
    const pr = target && rows[target];
    if (!pr || menu || confirmAction) return false;
    const archived = await isArchivedInInbox(pr).catch(() => false);
    const action = prRowActionForKey(embedRowActions(pr, target, archived), key, shiftKey);
    action?.run();
    return Boolean(action);
  }

  $effect(() => {
    if (!rowActionsEnabled) return;
    // Keys typed while the host page holds focus arrive here; keys typed inside this frame are read directly.
    const fromHost = (event) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      const message = event.data;
      if (message?.source !== "pr-cockpit-host" || message.type !== "key" || typeof message.key !== "string") return;
      runRowKey(message.key, message.shiftKey === true).catch(report);
    };
    const typed = (event) => {
      if (event.defaultPrevented || !hovered || menu || confirmAction) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.repeat) return;
      if (event.key !== "Enter" && event.key.length !== 1) return;
      event.preventDefault();
      runRowKey(event.key, event.shiftKey).catch(report);
    };
    window.addEventListener("message", fromHost);
    window.addEventListener("keydown", typed);
    return () => {
      window.removeEventListener("message", fromHost);
      window.removeEventListener("keydown", typed);
    };
  });

  function runConfirmAction() {
    const action = confirmAction;
    confirmAction = null;
    action.run();
  }
</script>

<div class="embed">
  <div bind:this={content} style:min-height={floorHeight ? `${floorHeight}px` : null}>
    {#if overlay}
      {#each groups as group (group.id)}
        <section class="embed-card" aria-label={group.title}>
          <div class="group-label"><span>{group.title}</span><span class="group-count">{group.entries.length}</span></div>
          {#each group.entries as { key, pr, stacked } (key)}
            <div
              class="overlay-row"
              class:hideable={framed}
              role="presentation"
              onpointerenter={rowActionsEnabled ? () => hover(key) : undefined}
              onpointerleave={rowActionsEnabled ? () => { if (hovered === key) hover(null); } : undefined}
              oncontextmenu={rowActionsEnabled ? (event) => openMenu(event, key, pr) : undefined}
            >
              <PrRow
                {pr}
                compact
                {stacked}
                cooking={cookingStage(pr)}
                burnt={isBurnt(pr)}
                status={classify(pr, viewerLogin)}
                href={cockpitUrl(pr)}
                onclick={(event) => open(event, pr)}
                onkeydown={framed ? (event) => hideOnKey(event, key) : undefined}
                data-embed-key={key}
              />
              {#if framed}
                <button
                  type="button"
                  class="row-hide"
                  aria-label={`Hide ${key} from this overlay`}
                  title="Hide from this overlay (E)"
                  onclick={(event) => hide(event, key)}
                  onkeydown={(event) => hideOnKey(event, key)}
                >
                  <Kbd keys="e" />
                </button>
              {/if}
            </div>
          {/each}
        </section>
      {/each}
    {:else if visible.length}
      <div class="embed-card">
        {#each visible as { key, pr } (key)}
          <PrRow {pr} status={classify(pr, viewerLogin)} href={cockpitUrl(pr)} onclick={(event) => open(event, pr)} />
        {/each}
      </div>
    {/if}
  </div>
</div>
{#if menu}
  {#key menu.request}
    <PrRowMenu
      pr={menu.pr}
      actions={menu.actions}
      anchor={menu.anchor}
      pointer={menu.pointer}
      takenKeys={new Set(prefs.agents.filter((a) => a.trigger === "keybind" && a.enabled && a.keybind).map((a) => a.keybind))}
      showKeys
      growable
      onextent={(bottom) => (menuExtent = bottom)}
      onClose={closeMenu}
    />
  {/key}
{/if}
{#if confirmAction}
  <ConfirmDialog
    title={confirmAction.title}
    confirmLabel={confirmAction.confirmLabel}
    danger
    onConfirm={runConfirmAction}
    onCancel={() => (confirmAction = null)}
  />
{/if}
{#if rowActionsEnabled}
  <FlashBar />
{/if}

<style>
  .embed {
    max-height: 100vh;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--scroll) transparent;
  }
  .embed-card {
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .embed-card + .embed-card {
    margin-top: 8px;
  }
  .group-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 28px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
  }
  .group-count {
    color: var(--text-faint);
  }
  .embed-card > :global(.row:last-child),
  .embed-card > .overlay-row:last-child > :global(.row) {
    border-bottom: none;
  }
  .overlay-row {
    position: relative;
  }
  .embed-card .overlay-row.hideable > :global(.row .row-title) {
    padding-right: 28px;
  }
  .row-hide {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    height: 24px;
    padding: 2px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
  }
  .row-hide:hover :global(.keycap) {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
