<script>
  import { fetchGithubUsage, saveSettings } from "./api.js";
  import { cachedView, cacheView } from "./detailCache.js";

  let data = $state(cachedView("usage"));
  let error = $state(null);
  let restSaving = $state(false);
  let restSaveError = $state(null);

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
  // A REST tally's split beyond its charged count: 304s GitHub served free, other free calls such as
  // /rate_limit, and attempts whose charge GitHub never confirmed.
  const unchargedParts = (row) => {
    const free = row.requests - row.chargedRequests - row.notModifiedRequests - row.unknownChargeRequests;
    return [
      `${number.format(row.notModifiedRequests)} 304 free`,
      ...(free > 0 ? [`${number.format(free)} other free`] : []),
      ...(row.unknownChargeRequests > 0 ? [`${number.format(row.unknownChargeRequests)} unknown charge`] : []),
    ];
  };
  const chargeSummary = (row) => [`${number.format(row.chargedRequests)} charged`, ...unchargedParts(row)].join(" · ");
  // Rows rank by charged requests, which they show as their value, so the summary leads with the total.
  const requestSummary = (row) => [`${number.format(row.requests)} requests`, ...unchargedParts(row)].join(" · ");
  const restOtherLabel = (restUsage) => {
    if (restUsage.otherRequests !== null) return "requests from other clients";
    if (restUsage.unknownChargeRequests > 0) return "other clients: unknown charges this window";
    if (restUsage.windowComplete) return "other clients: attribution incomplete";
    if (restUsage.coverage?.eligible === false) return "other clients: unknown while Cockpit runs gh";
    return "other clients: awaiting full window";
  };

  async function load() {
    const next = await fetchGithubUsage();
    cacheView("usage", next);
    data = next;
  }

  async function setRestRecording(input) {
    const enabled = input.checked;
    restSaving = true;
    restSaveError = null;
    try {
      await saveSettings({ rest_usage_enabled: enabled });
    } catch (failure) {
      input.checked = !enabled;
      restSaveError = failure.message;
      restSaving = false;
      return;
    }
    try {
      await load();
    } catch (failure) {
      restSaveError = failure.message;
    } finally {
      restSaving = false;
    }
  }

  $effect(() => {
    load().catch((failure) => (error = failure.message));
  });
</script>

