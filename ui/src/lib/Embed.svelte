<script>
  import { untrack } from "svelte";
  import { fetchPrDetail, fetchPrRows, fetchSettings } from "./api.js";
  import { burstGate } from "./burstGate.js";
  import { connectEvents } from "./events.js";
  import { setPrefs } from "./prefs.svelte.js";
  import { prKeyOf } from "./prKey.js";
  import { classify } from "./whoseMove.js";
  import PrRow from "./PrRow.svelte";

  const MAX_KEYS = 100;
  const KEY_RE = /^([^/\s#]+\/[^/\s#]+)#([1-9]\d*)$/;
  const EVENT_BURST_WINDOW_MS = 250;
  const framed = window.parent !== window;

  // #/embed?keys=owner%2Frepo%2312,... — each key encoded on its own and joined by commas, in display order.
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
  let rows = $state({});
  let viewerLogin = $state(null);
  let content = $state(null);
  let visible = $derived(keys.map((key) => rows[key]).filter(Boolean));

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
    const onHash = () => (keys = parseKeys(location.hash));
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
</script>

<div class="embed">
  <div bind:this={content}>
    {#if visible.length}
      <div class="embed-card">
        {#each visible as pr (prKeyOf(pr.repo, pr.number))}
          <PrRow {pr} status={classify(pr, viewerLogin)} href={cockpitUrl(pr)} onclick={(event) => open(event, pr)} />
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
  .embed-card > :global(.row:last-child) {
    border-bottom: none;
  }
</style>
