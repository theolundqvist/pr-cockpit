<script>
  import { quota } from "./quota.svelte.js";
  import { quotaImpact, quotaLimitedLabel, quotaOutLabel } from "./quotaImpact.js";
  import { prefs } from "./prefs.svelte.js";
  import { fetchQuotaApp, quotaAppStatus, requestQuotaAppSetup } from "./quotaAppStatus.svelte.js";

  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  let impact = $derived(quotaImpact(quota.resources, { restFallback: prefs.restFallbackEnabled, now }));
  let warning = $derived(impact.level !== "ok");
  // undefined: unknown or failed, never treated as "no App".
  let quotaApp = $state(undefined);
  let quotaAppHealth = $derived(quotaApp ? quotaAppStatus(quotaApp, now) : null);

  $effect(() => {
    if (!warning) return;
    let stopped = false;
    let load = 0;
    const refresh = async () => {
      const current = ++load;
      try {
        const app = await fetchQuotaApp();
        if (!stopped && current === load) quotaApp = app;
      } catch {
        if (!stopped && current === load) quotaApp = undefined;
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    refreshVisible();
    const timer = setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      stopped = true;
      quotaApp = undefined;
      clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  });

  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function inMinutes(iso) {
    const minutes = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
    if (minutes < 1) return "any moment";
    return `in ${minutes} min`;
  }
</script>

{#if warning}
  <section class="quota-banner {impact.level}" class:independent={impact.independent} role="status" aria-live="polite">
    <span class="qb-icon" aria-hidden="true">!</span>
    <div class="qb-copy">
      <strong class="qb-title">
        {impact.level === "out" ? quotaOutLabel(impact) : quotaLimitedLabel(impact)}
      </strong>
      <ul class="qb-list">
        {#each impact.pools as pool (`${pool.identity ?? "user"}:${pool.api}`)}
          <li>
            <span class="qb-pool mono">{pool.label} {pool.remaining.toLocaleString()} / {pool.limit.toLocaleString()}</span>
            <span>{pool.effect}</span>
            {#if impact.independent}
              <time class="qb-pool-reset mono" datetime={pool.resetAt}>{pool.cooldown ? "Limited until" : "Resets"} {clock(pool.resetAt)}</time>
            {/if}
          </li>
        {/each}
        {#if impact.mergeBlocked}
          <li><span class="qb-pool mono">merge</span><span>Cockpit refuses merges until the {impact.independent ? "User " : ""}quota resets — merge on GitHub instead</span></li>
        {/if}
        {#if quotaApp === null}
          <li class="qb-app">
            <span class="qb-pool mono">app</span>
            <span>A GitHub App adds its own read quota. It does not restore your quota for actions or lift GitHub's secondary limits.</span>
            <a href="#/settings/general" onclick={requestQuotaAppSetup}>Add GitHub App</a>
          </li>
        {:else if quotaApp}
          <li class="qb-app">
            <span class="qb-pool mono">app</span>
            <span>{quotaApp.name}: {quotaAppHealth?.summary.text ?? "status unknown"}</span>
            <a href="#/settings/general" onclick={requestQuotaAppSetup}>App status</a>
          </li>
        {/if}
      </ul>
    </div>
    {#if !impact.independent}
    <div class="qb-reset">
      <span>Restores</span>
      <strong>{inMinutes(impact.restoresAt)}</strong>
      <time class="qb-clock mono" datetime={impact.restoresAt}>{clock(impact.restoresAt)}</time>
    </div>
    {/if}
  </section>
{/if}

<style>
  .quota-banner {
    position: relative;
    z-index: 5;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 6px 18px 7px calc(18px + var(--quota-shell-inset, 0px));
    border-bottom: 1px solid color-mix(in srgb, var(--review) 20%, var(--border));
    background: color-mix(in srgb, var(--review-bg) 58%, var(--panel));
    color: var(--text);
    font-size: 12.5px;
  }
  .quota-banner.independent { grid-template-columns: auto minmax(0, 1fr); }
  .independent .qb-list { display: grid; }
  .independent .qb-list li { flex-wrap: wrap; }
  .qb-pool-reset { color: var(--text-faint); font-size: 10.5px; white-space: nowrap; }

  .quota-banner.out {
    border-bottom-color: color-mix(in srgb, var(--fail) 20%, var(--border));
    background: color-mix(in srgb, var(--fail-bg) 58%, var(--panel));
  }

  .qb-icon {
    display: grid;
    width: 22px;
    height: 22px;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--review) 24%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--review-bg) 70%, var(--panel));
    color: var(--review);
    font-size: 12px;
    font-weight: 700;
  }

  .quota-banner.out .qb-icon {
    border-color: color-mix(in srgb, var(--fail) 24%, transparent);
    background: color-mix(in srgb, var(--fail-bg) 70%, var(--panel));
    color: var(--fail);
  }

  .qb-copy {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  .qb-title {
    font-size: 12.5px;
    font-weight: 650;
    line-height: 1.2;
  }

  .qb-list {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 18px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-dim);
    font-size: 11.5px;
  }

  .qb-list li {
    display: flex;
    align-items: baseline;
    min-width: 0;
    gap: 6px;
    line-height: 1.35;
  }

  .qb-app a {
    flex: none;
    color: var(--link);
    font-weight: 600;
  }

  .qb-pool {
    flex: none;
    padding: 0 5px;
    border: 1px solid color-mix(in srgb, var(--review) 18%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--review-bg) 72%, var(--panel));
    color: var(--text-dim);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.015em;
    line-height: 1.45;
    text-transform: uppercase;
  }

  .quota-banner.out .qb-pool {
    border-color: color-mix(in srgb, var(--fail) 18%, transparent);
    background: color-mix(in srgb, var(--fail-bg) 72%, var(--panel));
  }

  .qb-reset {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 5px 8px;
    border: 1px solid color-mix(in srgb, var(--review) 18%, var(--border));
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--panel) 68%, transparent);
    color: var(--text-dim);
    font-size: 10.5px;
    white-space: nowrap;
  }

  .quota-banner.out .qb-reset {
    border-color: color-mix(in srgb, var(--fail) 18%, var(--border));
  }

  .qb-reset strong {
    color: var(--text);
    font-size: 11px;
    font-weight: 600;
  }

  .qb-clock {
    color: var(--text-faint);
    font-size: 9.5px;
  }

  .qb-clock::before {
    margin-right: 5px;
    content: "·";
  }

  @media (max-width: 980px) {
    .quota-banner {
      align-items: start;
    }

    .qb-reset {
      display: grid;
      white-space: normal;
      gap: 0;
    }

    .qb-clock::before {
      content: none;
    }
  }
</style>
