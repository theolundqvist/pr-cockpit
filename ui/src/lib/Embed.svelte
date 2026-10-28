<script>
  import { untrack } from "svelte";
  import { fetchPrDetail, fetchPrRows, fetchSettings } from "./api.js";
  import { burstGate } from "./burstGate.js";
  import { connectEvents } from "./events.js";
  import { cookingStage, isBurnt } from "./cookingStage.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { prKeyOf } from "./prKey.js";
  import { classify } from "./whoseMove.js";
  import Kbd from "./Kbd.svelte";
  import PrRow from "./PrRow.svelte";

  const MAX_KEYS = 100;
  const KEY_RE = /^([^/\s#]+\/[^/\s#]+)#([1-9]\d*)$/;
  const OVERLAY_RE = /[?&]overlay=1(?:&|$)/;
  const EVENT_BURST_WINDOW_MS = 250;
  const framed = window.parent !== window;

  // #/embed?keys=owner%2Frepo%2312,... — each key encoded on its own and joined by commas, in display order.
  // The frame posts {source: "pr-cockpit-embed"} messages to its parent: `size` with its content height and
  // `open` with a PR's prcockpit:// URL. Adding `&overlay=1` opts into compact rows that show Kitchen state
  // and, inside a frame, an E control per row (its button, or E on the focused row) posting `hide` with the
  // row's key exactly as requested. Hiding belongs to the host: Cockpit changes nothing on GitHub and keeps
  // showing the row until the host drops its key from the hash, so restoring the key undoes the hide.
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

  function open(event, pr) {
    event.preventDefault();
    if (framed) window.parent.postMessage({ source: "pr-cockpit-embed", type: "open", url: cockpitUrl(pr) }, "*");
    else location.href = cockpitUrl(pr);
  }

  // Once the host drops a hidden row, focus that left with it moves to a neighbouring row so repeated E keeps
  // working; focus elsewhere, including in the host page, is never taken.
  let refocus = null;

  function hide(event, key) {
    const index = visible.findIndex((entry) => entry.key === key);
    const fromKeyboard = event.type === "keydown" || event.detail === 0;
    refocus = fromKeyboard && event.currentTarget.parentElement.contains(document.activeElement)
      ? { hidden: key, next: (visible[index + 1] ?? visible[index - 1])?.key ?? null }
      : null;
    window.parent.postMessage({ source: "pr-cockpit-embed", type: "hide", key }, "*");
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
</script>

<div class="embed">
  <div bind:this={content}>
    {#if visible.length}
      <div class="embed-card">
        {#each visible as { key, pr } (key)}
          {#if overlay}
            <div class="overlay-row" class:hideable={framed}>
              <PrRow
                {pr}
                compact
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
          {:else}
            <PrRow {pr} status={classify(pr, viewerLogin)} href={cockpitUrl(pr)} onclick={(event) => open(event, pr)} />
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

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