<div class="page">
  <header class="head">
    <div class="head-title-wrap">
      <span class="head-title">Usage</span>
    </div>
  </header>

  {#if data?.quota && data?.usage}
    {@const quota = data.quota}
    {@const usage = data.usage}
    {@const chartMax = Math.max(1, usage.predictedUsed ?? 0, ...usage.history.map((bucket) => bucket.used ?? 0))}
    {@const rest = data.rest ?? null}
    {@const restUsage = data.restUsage ?? null}
    {@const restChartMax = Math.max(1, ...(restUsage?.history ?? []).map((bucket) => Math.max(bucket.used ?? 0, bucket.chargedRequests)))}
    {#snippet restPools()}
      {#each [["GitHub REST core", rest], ["GitHub REST search", data.search]] as [label, pool] (label)}
        {#if pool}
          {@const cooling = !!pool.blockedUntil && Date.parse(pool.blockedUntil) > Date.now()}
          <div class="rest-quota" class:exhausted={pool.remaining === 0 || cooling}>
            <span>{label}</span>
            <strong>
              {#if pool.remaining === 0}
                Exhausted until {resetTime(pool.blockedUntil ?? pool.resetAt)}
              {:else if cooling}
                Rate limited until {resetTime(pool.blockedUntil)}
              {:else}
                {number.format(pool.remaining)} of {number.format(pool.limit)} remaining · resets {resetTime(pool.resetAt)}
              {/if}
            </strong>
          </div>
        {/if}
      {/each}
    {/snippet}
    {#snippet restRecording(enabled)}
      <label class="check-field rest-recording">
        <input class="check" type="checkbox" checked={enabled} disabled={restSaving} onchange={(event) => setRestRecording(event.currentTarget)} />
        <span class="check-text">
          <span class="check-label">Record REST requests</span>
          {#if restSaveError}
            <span class="hint save-error" role="alert">{restSaveError}</span>
          {:else}
            <span class="hint">Counts this cockpit's GitHub REST requests by feature and endpoint.</span>
          {/if}
        </span>
      </label>
    {/snippet}
    {#if restUsage}
      <section class="usage-card" aria-label="GitHub REST core usage">
        <div class="usage-head">
          <div>
            <span class="label">GitHub REST core usage</span>
            <span class="hint">{restUsage.machine}</span>
          </div>
          {#if rest}
            <div class="usage-totals">
              <strong>{percent(rest.used, rest.limit).toFixed(1)}%</strong>
              <span>Resets at {resetTime(rest.resetAt)}</span>
            </div>
          {/if}
        </div>

        {#if rest}
          <div
            class="quota-track"
            role="meter"
            aria-label="GitHub REST core quota consumed"
            aria-valuemin="0"
            aria-valuemax={rest.limit}
            aria-valuenow={rest.used}
          >
            <span class="quota-used" style={`width: ${percent(rest.used, rest.limit)}%`}></span>
          </div>
        {/if}

        <div class="usage-stats">
          {#if rest}
            <div>
              <strong>{number.format(rest.used)}</strong>
              <span>of {number.format(rest.limit)} requests charged</span>
            </div>
          {/if}
          <div>
            <strong>{number.format(restUsage.chargedRequests)}</strong>
            <span>charged from this cockpit · {number.format(restUsage.localRequests)} requests</span>
          </div>
          <div>
            <strong>{restUsage.otherRequests === null ? "—" : number.format(restUsage.otherRequests)}</strong>
            <span>{restOtherLabel(restUsage)}</span>
          </div>
        </div>

        <div class="rest-quota">
          <span>This cockpit · REST core</span>
          <strong>{chargeSummary({ ...restUsage, requests: restUsage.localRequests })}</strong>
        </div>
        {@render restPools()}
        {@render restRecording(true)}
      </section>

      <section class="history-card" aria-labelledby="rest-history-title">
        <div class="section-head">
          <div>
            <span class="label" id="rest-history-title">Hourly REST core usage</span>
            <span class="hint">Last three days</span>
          </div>
          <div class="legend" aria-hidden="true">
            <span><i class="total-key"></i>Charged, all clients</span>
            <span><i class="observed-key"></i>Charged, this cockpit</span>
          </div>
        </div>
        <div class="history-chart" aria-label="GitHub REST core requests charged per hour over the last three days">
          {#each restUsage.history as bucket}
            <div
              class="history-hour"
              title={`${hourLabel(bucket.resetAt)}: ${bucket.used === null ? "no pool observation" : `${number.format(bucket.used)} charged by all clients`}, ${number.format(bucket.chargedRequests)} charged of ${number.format(bucket.localRequests)} requests from this cockpit${bucket.unknownChargeRequests ? `, ${number.format(bucket.unknownChargeRequests)} unknown charge` : ""}`}
            >
              {#if bucket.used !== null}
                <i class="history-total" style={`height: ${percent(bucket.used, restChartMax)}%`}></i>
              {/if}
              {#if bucket.chargedRequests > 0}
                <i class="history-observed" style={`height: ${percent(bucket.chargedRequests, restChartMax)}%`}></i>
              {:else if bucket.used === null}
                <i class="history-missing"></i>
              {/if}
            </div>
          {/each}
        </div>
        <div class="history-axis" aria-hidden="true">
          <span>{dayLabel(restUsage.history[0].resetAt)}</span>
          <span>{dayLabel(restUsage.history[24].resetAt)}</span>
          <span>{dayLabel(restUsage.history[48].resetAt)}</span>
          <span>Now</span>
        </div>
      </section>

      <section class="breakdowns">
        <div class="usage-breakdown">
          <span class="usage-subhead">REST by feature</span>
          {#each restUsage.sources as item}
            <div class="usage-row">
              <span>{item.source}</span>
              <span class="usage-row-track"><i style={`width: ${percent(item.chargedRequests, restUsage.chargedRequests)}%`}></i></span>
              <strong>{number.format(item.chargedRequests)}</strong>
              <small>{requestSummary(item)}</small>
            </div>
          {:else}
            <span class="usage-empty">No REST requests this window.</span>
          {/each}
        </div>
        <div class="usage-breakdown">
          <span class="usage-subhead">Top REST endpoints</span>
          {#each restUsage.endpoints.slice(0, 8) as item}
            <div class="usage-operation" title={requestSummary(item)}>
              <span>{item.method} {item.endpoint}</span>
              <strong>{number.format(item.chargedRequests)} charged · {number.format(item.requests)} req</strong>
            </div>
          {:else}
            <span class="usage-empty">No REST requests yet.</span>
          {/each}
        </div>
      </section>

      <span class="usage-window rest-window">REST core window began {resetTime(restUsage.windowStartedAt)}.{#if restUsage.unknownChargeRequests} {number.format(restUsage.unknownChargeRequests)} requests with unknown charge.{/if} REST search is counted in its own pool.</span>
    {/if}

    <section class="usage-card" aria-label="GitHub GraphQL usage">
      <div class="usage-head">
        <div>
          <span class="label">GitHub GraphQL usage</span>
          <span class="hint">{usage.machine}</span>
        </div>
        <div class="usage-totals">
          <strong>{percent(quota.used, quota.limit).toFixed(1)}%</strong>
          <span>
            {#if usage.predictedUsed === null}
              Forecast needs five minutes
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
          <span>{usage.windowComplete ? "points from other clients" : "other clients: awaiting full window"}</span>
        </div>
      </div>

      {#if !restUsage}
        {@render restPools()}
        {#if "restUsage" in data}
          {@render restRecording(false)}
        {:else}
          <div class="rest-quota">
            <span>GitHub REST attribution</span>
            <strong>Unavailable: this server does not record its REST requests</strong>
          </div>
        {/if}
      {/if}
    </section>

    <section class="history-card" aria-labelledby="usage-history-title">
      <div class="section-head">
        <div>
          <span class="label" id="usage-history-title">Hourly GraphQL usage</span>
          <span class="hint">Last three days</span>
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
        <span class="usage-subhead">GraphQL by feature</span>
        {#each usage.sources as item}
          <div class="usage-row">
            <span>{item.source}</span>
            <span class="usage-row-track"><i style={`width: ${percent(item.points, usage.localPoints)}%`}></i></span>
            <strong>{number.format(item.points)}</strong>
            <small>{number.format(item.requests)} calls</small>
          </div>
        {:else}
          <span class="usage-empty">No calls this hour.</span>
        {/each}
      </div>
      <div class="usage-breakdown">
        <span class="usage-subhead">Top GraphQL operations</span>
        {#each usage.operations.slice(0, 8) as item}
          <div class="usage-operation">
            <span>{item.operation}</span>
            <strong>{number.format(item.points)} pts</strong>
          </div>
        {:else}
          <span class="usage-empty">No calls yet.</span>
        {/each}
      </div>
    </section>

    <span class="usage-window">GraphQL resets at {resetTime(quota.resetAt)}.{#if usage.unknownCostRequests} {number.format(usage.unknownCostRequests)} calls with unknown cost.{/if}</span>
  {:else if error}
    <div class="state error">GitHub usage is unavailable: {error}</div>
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
  .rest-window {
    padding-bottom: 22px;
    border-bottom: 1px solid var(--border);
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
  .rest-quota {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    margin-top: 16px;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 11px;
  }
  .rest-quota strong {
    color: var(--text);
    font-weight: 500;
  }
  .rest-quota.exhausted strong { color: var(--fail); }
  .rest-recording { margin-top: 18px; }
  .check-field { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .check-label { color: var(--text); font-size: 13px; line-height: 21px; }
  .save-error { color: var(--fail); }
  .check {
    appearance: none;
    position: relative;
    width: 36px;
    height: 21px;
    margin: 0;
    flex: none;
    border: 0;
    border-radius: 999px;
    background: var(--switch-unchecked);
    cursor: pointer;
  }
  .check::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--switch-thumb);
    box-shadow: var(--shadow-control-hairline);
  }
  .check:checked { background: var(--link); }
  .check:checked::after { transform: translateX(15px); }
  .check:disabled { opacity: 0.6; cursor: default; }
  .check:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
  }
  @media (hover: hover) and (pointer: fine) {
    .check:hover:not(:disabled) { background: var(--switch-unchecked-hover); }
    .check:checked:hover:not(:disabled) { background: var(--brand-hover); }
  }
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
  .history-predicted,
  .history-total { background: color-mix(in srgb, var(--accent) 28%, transparent); }
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
  .predicted-key,
  .total-key { background: color-mix(in srgb, var(--accent) 28%, transparent); }
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
  .state.error { color: var(--fail); }

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
