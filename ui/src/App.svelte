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
  import Kbd from "./lib/Kbd.svelte";
  import { fetchSettings } from "./lib/api.js";
  import { showFlash } from "./lib/flash.svelte.js";
  import { prefs } from "./lib/prefs.svelte.js";
  import { quota } from "./lib/quota.svelte.js";
  import { quotaImpact } from "./lib/quotaImpact.js";
  import { SETTINGS_SECTION_KEY, SETTINGS_SECTIONS, normalizeSettingsSection, settingsSectionHref } from "./lib/settingsSections.js";

  window.cockpitFlash = showFlash;

  const isShell = navigator.userAgent.includes("Electron");

  function parseRoute(hash) {
    const match = hash.match(/^#\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/(files|agents|actions)|\/history\/([^/?]+)(?:\?symbol=([^&]+))?)?$/);
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
    const settingsMatch = hash.match(/^#\/settings(?:\/([^/]+))?$/);
    if (settingsMatch) {
      const requestedSection = settingsMatch[1] ?? localStorage.getItem(SETTINGS_SECTION_KEY);
      return { name: "settings", section: normalizeSettingsSection(requestedSection) };
    }
    if (hash.startsWith("#/palette")) return { name: "palette" };
    return { name: "inbox" };
  }

  let route = $state(parseRoute(location.hash));
  let reposConfigured = $state(null);
  let setupOpen = $state(false);
  let inboxRevision = $state(0);
  let detailRevision = $state(0);
  let pollCompletedAt = $state(null);
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

  $effect(() => {
    let socket = null;
    let reconnectTimer = null;
    let stopped = false;
    function refreshRoute() {
      if (route.name === "inbox") inboxRevision++;
      else if (route.name === "detail") detailRevision++;
    }

    function connect() {
      if (socket || stopped) return;

      const url = new URL("/api/events", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.addEventListener("open", refreshRoute);
      socket.addEventListener("message", (message) => {
        let invalidation;
        try {
          invalidation = JSON.parse(message.data);
        } catch {
          return;
        }
        if (invalidation.type === "poll-complete") {
          pollCompletedAt = invalidation.lastPollAt;
        } else if (invalidation.type === "inbox" && route.name === "inbox") {
          inboxRevision++;
        } else if (
          invalidation.type === "pr" &&
          route.name === "detail" &&
          invalidation.repo === route.repo &&
          invalidation.number === route.number
        ) {
          detailRevision++;
        }
      });
      socket.addEventListener("close", () => {
        socket = null;
        if (!stopped) reconnectTimer = setTimeout(connect, 1000);
      });
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
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
    class:sidebar-hidden={prefs.hideSidebar && route.name !== "settings"}
    style="--app-banner-height: {bannerHeight}px"
  >
    <div class="app-banner" bind:clientHeight={bannerHeight}>
      <QuotaBanner />
    </div>
    <div class="app-drag-region" aria-hidden="true"></div>
    <aside class="app-sidebar">
      <nav class="app-nav" aria-label={route.name === "settings" ? "Settings navigation" : "Cockpit navigation"}>
        {#if route.name === "settings"}
          <a class="nav-item settings-back" href="#/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m14.5 6-6 6 6 6" />
            </svg>
            <span>Back to inbox</span>
            <span class="nav-kbd"><Kbd keys="esc" /></span>
          </a>
          <span class="nav-label settings-nav-label">Settings</span>
          {#each SETTINGS_SECTIONS as section}
            <a
              class="nav-item"
              class:active={route.section === section.id}
              href={settingsSectionHref(section.id)}
              aria-current={route.section === section.id ? "page" : undefined}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                {#each section.iconPaths as path}
                  <path d={path} />
                {/each}
              </svg>
              <span>{section.label}</span>
            </a>
          {/each}
        {:else}
        <span class="nav-label">Workspace</span>
        <a
          class="nav-item"
          class:active={route.name === "inbox" || route.name === "detail"}
          href="#/"
          aria-current={route.name === "inbox" || route.name === "detail" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4.5 5.5h15v13h-15z" />
            <path d="M4.5 11.5h4l1.5 2h4l1.5-2h4" />
          </svg>
          <span>Inbox</span>
        </a>
        <button class="nav-item nav-command" type="button" onclick={openPalette}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="5.5" />
            <path d="m15 15 4 4" />
          </svg>
          <span>Find a PR</span>
          <span class="nav-kbd"><Kbd keys={["cmd", "k"]} /></span>
        </button>

        <span class="nav-label nav-label-lower">Control</span>
        <a
          class="nav-item"
          class:active={route.name === "settings"}
          href="#/settings"
          aria-current={route.name === "settings" ? "page" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path transform="translate(-1.43 -0.5)" d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2 2-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.2h-2.8v-.1A1.7 1.7 0 0 0 11 18.54a1.7 1.7 0 0 0-1.88.34l-.06.06-2-2 .06-.06A1.7 1.7 0 0 0 7.46 15a1.7 1.7 0 0 0-1.56-1.04h-.1v-2.8h.1A1.7 1.7 0 0 0 7.46 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2-2 .06.06A1.7 1.7 0 0 0 11 6.46a1.7 1.7 0 0 0 1.04-1.56v-.1h2.8v.1A1.7 1.7 0 0 0 15.88 6.46a1.7 1.7 0 0 0 1.88-.34l.06-.06 2 2-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.04h.1v2.8h-.1A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
          <span>Settings</span>
          <span class="nav-kbd"><Kbd keys={["cmd", ","]} /></span>
        </a>
        {/if}
      </nav>

      {#if quota.resources}
        {@const graphql = quota.resources.graphql}
        {@const quotaPercent = Math.max(0, Math.min(100, (graphql.remaining / Math.max(1, graphql.limit)) * 100))}
        <div
          class="quota-status {quotaTone}"
          title={`GitHub GraphQL: ${graphql.remaining.toLocaleString()} of ${graphql.limit.toLocaleString()} remaining. Resets ${new Date(graphql.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
          aria-label={`GitHub GraphQL quota: ${graphql.remaining} of ${graphql.limit} remaining`}
          role="status"
        >
          <span class="quota-dot" aria-hidden="true"></span>
          <span class="quota-copy">
            <strong>{quotaTone === "critical" ? "API exhausted" : quotaTone === "warning" ? "API limited" : "API healthy"}</strong>
            <small>{Math.round(quotaPercent)}% available</small>
            <span class="quota-meter" aria-hidden="true">
              <span class="quota-meter-fill" style={`width: ${quotaPercent}%`}></span>
            </span>
          </span>
        </div>
      {/if}

    </aside>

    <main class="app-main">
      <div class="app-history">
        <HistoryNav backFallback={route.name === "detail" ? "#/" : null} />
      </div>

      {#if setupOpen}
        <Onboarding onDone={finishSetup} onCancel={() => (setupOpen = false)} />
      {:else if route.name === "detail"}
        <PrDetail repo={route.repo} number={route.number} tab={route.tab} historyPath={route.historyPath} historySymbol={route.historySymbol} refreshRevision={detailRevision} />
      {:else if route.name === "settings"}
        <Settings section={route.section} onRunSetup={() => (setupOpen = true)} />
      {:else if reposConfigured === false}
        <Onboarding onDone={finishSetup} />
      {:else if reposConfigured}
        <Inbox refreshRevision={inboxRevision} {pollCompletedAt} onFindPr={openPalette} />
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
    --app-rail-width: 216px;
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

  /* the desktop banner covers the titlebar while its content clears the traffic lights */
  .app-shell.shell .app-banner {
    --quota-shell-inset: 62px;
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
    padding: 54px 10px 18px;
    border-right: 1px solid var(--border-soft);
    background: color-mix(in srgb, var(--surface) 42%, var(--bg));
    backdrop-filter: blur(20px) saturate(135%);
  }

  .app-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-label {
    padding: 0 10px 6px;
    color: var(--text-faint);
    font-size: 12px;
    font-weight: 400;
    line-height: 16px;
    letter-spacing: 0;
  }

  .nav-label-lower {
    margin-top: 20px;
  }

  .settings-back {
    margin-bottom: 22px;
    color: var(--text-dim);
  }

  .settings-nav-label {
    padding-top: 0;
  }

  .nav-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 34px;
    gap: 9px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 400;
    line-height: 1;
    text-align: left;
    text-decoration: none;
  }

  .nav-item svg {
    flex: none;
    width: 18px;
    height: 18px;
    color: var(--text-faint);
  }

  .nav-kbd {
    display: inline-flex;
    margin-left: auto;
  }

  .nav-item.active {
    background: var(--surface-hover);
    color: var(--text);
    font-weight: 500;
    box-shadow: none;
  }

  .nav-item.active svg {
    color: var(--text);
  }

  @media (hover: hover) and (pointer: fine) {
    .nav-item:hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
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
    align-items: flex-start;
    gap: 9px;
    margin-top: auto;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    cursor: default;
  }

  .quota-dot {
    flex: none;
    width: 7px;
    height: 7px;
    margin-top: 4px;
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
    flex: 1;
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

  .quota-meter {
    display: block;
    width: 100%;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-hover);
  }

  .quota-meter-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--ready);
  }

  .quota-status.warning .quota-meter-fill {
    background: var(--review);
  }

  .quota-status.critical .quota-meter-fill {
    background: var(--fail);
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
    .nav-kbd,
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
