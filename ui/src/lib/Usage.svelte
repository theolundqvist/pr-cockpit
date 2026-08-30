<script>
  import { fetchGithubUsage } from "./api.js";

  let data = $state(null);
  let error = $state(false);

  const number = new Intl.NumberFormat();
  const percent = (value, total) => total > 0 ? Math.min(100, (value / total) * 100) : 0;
  const resetTime = (timestamp) => new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hourLabel = (timestamp) => new Date(Date.parse(timestamp) - 60 * 60_000).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const dayLabel = (timestamp) => new Date(Date.parse(timestamp) - 60 * 60_000).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  $effect(() => {
    fetchGithubUsage()
      .then((next) => (data = next))
      .catch(() => (error = true));
  });
</script>

<div class="page">
  <header class="head">
    <div class="head-title-wrap">
      <span class="ui-eyebrow">Control center</span>
      <span class="head-title">Usage</span>
    </div>
  </header>

  {#if data?.quota && data?.usage}
    {@const quota = data.quota}
    {@const usage = data.usage}
    {@const chartMax = Math.max(1, usage.predictedUsed ?? 0, ...usage.history.map((bucket) => bucket.used ?? 0))}
    <section class="usage-card" aria-label="GitHub GraphQL usage">
      <div class="usage-head">
        <div>
          <span class="label">GitHub GraphQL usage</span>
          <span class="hint">Current hourly GitHub window on {usage.machine}</span>
        </div>
        <div class="usage-totals">
          <strong>{percent(quota.used, quota.limit).toFixed(1)}%</strong>
          <span>
            {#if usage.predictedUsed === null}
              Prediction available after five minutes
            {:else}
              Predicted {percent(usage.predictedUsed, quota.limit).toFixed(1)}% by {resetTime(quota.resetAt)}
            {/if}
          </span>
        </div>
      </div>

      <div
        class="quota-track"
        role="meter"
        aria-label="GitHub GraphQL quota consumed"
        aria-valuemin="0"
        aria-valuemax={quota.limit}
        aria-valuenow={quota.used}
      >
        {#if usage.predictedUsed !== null}
          <span class="quota-predicted" style={`width: ${percent(usage.predictedUsed, quota.limit)}%`}></span>
        {/if}
        <span class="quota-used" style={`width: ${percent(quota.used, quota.limit)}%`}></span>
      </div>

      <div class="usage-stats">
        <div>
          <strong>{number.format(quota.used)}</strong>
          <span>of {number.format(quota.limit)} points consumed</span>
        </div>
        <div>
          <strong>{number.format(usage.localPoints)}</strong>
          <span>points from this cockpit · {number.format(usage.localRequests)} calls</span>
        </div>
        <div>
          <strong>{usage.otherPoints === null ? "—" : number.format(usage.otherPoints)}</strong>
          <span>{usage.windowComplete ? "points from other clients" : "other clients after one full tracked window"}</span>
        </div>
      </div>
    </section>

    <section class="history-card" aria-labelledby="usage-history-title">
      <div class="section-head">
        <div>
          <span class="label" id="usage-history-title">Hourly usage</span>
          <span class="hint">Last three days · each bar is one GitHub quota window</span>
        </div>
        <div class="legend" aria-hidden="true">
          <span><i class="observed-key"></i>Observed</span>
          <span><i class="predicted-key"></i>Predicted this hour</span>
        </div>
      </div>
      <div class="history-chart" aria-label="GitHub GraphQL points used per hour over the last three days">
        {#each usage.history as bucket, index}
          {@const current = index === usage.history.length - 1}
          <div
            class="history-hour"
            title={`${hourLabel(bucket.resetAt)}: ${bucket.used === null ? "no observation" : `${number.format(bucket.used)} points`}${current && usage.predictedUsed !== null ? `, ${number.format(usage.predictedUsed)} predicted` : ""}`}
          >
            {#if current && usage.predictedUsed !== null}
              <i class="history-predicted" style={`height: ${percent(usage.predictedUsed, chartMax)}%`}></i>
            {/if}
            {#if bucket.used !== null}
              <i class="history-observed" style={`height: ${percent(bucket.used, chartMax)}%`}></i>
            {:else}
              <i class="history-missing"></i>
            {/if}
          </div>
        {/each}
      </div>
      <div class="history-axis" aria-hidden="true">
        <span>{dayLabel(usage.history[0].resetAt)}</span>
        <span>{dayLabel(usage.history[24].resetAt)}</span>
        <span>{dayLabel(usage.history[48].resetAt)}</span>
        <span>Now</span>
      </div>
    </section>

    <section class="breakdowns">
      <div class="usage-breakdown">
        <span class="usage-subhead">By feature</span>
        {#each usage.sources as item}
          <div class="usage-row">
            <span>{item.source}</span>
            <span class="usage-row-track"><i style={`width: ${percent(item.points, usage.localPoints)}%`}></i></span>
            <strong>{number.format(item.points)}</strong>
            <small>{number.format(item.requests)} calls</small>
          </div>
        {:else}
          <span class="usage-empty">No GraphQL calls recorded in this window.</span>
        {/each}
      </div>
      <div class="usage-breakdown">
        <span class="usage-subhead">Top operations</span>
        {#each usage.operations.slice(0, 8) as item}
          <div class="usage-operation">
            <span>{item.operation}</span>
            <strong>{number.format(item.points)} pts</strong>
          </div>
        {:else}
          <span class="usage-empty">Usage appears here after the next GitHub request.</span>
        {/each}
      </div>
    </section>

    <span class="usage-window">Resets at {resetTime(quota.resetAt)}. {usage.unknownCostRequests ? `${number.format(usage.unknownCostRequests)} calls have unknown cost.` : "Every recorded call has an exact cost."}</span>
  {:else if error}
    <div class="state error">GitHub usage is unavailable.</div>
  {:else}
    <div class="state">Loading usage…</div>
  {/if}
</div>

<style>
  .page {
    padding: 18px 32px 96px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    min-height: 50px;
    margin-bottom: 24px;
    border-bottom: 1px solid var(--border);
  }
  .head-title-wrap,
  .usage-head > div:first-child,
  .section-head > div:first-child {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ui-eyebrow,
  .usage-subhead {
    color: var(--text-faint);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .head-title {
    color: var(--text);
    font-size: 17px;
    font-weight: 600;
  }
  .usage-card,
  .history-card,
  .breakdowns {
    border-bottom: 1px solid var(--border);
    padding: 0 0 22px;
    margin-bottom: 22px;
  }
  .usage-head,
  .section-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }
  .label {
    color: var(--text);
    font-size: 13px;
    font-weight: 500;
  }
  .hint,
  .usage-window,
  .usage-empty,
  .usage-operation,
  .usage-row,
  .legend,
  .history-axis {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 11px;
  }
  .usage-totals {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }
  .usage-totals strong {
    color: var(--text);
    font-family: var(--sans);
    font-size: 23px;
    font-weight: 500;
  }
  .usage-totals span {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 11px;
  }
  .quota-track {
    position: relative;
    height: 7px;
    margin: 18px 0 14px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-3);
  }
  .quota-track span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
  }
  .quota-predicted { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .quota-used { background: var(--accent); }
  .usage-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 24px;
  }
  .usage-stats strong,
  .usage-stats span { display: block; }
  .usage-stats strong {
    color: var(--text);
    font-family: var(--sans);
    font-size: 17px;
    font-weight: 500;
  }
  .usage-stats span { margin-top: 2px; }
  .history-chart {
    display: grid;
    grid-template-columns: repeat(72, minmax(2px, 1fr));
    align-items: end;
    gap: 2px;
    height: 128px;
    margin-top: 20px;
    border-bottom: 1px solid var(--border-strong);
    background: repeating-linear-gradient(to top, transparent 0, transparent 31px, var(--border) 32px);
  }
  .history-hour {
    position: relative;
    height: 100%;
  }
  .history-hour i {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    min-height: 1px;
    border-radius: 1px 1px 0 0;
  }
  .history-observed { background: var(--accent); }
  .history-predicted { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .history-missing {
    height: 1px;
    background: var(--border-strong);
  }
  .history-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 7px;
  }
  .legend {
    display: flex;
    gap: 14px;
  }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .legend i {
    width: 9px;
    height: 9px;
    border-radius: 1px;
  }
  .observed-key { background: var(--accent); }
  .predicted-key { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .breakdowns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(240px, 1fr);
    gap: 48px;
  }
  .usage-breakdown {
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-width: 0;
  }
  .usage-row {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) minmax(80px, 1.6fr) auto auto;
    align-items: center;
    gap: 12px;
  }
  .usage-row > span:first-child,
  .usage-operation span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage-row strong,
  .usage-operation strong {
    color: var(--text);
    font-weight: 500;
  }
  .usage-row small { color: var(--text-faint); }
  .usage-row-track {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-3);
  }
  .usage-row-track i {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: color-mix(in srgb, var(--accent) 75%, var(--text-faint));
  }
  .usage-operation {
    display: flex;
    justify-content: space-between;
    gap: 14px;
  }
  .usage-window { display: block; }
  .state {
    padding: 28px 0;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 12px;
  }
  .state.error { color: var(--danger); }

  @media (max-width: 900px) {
    .page { padding-right: 20px; padding-left: 20px; }
    .usage-stats,
    .breakdowns { grid-template-columns: 1fr; }
    .breakdowns { gap: 28px; }
    .usage-head,
    .section-head { align-items: flex-start; flex-direction: column; }
    .usage-totals { align-items: flex-start; }
    .legend { flex-wrap: wrap; }
  }
</style>
