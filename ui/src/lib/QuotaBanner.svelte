<script>
  import { quota } from "./quota.svelte.js";
  import { quotaImpact, quotaOutLabel } from "./quotaImpact.js";

  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  let impact = $derived(quotaImpact(quota.resources));

  function clock(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function inMinutes(iso) {
    const minutes = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
    if (minutes < 1) return "any moment";
    return `in ${minutes} min`;
  }
</script>

{#if impact.level !== "ok"}
  <section class="quota-banner {impact.level}" role="status" aria-live="polite">
    <span class="qb-icon" aria-hidden="true">!</span>
    <div class="qb-copy">
      <strong class="qb-title">
        {impact.level === "out" ? quotaOutLabel(impact) : "GitHub GraphQL quota nearly exhausted"}
      </strong>
      <ul class="qb-list">
        {#each impact.pools as pool (pool.api)}
          <li><span class="qb-pool mono">{pool.label} {pool.remaining.toLocaleString()} / {pool.limit.toLocaleString()}</span>{pool.effect}</li>
        {/each}
        {#if impact.mergeBlocked}
          <li><span class="qb-pool mono">merge</span>Cockpit refuses merges until the quota resets — merge on GitHub instead</li>
        {/if}
      </ul>
    </div>
    <div class="qb-reset mono">
      <span class="qb-reset-label">restores</span>
      <strong>{clock(impact.restoresAt)}</strong>
      <span>{inMinutes(impact.restoresAt)}</span>
    </div>
  </section>
{/if}

<style>
  .quota-banner {
    position: relative;
    z-index: 5;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 20px 11px;
    border-bottom: 1px solid var(--border);
    background: var(--review-bg);
    color: var(--text);
    font-size: 12.5px;
  }

  .quota-banner.out {
    background: var(--fail-bg);
  }

  .qb-icon {
    flex: none;
    display: grid;
    width: 17px;
    height: 17px;
    place-items: center;
    margin-top: 1px;
    border-radius: 50%;
    background: var(--review);
    color: var(--panel);
    font-size: 11px;
    font-weight: 700;
  }

  .quota-banner.out .qb-icon {
    background: var(--fail);
  }

  .qb-copy {
    min-width: 0;
    flex: 1;
  }

  .qb-title {
    font-size: 12.5px;
    font-weight: 600;
  }

  .qb-list {
    margin: 3px 0 0;
    padding: 0;
    list-style: none;
    color: var(--text-dim);
    font-size: 12px;
  }

  .qb-list li {
    display: flex;
    gap: 8px;
  }

  .qb-pool {
    flex: none;
    min-width: 132px;
    color: var(--text-faint);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    line-height: 1.5;
  }

  .qb-reset {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11px;
    color: var(--text-dim);
  }

  .qb-reset-label {
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 9.5px;
  }

  @media (max-width: 980px) {
    .qb-reset {
      flex-direction: column;
      gap: 1px;
    }
  }
</style>
