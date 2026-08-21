<script>
  import Inbox from "./lib/Inbox.svelte";
  import PrDetail from "./lib/PrDetail.svelte";
  import Palette from "./lib/Palette.svelte";
  import Settings from "./lib/Settings.svelte";
  import Onboarding from "./lib/Onboarding.svelte";
  import FindBar from "./lib/FindBar.svelte";
  import HistoryNav from "./lib/HistoryNav.svelte";
  import FlashBar from "./lib/FlashBar.svelte";
  import Cheatsheet from "./lib/Cheatsheet.svelte";
  import Lightbox from "./lib/Lightbox.svelte";
  import QuotaBanner from "./lib/QuotaBanner.svelte";
  import { fetchSettings } from "./lib/api.js";
  import { showFlash } from "./lib/flash.svelte.js";
  import { prefs } from "./lib/prefs.svelte.js";
  import { quota } from "./lib/quota.svelte.js";
  import { quotaImpact } from "./lib/quotaImpact.js";

  window.cockpitFlash = showFlash;

  const isShell = navigator.userAgent.includes("Electron");

  function parseRoute(hash) {
    const match = hash.match(/^#\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/(files|agents)|\/history\/([^/?]+)(?:\?symbol=([^&]+))?)?$/);
    if (match) {
      let historyPath = null;
      let historySymbol = null;
      try {
        historyPath = match[5] ? decodeURIComponent(match[5]) : null;
        historySymbol = match[6] ? decodeURIComponent(match[6]) : null;
      } catch {
        return { name: "inbox" };
      }
      return {
        name: "detail",
        repo: `${match[1]}/${match[2]}`,
        number: Number(match[3]),
        tab: historyPath ? "files" : match[4] ?? "conversation",
        historyPath,
        historySymbol,
      };
    }
    if (hash === "#/settings") return { name: "settings" };
    if (hash.startsWith("#/palette")) return { name: "palette" };
    return { name: "inbox" };
  }

  let route = $state(parseRoute(location.hash));
  let reposConfigured = $state(null);
  let setupOpen = $state(false);
  let bannerHeight = $state(0);
  let impact = $derived(quotaImpact(quota.resources));
  let quotaTone = $derived(
    impact.level === "out" ? "critical" : impact.level === "reserved" ? "warning" : "normal",
  );

  $effect(() => {
    const onHash = () => (route = parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  $effect(() => {
    fetchSettings()
      .then((s) => (reposConfigured = s.repos.trim().length > 0))
      .catch(() => (reposConfigured = true));
  });

  // GitHub PR links in rendered markdown navigate in-app; modifier clicks keep the real href
  const GH_PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[#?])/;

  $effect(() => {
    function onClick(e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest("a");
      if (!a || !a.closest(".md")) return;
      const m = (a.getAttribute("href") ?? "").match(GH_PR_URL);
      if (!m) return;
      e.preventDefault();
      location.hash = `#/pr/${m[1]}/${m[2]}/${m[3]}`;
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  });

  function openPalette() {
    window.dispatchEvent(new Event("cockpit:open-palette"));
  }
  function finishSetup() {
    reposConfigured = true;
    setupOpen = false;
    location.hash = "#/";
  }

</script>

{#if route.name === "palette"}
  <Palette standalone />
{:else}
  <div
    class="app-shell"
    class:shell={isShell}
    class:sidebar-hidden={prefs.hideSidebar}
    class:settingsRoute={route.name === "settings"}
    style="--app-banner-height: {bannerHeight}px"
  >
    <div class="app-banner" bind:clientHeight={bannerHeight}>
      <QuotaBanner />
    </div>
    <div class="app-drag-region" aria-hidden="true"></div>
    <aside class="app-sidebar">
      <nav class="app-nav" aria-label="Cockpit navigation">
        <span class="nav-label">Workspace</span>
        <a
          class="nav-item"
          class:active={route.name === "inbox" || route.name === "detail"}
          href="#/"
          aria-current={route.name === "inbox" || route.name === "detail" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 5.5h15v13h-15z" />
            <path d="M4.5 11.5h4l1.5 2h4l1.5-2h4" />
          </svg>
          <span>Inbox</span>
        </a>
        <button class="nav-item nav-command" type="button" onclick={openPalette}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="5.5" />
            <path d="m15 15 4 4" />
          </svg>
          <span>Find a PR</span>
          <kbd aria-label="Command K"><span>⌘</span><span>K</span></kbd>
        </button>

        <span class="nav-label nav-label-lower">Control</span>
        <a
          class="nav-item"
          class:active={route.name === "settings"}
          href="#/settings"
          aria-current={route.name === "settings" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path transform="translate(-1.43 -0.5)" d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2 2-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.2h-2.8v-.1A1.7 1.7 0 0 0 11 18.54a1.7 1.7 0 0 0-1.88.34l-.06.06-2-2 .06-.06A1.7 1.7 0 0 0 7.46 15a1.7 1.7 0 0 0-1.56-1.04h-.1v-2.8h.1A1.7 1.7 0 0 0 7.46 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2-2 .06.06A1.7 1.7 0 0 0 11 6.46a1.7 1.7 0 0 0 1.04-1.56v-.1h2.8v.1A1.7 1.7 0 0 0 15.88 6.46a1.7 1.7 0 0 0 1.88-.34l.06-.06 2 2-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.04h.1v2.8h-.1A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
          <span>Settings</span>
        </a>
      </nav>

      {#if quota.resources}
        {@const graphql = quota.resources.graphql}
        <a
          class="quota-status {quotaTone}"
          href="#/settings"
          title={`GitHub GraphQL: ${graphql.remaining.toLocaleString()} of ${graphql.limit.toLocaleString()} remaining. Resets ${new Date(graphql.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
          aria-label={`GitHub GraphQL quota: ${graphql.remaining} of ${graphql.limit} remaining`}
        >
          <span class="quota-dot" aria-hidden="true"></span>
          <span class="quota-copy">
            <strong>GraphQL</strong>
            <small>{graphql.remaining.toLocaleString()} / {graphql.limit.toLocaleString()}</small>
          </span>
        </a>
      {/if}

    </aside>

    <main class="app-main">
      <div class="app-history">
        <HistoryNav />
      </div>

      {#if setupOpen}
        <Onboarding onDone={finishSetup} onCancel={() => (setupOpen = false)} />
      {:else if route.name === "detail"}
        <PrDetail repo={route.repo} number={route.number} tab={route.tab} historyPath={route.historyPath} historySymbol={route.historySymbol} />
      {:else if route.name === "settings"}
        <Settings onRunSetup={() => (setupOpen = true)} />
      {:else if reposConfigured === false}
        <Onboarding onDone={finishSetup} />
      {:else if reposConfigured}
        <Inbox />
      {:else}
        <div class="app-loading" role="status" aria-live="polite">
          <span class="app-loading-mark" aria-hidden="true"></span>
          <span>Loading your review workspace…</span>
        </div>
      {/if}
    </main>

    {#if route.name === "detail" || route.name === "settings"}
      <FindBar />
    {/if}

    <Palette />
    <FlashBar />
    <Cheatsheet />
    <Lightbox />
  </div>
{/if}

<style>
  .app-shell {
    --app-rail-width: 228px;
    --app-content-max-width: 1320px;
    --app-content-gutter: 32px;
    /* views size themselves to --general-height, so the banner takes its height out of it */
    --general-height: calc(var(--viewport-height) - var(--app-banner-height, 0px));
    display: grid;
    grid-template-columns: var(--app-rail-width) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background: var(--bg);
  }

  .app-banner {
    grid-column: 1 / -1;
  }

  /* the banner takes over the top strip in the desktop shell: it stays draggable and
     leaves room for the macOS traffic lights */
  .app-shell.shell .app-banner {
    padding-left: 62px;
    -webkit-app-region: drag;
  }

  .app-drag-region {
    position: fixed;
    top: 0;
    right: 0;
    left: 0;
    height: 42px;
    -webkit-app-region: drag;
    z-index: 4;
  }

  .app-shell.sidebar-hidden {
    --app-rail-width: 0px;
    grid-template-columns: minmax(0, 1fr);
  }

  .app-shell.settingsRoute {
    --app-content-max-width: 920px;
  }

  .app-shell.sidebar-hidden .app-sidebar {
    display: none;
  }

  .app-sidebar {
    position: relative;
    z-index: 5;
    display: flex;
    min-width: 0;
    flex-direction: column;
    min-height: 0;
    padding: 54px 12px 18px;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 78%, var(--panel));
    backdrop-filter: blur(20px) saturate(160%);
  }

  .app-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-label {
    padding: 0 10px 7px;
    color: var(--text-faint);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.055em;
  }

  .nav-label-lower {
    margin-top: 20px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 34px;
    gap: 10px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1;
    text-align: left;
    text-decoration: none;
  }

  .nav-item svg {
    flex: none;
    width: 16px;
    height: 16px;
    color: var(--text-faint);
  }

  .nav-item kbd {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 9.5px;
  }

  .nav-item.active {
    border-color: var(--border);
    background: var(--panel);
    color: var(--text);
    box-shadow: var(--shadow-xs);
  }

  .nav-item.active svg {
    color: var(--link);
  }

  @media (hover: hover) and (pointer: fine) {
    .nav-item:hover {
      background: var(--panel);
    }

    .nav-item:hover {
      color: var(--text);
    }

    .nav-item:hover svg {
      color: var(--text-dim);
    }
  }

  .quota-status {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: auto;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    text-decoration: none;
  }

  .quota-status:hover {
    background: var(--panel);
    color: var(--text-dim);
  }

  .quota-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ready);
  }

  .quota-status.warning .quota-dot {
    background: var(--review);
  }

  .quota-status.critical .quota-dot {
    background: var(--fail);
    box-shadow: 0 0 0 3px var(--fail-bg);
  }

  .quota-copy {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .quota-copy strong {
    color: var(--text-dim);
    font-size: 10.5px;
    font-weight: 600;
  }

  .quota-copy small {
    font-family: var(--mono);
    font-size: 9.5px;
  }

  .app-main {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding-top: 42px;
  }

  .app-history {
    position: absolute;
    top: 7px;
    left: 50%;
    z-index: 6;
    display: flex;
    width: min(
      var(--app-content-max-width),
      calc(100% - var(--app-content-gutter) - var(--app-content-gutter))
    );
    padding-inline: 2px;
    transform: translateX(-50%);
  }

  /* clears the macOS traffic lights */
  .app-shell.shell.sidebar-hidden .app-history {
    left: 84px;
    width: auto;
    transform: none;
  }

  .app-loading {
    display: inline-flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    gap: 9px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .app-loading-mark {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--link);
    box-shadow: 0 0 0 4px var(--link-bg);
  }

  @media (max-width: 980px) {
    .app-shell {
      --app-rail-width: 64px;
    }

    .app-sidebar {
      align-items: center;
      padding-inline: 8px;
    }

    .nav-item {
      justify-content: center;
      width: 40px;
      padding-inline: 0;
    }

    .nav-item > span,
    .nav-item kbd,
    .nav-label {
      display: none;
    }

    .nav-label-lower {
      margin-top: 14px;
    }

    .quota-status {
      justify-content: center;
      width: 40px;
      padding-inline: 0;
    }

    .quota-copy {
      display: none;
    }

  }

  @media (prefers-reduced-transparency: reduce) {
    .app-sidebar {
      background: var(--surface);
      backdrop-filter: none;
    }
  }

  @media (max-width: 720px) {
    .app-shell {
      --app-content-gutter: 14px;
    }
  }
</style>
