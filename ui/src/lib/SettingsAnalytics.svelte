<script>
  import { onMount } from "svelte";
  import { fetchMergedPrAnalytics } from "./api.js";

  let { repos = [] } = $props();

  const STORAGE_KEY = "cockpit:merged-pr-analytics";
  const RANGE_OPTIONS = [
    { value: "1", label: "24 hours" },
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" },
    { value: "60", label: "60 days" },
    { value: "90", label: "90 days" },
    { value: "120", label: "120 days" },
    { value: "150", label: "150 days" },
    { value: "180", label: "180 days" },
  ];
  const VALID_RANGES = new Set(RANGE_OPTIONS.map((option) => option.value));
  const SCOPE_PATTERN = /^[a-z][a-z0-9-]*\s*\(\s*([^)]+?)\s*\)\s*:/i;
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const CHART = { width: 1100, height: 300, left: 44, right: 16, top: 12, bottom: 38 };

  let initialized = $state(false);
  let selectedRepo = $state("");
  let base = $state("staging");
  let range = $state("30");
  let hiddenScopes = $state([]);
  let payload = $state(null);
  let loading = $state(false);
  let loadError = $state(null);
  let reloadKey = $state(0);
  let hover = $state(null);
  let hideTimer;

  function scopeOf(pr) {
    return pr.title.match(SCOPE_PATTERN)?.[1]?.trim().toLowerCase() ?? null;
  }

  function hash(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function authorColor(author) {
    return `hsl(${hash(author) % 360} 62% 58%)`;
  }

  function isoDay(date) {
    return date.toISOString().slice(0, 10);
  }

  function addUtcDays(day, amount) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return isoDay(date);
  }

  function formatBucket(date, bucketHours) {
    const weekday = WEEKDAYS[date.getUTCDay()];
    const day = isoDay(date).slice(5);
    if (bucketHours === 24) return `${weekday} ${day}`;
    return `${weekday} ${day} ${String(date.getUTCHours()).padStart(2, "0")}:00`;
  }

  function latestTimestamp(data) {
    const fromPayload = Date.parse(data?.asOf ?? "");
    if (Number.isFinite(fromPayload)) return fromPayload;
    return Math.max(0, ...(data?.pullRequests ?? []).map((pr) => Date.parse(pr.mergedAt) || 0));
  }

  function buildView(data, selectedRange, hidden) {
    if (!data) return null;
    const periodDays = Number(selectedRange);
    const rolling = periodDays === 1;
    const bucketHours = rolling ? 1 : periodDays === 7 ? 6 : 24;
    const bucketCount = (periodDays * 24) / bucketHours;
    const asOfMs = latestTimestamp(data);
    const asOfDay = isoDay(new Date(asOfMs));
    const startMs = rolling
      ? asOfMs - 24 * 60 * 60 * 1000
      : Date.parse(`${addUtcDays(asOfDay, 1 - periodDays)}T00:00:00Z`);
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const date = new Date(startMs + index * bucketHours * 60 * 60 * 1000);
      return { date, label: formatBucket(date, bucketHours), itemsByAuthor: new Map() };
    });
    const hiddenSet = new Set(hidden);
    const kept = data.pullRequests
      .filter((pr) => {
        const mergedAt = Date.parse(pr.mergedAt);
        const scope = scopeOf(pr);
        return mergedAt >= startMs && mergedAt <= asOfMs && (!scope || !hiddenSet.has(scope));
      })
      .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));

    for (const pr of kept) {
      const index = Math.floor((Date.parse(pr.mergedAt) - startMs) / (bucketHours * 60 * 60 * 1000));
      if (index < 0 || index >= buckets.length) continue;
      const author = pr.author || "unknown";
      const items = buckets[index].itemsByAuthor.get(author) ?? [];
      items.push(pr);
      buckets[index].itemsByAuthor.set(author, items);
    }

    const authors = [...new Set(kept.map((pr) => pr.author || "unknown"))];
    const series = authors
      .map((author) => {
        const items = buckets.map((bucket) => bucket.itemsByAuthor.get(author) ?? []);
        return {
          author,
          color: authorColor(author),
          items,
          values: items.map((bucketItems) => bucketItems.length),
          total: items.reduce((sum, bucketItems) => sum + bucketItems.length, 0),
        };
      })
      .sort((a, b) => b.total - a.total || a.author.localeCompare(b.author));

    return {
      rolling,
      periodDays,
      bucketHours,
      asOfMs,
      startMs,
      buckets,
      kept,
      series,
      intervalLabel: rolling ? "hourly" : bucketHours === 6 ? "six-hour" : "daily",
    };
  }

  function developerMetrics(series) {
    const byDay = new Map();
    for (const pr of series.items.flat()) {
      const day = pr.mergedAt.slice(0, 10);
      const items = byDay.get(day) ?? [];
      items.push(pr);
      byDay.set(day, items);
    }
    const nonSaturday = [...byDay.entries()]
      .filter(([day, items]) => new Date(`${day}T00:00:00Z`).getUTCDay() !== 6 && items.length > 0)
      .map(([, items]) => items);
    const baselinePpd = nonSaturday.length
      ? nonSaturday.reduce((sum, items) => sum + items.length, 0) / nonSaturday.length
      : Number.POSITIVE_INFINITY;
    const qualifyingSaturdays = [...byDay.entries()]
      .filter(([day, items]) => new Date(`${day}T00:00:00Z`).getUTCDay() === 6 && items.length >= baselinePpd * 0.8)
      .map(([, items]) => items);
    const workingDays = [...nonSaturday, ...qualifyingSaturdays];
    const pullRequests = workingDays.reduce((sum, items) => sum + items.length, 0);
    const minutes = workingDays.reduce((sum, items) => {
      const times = items.map((pr) => Date.parse(pr.mergedAt));
      return sum + Math.max(1, (Math.max(...times) - Math.min(...times)) / 60_000);
    }, 0);
    return {
      pullRequests,
      days: workingDays.length,
      ppd: workingDays.length ? pullRequests / workingDays.length : null,
      ppm: minutes ? pullRequests / minutes : null,
    };
  }

  function buildChart(viewState, cumulative) {
    if (!viewState) return { ticks: [], labels: [], lines: [] };
    const innerWidth = CHART.width - CHART.left - CHART.right;
    const innerHeight = CHART.height - CHART.top - CHART.bottom;
    const values = viewState.series.map((series) => {
      if (!cumulative) return series.values;
      let sum = 0;
      return series.values.map((value) => (sum += value));
    });
    const maximum = Math.max(1, ...values.flat());
    const step = cumulative
      ? Math.max(1, Math.ceil(maximum / 6 / 10) * 10)
      : Math.max(1, Math.ceil(maximum / 5));
    const ceiling = Math.max(step, Math.ceil(maximum / step) * step);
    const ticks = Array.from({ length: Math.floor(ceiling / step) + 1 }, (_, index) => {
      const value = index * step;
      return { value, y: CHART.top + innerHeight - (value / ceiling) * innerHeight };
    });
    const denominator = Math.max(1, viewState.buckets.length - 1);
    const labelEvery = Math.max(1, Math.ceil(viewState.buckets.length / 8));
    const labels = viewState.buckets
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ index }) => index === 0 || index === viewState.buckets.length - 1 || index % labelEvery === 0)
      .map(({ bucket, index }) => ({ label: bucket.label, x: CHART.left + (index / denominator) * innerWidth }));
    const lines = viewState.series.map((series, seriesIndex) => ({
      author: series.author,
      color: series.color,
      total: series.total,
      points: values[seriesIndex]
        .map((value, index) => `${CHART.left + (index / denominator) * innerWidth},${CHART.top + innerHeight - (value / ceiling) * innerHeight}`)
        .join(" "),
    }));
    return { ticks, labels, lines };
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ repo: selectedRepo, base, range, hiddenScopes }));
    } catch {
      // Settings remain usable when storage is unavailable.
    }
  }

  function toggleScope(scope) {
    hiddenScopes = hiddenScopes.includes(scope)
      ? hiddenScopes.filter((item) => item !== scope)
      : [...hiddenScopes, scope].sort();
  }

  function retry() {
    reloadKey += 1;
  }

  function cancelHoverHide() {
    clearTimeout(hideTimer);
  }

  function scheduleHoverHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (hover = null), 220);
  }

  function showHover(event, series, bucketIndex) {
    cancelHoverHide();
    const rect = event.currentTarget.getBoundingClientRect();
    const above = rect.top > window.innerHeight * 0.58;
    const cardHalfWidth = Math.min(430, window.innerWidth - 32) / 2;
    hover = {
      author: series.author,
      color: series.color,
      label: view.buckets[bucketIndex].label,
      items: series.items[bucketIndex],
      x: Math.max(16 + cardHalfWidth, Math.min(window.innerWidth - 16 - cardHalfWidth, rect.left + rect.width / 2)),
      y: above ? rect.top - 10 : rect.bottom + 10,
      above,
    };
  }

  onMount(() => {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      stored = {};
    }
    selectedRepo = repos.includes(stored.repo) ? stored.repo : repos[0] ?? "";
    base = typeof stored.base === "string" && stored.base.trim() ? stored.base : "staging";
    range = VALID_RANGES.has(stored.range) ? stored.range : "30";
    hiddenScopes = Array.isArray(stored.hiddenScopes)
      ? [...new Set(stored.hiddenScopes.filter((scope) => typeof scope === "string"))].sort()
      : [];
    initialized = true;
    return () => clearTimeout(hideTimer);
  });

  $effect(() => {
    if (!initialized) return;
    if (!repos.includes(selectedRepo)) selectedRepo = repos[0] ?? "";
  });

  $effect(() => {
    if (!initialized) return;
    selectedRepo;
    base;
    range;
    hiddenScopes;
    persist();
  });

  $effect(() => {
    if (!initialized) return;
    selectedRepo;
    base;
    range;
    hiddenScopes;
    hover = null;
  });

  $effect(() => {
    if (!initialized) return;
    const repo = selectedRepo;
    const branch = base.trim();
    const refresh = reloadKey;
    if (!repo || !branch) {
      payload = null;
      loading = false;
      loadError = null;
      return;
    }
    const controller = new AbortController();
    loading = true;
    payload = null;
    loadError = null;
    fetchMergedPrAnalytics(repo, branch, 180, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) payload = data;
      })
      .catch((error) => {
        if (!controller.signal.aborted) loadError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort(refresh);
  });

  let scopes = $derived.by(() => {
    const counts = new Map();
    for (const pr of payload?.pullRequests ?? []) {
      const scope = scopeOf(pr);
      if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
    return [...counts]
      .map(([scope, count]) => ({ scope, count }))
      .sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope));
  });
  let view = $derived(buildView(payload, range, hiddenScopes));
  let metrics = $derived(view?.series.map((series) => ({ ...series, metrics: developerMetrics(series) })) ?? []);
  let heatMaximum = $derived(Math.max(1, ...(view?.series.flatMap((series) => series.values) ?? [])));
  let dailyChart = $derived(buildChart(view, false));
  let cumulativeChart = $derived(buildChart(view, true));
  let timeSummary = $derived.by(() => {
    if (!view) return "";
    const start = new Date(view.startMs);
    const end = new Date(view.asOfMs);
    if (view.rolling) {
      return `${start.toISOString().slice(0, 16).replace("T", " ")}–${end.toISOString().slice(0, 16).replace("T", " ")} · rolling 24 hours · hourly · UTC`;
    }
    return `${isoDay(start)}–${isoDay(end)} · ${view.periodDays} days · ${view.intervalLabel} buckets · UTC`;
  });
</script>

<section class="analytics" aria-labelledby="analytics-title">
  <div class="intro">
    <span class="ui-eyebrow">Delivery patterns</span>
    <div class="title-row">
      <div>
        <h2 id="analytics-title">Merged pull request analytics</h2>
        <p>Explore merge pace and working-day throughput for each configured repository.</p>
      </div>
      {#if payload}<time datetime={payload.asOf}>As of {payload.asOf.slice(0, 16).replace("T", " ")} UTC</time>{/if}
    </div>
  </div>

  <div class="controls" aria-label="Analytics controls">
    <label class="control">
      <span>Repository</span>
      <select bind:value={selectedRepo} disabled={!repos.length}>
        {#if !repos.length}<option value="">No repositories configured</option>{/if}
        {#each repos as repo (repo)}<option value={repo}>{repo}</option>{/each}
      </select>
    </label>
    <label class="control">
      <span>Base branch</span>
      <input bind:value={base} spellcheck="false" autocomplete="off" placeholder="staging" />
    </label>
    <label class="control">
      <span>Range</span>
      <select bind:value={range}>
        {#each RANGE_OPTIONS as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </select>
    </label>
  </div>

  {#if !repos.length}
    <div class="state-card">
      <strong>Add a repository to begin</strong>
      <span>Configure at least one owner/name entry in General settings, then return to Analytics.</span>
      <a href="#/settings/general">Open General settings</a>
    </div>
  {:else}
    <details class="scope-control">
      <summary>
        <span>Hide PR title scopes</span>
        <span class="scope-summary">{scopes.length} found · {hiddenScopes.length} hidden</span>
      </summary>
      {#if scopes.length}
        <div class="scope-list">
          {#each scopes as item (item.scope)}
            <label class="scope-chip">
              <input type="checkbox" checked={hiddenScopes.includes(item.scope)} onchange={() => toggleScope(item.scope)} />
              <code>{item.scope}</code>
              <span>{item.count}</span>
            </label>
          {/each}
        </div>
      {:else}
        <p class="scope-empty">No conventional <code>type(scope):</code> titles were found in this payload.</p>
      {/if}
    </details>

    {#if !base.trim()}
      <div class="state-card">
        <strong>Enter a base branch</strong>
        <span>Analytics are repository-specific and need a branch such as <code>staging</code> or <code>main</code>.</span>
      </div>
    {:else if loading}
      <div class="status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>Loading 180 days of merged pull requests…</div>
    {:else if loadError}
      <div class="state-card error" role="alert">
        <strong>Analytics could not be loaded</strong>
        <span>{loadError}</span>
        <button type="button" onclick={retry}>Try again</button>
      </div>
    {:else if payload}
      <div class="summary-line">{selectedRepo} · <code>{payload.base}</code> · {timeSummary}</div>
      <div class="stats" aria-label="Analytics summary">
        <div class="stat"><strong>{view.kept.length.toLocaleString()}</strong><span>merged PRs</span></div>
        <div class="stat"><strong>{view.series.length}</strong><span>authors</span></div>
        <div class="stat"><strong>{hiddenScopes.length}</strong><span>hidden scopes</span></div>
      </div>

      {#if payload.pullRequests.length === 0}
        <div class="state-card">
          <strong>No merged pull requests yet</strong>
          <span>No pull requests were merged into <code>{payload.base}</code> during the fetched 180-day period.</span>
        </div>
      {:else if view.kept.length === 0}
        <div class="state-card">
          <strong>No merges match this view</strong>
          <span>Choose a wider range or show hidden title scopes to bring pull requests back into the charts.</span>
          {#if hiddenScopes.length}<button type="button" onclick={() => (hiddenScopes = [])}>Show all scopes</button>{/if}
        </div>
      {:else}
        <section class="panel" aria-labelledby="developer-metrics-title">
          <div class="panel-head">
            <div>
              <span class="ui-eyebrow">Working days</span>
              <h3 id="developer-metrics-title">Developer pace</h3>
            </div>
            <p>PPD excludes zero-merge days. Saturdays count when they reach 80% of that developer’s non-Saturday PPD; PPM uses first-to-last merge time.</p>
          </div>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Developer</th><th>PRs</th><th>Days</th><th>PPD</th><th>PPM</th></tr></thead>
              <tbody>
                {#each metrics as series (series.author)}
                  <tr>
                    <th><span class="author-dot" style={`--author-color: ${series.color}`} aria-hidden="true"></span>{series.author}</th>
                    <td>{series.metrics.pullRequests}</td>
                    <td>{series.metrics.days}</td>
                    <td>{series.metrics.ppd === null ? "—" : series.metrics.ppd.toFixed(2)}</td>
                    <td>{series.metrics.ppm === null ? "—" : series.metrics.ppm.toFixed(3)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel heatmap-panel" aria-labelledby="heatmap-title">
          <div class="panel-head">
            <div><span class="ui-eyebrow">Merge density</span><h3 id="heatmap-title">Author heatmap</h3></div>
            <p>Hover or focus a cell to inspect and open the pull requests in that interval.</p>
          </div>
          <div class="heatmap-scroll">
            <div class="heatmap" style={`--bucket-count: ${view.buckets.length}; --heatmap-width: ${184 + view.buckets.length * 24}px`}>
              <div class="corner" aria-hidden="true"></div>
              {#each view.buckets as bucket (bucket.date.toISOString())}<div class="bucket-label">{bucket.label}</div>{/each}
              <div class="total-head">Total</div>
              {#each view.series as series (series.author)}
                <div class="author-label"><span class="author-dot" style={`--author-color: ${series.color}`} aria-hidden="true"></span>{series.author}</div>
                {#each series.values as count, bucketIndex}
                  <button
                    class="heat-cell"
                    type="button"
                    style={`--heat: ${Math.round(18 + Math.sqrt(count / heatMaximum) * 70)}%`}
                    aria-label={`${series.author}, ${view.buckets[bucketIndex].label}: ${count} merged pull request${count === 1 ? "" : "s"}`}
                    onmouseenter={(event) => showHover(event, series, bucketIndex)}
                    onmouseleave={scheduleHoverHide}
                    onfocus={(event) => showHover(event, series, bucketIndex)}
                    onblur={scheduleHoverHide}
                  >{count || ""}</button>
                {/each}
                <div class="row-total">{series.total}</div>
              {/each}
            </div>
          </div>
        </section>

        <section class="panel chart-panel" aria-labelledby="daily-chart-title">
          <div class="panel-head">
            <div><span class="ui-eyebrow">Flow</span><h3 id="daily-chart-title">{view.intervalLabel[0].toUpperCase() + view.intervalLabel.slice(1)} pace</h3></div>
            <p>Non-cumulative merged pull requests per {view.intervalLabel} interval.</p>
          </div>
          <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label={`Merged pull requests per ${view.intervalLabel} interval by author`}>
            {#each dailyChart.ticks as tick (tick.value)}
              <line x1={CHART.left} y1={tick.y} x2={CHART.width - CHART.right} y2={tick.y}></line>
              <text x={CHART.left - 8} y={tick.y + 4} text-anchor="end">{tick.value}</text>
            {/each}
            {#each dailyChart.labels as label (`${label.x}-${label.label}`)}<text class="x-label" x={label.x} y={CHART.height - 10} text-anchor="middle">{label.label}</text>{/each}
            {#each dailyChart.lines as line (line.author)}<polyline points={line.points} style={`--author-color: ${line.color}`}><title>{line.author}</title></polyline>{/each}
          </svg>
          <div class="legend">{#each dailyChart.lines as line (line.author)}<span><i style={`--author-color: ${line.color}`}></i>{line.author}</span>{/each}</div>
        </section>

        <section class="panel chart-panel" aria-labelledby="cumulative-chart-title">
          <div class="panel-head">
            <div><span class="ui-eyebrow">Trajectory</span><h3 id="cumulative-chart-title">Cumulative merges</h3></div>
            <p>Running total for each author across the selected range.</p>
          </div>
          <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-label="Cumulative merged pull requests by author">
            {#each cumulativeChart.ticks as tick (tick.value)}
              <line x1={CHART.left} y1={tick.y} x2={CHART.width - CHART.right} y2={tick.y}></line>
              <text x={CHART.left - 8} y={tick.y + 4} text-anchor="end">{tick.value}</text>
            {/each}
            {#each cumulativeChart.labels as label (`${label.x}-${label.label}`)}<text class="x-label" x={label.x} y={CHART.height - 10} text-anchor="middle">{label.label}</text>{/each}
            {#each cumulativeChart.lines as line (line.author)}<polyline points={line.points} style={`--author-color: ${line.color}`}><title>{line.author}: {line.total}</title></polyline>{/each}
          </svg>
          <div class="legend">{#each cumulativeChart.lines as line (line.author)}<span><i style={`--author-color: ${line.color}`}></i>{line.author} · {line.total}</span>{/each}</div>
        </section>
      {/if}
    {/if}
  {/if}
</section>

{#if hover}
  <div
    class="hover-card"
    class:above={hover.above}
    style={`left: ${hover.x}px; top: ${hover.y}px; --author-color: ${hover.color}`}
    role="dialog"
    aria-label={`Merged pull requests for ${hover.author} in ${hover.label}`}
    onmouseenter={cancelHoverHide}
    onmouseleave={scheduleHoverHide}
  >
    <strong><span class="author-dot" aria-hidden="true"></span>{hover.author} · {hover.label}</strong>
    <span class="hover-count">{hover.items.length} merged PR{hover.items.length === 1 ? "" : "s"}</span>
    {#if hover.items.length}
      <div class="hover-links">
        {#each hover.items as pr (pr.number)}
          <a href={pr.url} target="_blank" rel="noreferrer"><span>#{pr.number}</span>{pr.title}</a>
        {/each}
      </div>
    {:else}
      <span class="hover-empty">No pull requests merged in this interval.</span>
    {/if}
  </div>
{/if}

<style>
  .analytics { display: grid; gap: var(--space-6); }
  .intro { display: grid; gap: var(--space-2); padding-bottom: var(--space-5); border-bottom: 1px solid var(--border); }
  .title-row { display: flex; justify-content: space-between; align-items: end; gap: var(--space-5); }
  h2, h3, p { margin: 0; }
  h2 { color: var(--text); font-family: var(--sans); font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
  h3 { color: var(--text); font-size: 14px; font-weight: 650; }
  .intro p, .panel-head p { color: var(--text-dim); font-size: 12px; line-height: 1.55; }
  .title-row time { flex: none; color: var(--text-faint); font-family: var(--mono); font-size: 10.5px; }
  .controls { display: grid; grid-template-columns: minmax(220px, 1.5fr) minmax(160px, 1fr) minmax(140px, 0.7fr); gap: var(--space-3); }
  .control { display: grid; gap: var(--space-2); color: var(--text-dim); font-size: 11px; font-weight: 600; }
  .control input, .control select { box-sizing: border-box; width: 100%; min-height: var(--control-md); padding: 0 var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); outline: none; background: var(--panel); box-shadow: var(--shadow-control-hairline); color: var(--text); font-family: var(--mono); font-size: 12px; }
  .control input:hover, .control select:hover { border-color: var(--border-hover); }
  .control input:focus-visible, .control select:focus-visible, .heat-cell:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .scope-control { padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
  summary { display: flex; justify-content: space-between; gap: var(--space-4); color: var(--text-dim); font-size: 12px; cursor: pointer; }
  .scope-summary { color: var(--text-faint); }
  .scope-list { display: flex; flex-wrap: wrap; gap: var(--space-2); padding-top: var(--space-3); }
  .scope-chip { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--control-sm); padding: 0 var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--text-dim); cursor: pointer; }
  .scope-chip input { accent-color: var(--native-accent); }
  .scope-chip code, .scope-empty code, .summary-line code, .state-card code { color: var(--text); font-family: var(--mono); font-size: 11px; }
  .scope-chip span { color: var(--text-faint); font-size: 10px; }
  .scope-empty { padding-top: var(--space-3); color: var(--text-faint); font-size: 12px; }
  .status, .state-card { display: flex; align-items: center; gap: var(--space-3); min-height: 68px; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--text-dim); font-size: 12px; }
  .state-card { align-items: flex-start; flex-direction: column; gap: var(--space-2); }
  .state-card strong { color: var(--text); font-size: 13px; }
  .state-card.error { border-color: color-mix(in srgb, var(--fail) 35%, var(--border)); background: var(--fail-bg); }
  .state-card button, .state-card a { padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--link); font: inherit; text-decoration: none; cursor: pointer; }
  .spinner { width: 13px; height: 13px; border: 2px solid var(--border-hover); border-top-color: var(--link); border-radius: 50%; animation: spin 800ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .summary-line { color: var(--text-faint); font-family: var(--mono); font-size: 10.5px; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  .stat { display: grid; gap: var(--space-1); padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
  .stat strong { color: var(--text); font-family: var(--mono); font-size: 20px; font-weight: 600; }
  .stat span { color: var(--text-faint); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; }
  .panel { overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--panel); }
  .panel-head { display: flex; align-items: end; justify-content: space-between; gap: var(--space-5); padding: var(--space-4); border-bottom: 1px solid var(--border-soft); }
  .panel-head > div { display: grid; gap: var(--space-1); }
  .panel-head p { max-width: 620px; text-align: right; }
  .table-scroll, .heatmap-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; }
  th, td { padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--border-soft); text-align: right; }
  thead th { color: var(--text-faint); font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
  th:first-child { text-align: left; }
  .heatmap { display: grid; grid-template-columns: 132px repeat(var(--bucket-count), minmax(24px, 1fr)) 52px; min-width: var(--heatmap-width); padding: var(--space-3); }
  tbody th { color: var(--text); font-weight: 500; }
  .author-dot { display: inline-block; width: 7px; height: 7px; margin-right: var(--space-2); border-radius: 50%; background: var(--author-color); }
  .corner, .bucket-label, .total-head { height: 78px; }
  .bucket-label { display: flex; align-items: end; justify-content: center; padding-bottom: var(--space-2); color: var(--text-faint); font-family: var(--mono); font-size: 9px; line-height: 1; writing-mode: vertical-rl; transform: rotate(180deg); }
  .total-head { display: flex; align-items: end; justify-content: end; padding-bottom: var(--space-2); color: var(--text-faint); font-size: 9px; text-transform: uppercase; }
  .author-label, .row-total { display: flex; align-items: center; min-width: 0; height: 28px; color: var(--text-dim); font-family: var(--mono); font-size: 10.5px; }
  .author-label { overflow: hidden; padding-right: var(--space-3); text-overflow: ellipsis; white-space: nowrap; }
  .row-total { justify-content: end; color: var(--text); }
  .chart-panel { overflow-x: auto; }
  .heat-cell { height: 24px; margin: 2px; padding: 0; border: 1px solid color-mix(in srgb, var(--native-blue) 10%, var(--border)); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--native-blue) var(--heat), var(--surface)); color: var(--native-on-accent); font-family: var(--mono); font-size: 9px; cursor: default; }
  .heat-cell:empty { background: var(--surface); color: var(--text-faint); }
  .chart-panel svg { display: block; width: 100%; min-width: 680px; height: auto; padding: var(--space-3); box-sizing: border-box; overflow: visible; }
  svg line { stroke: var(--border); stroke-width: 1; }
  svg text { fill: var(--text-faint); font-family: var(--mono); font-size: 9px; }
  svg .x-label { font-size: 8px; }
  svg polyline { fill: none; stroke: var(--author-color); stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); padding: 0 var(--space-4) var(--space-4); color: var(--text-dim); font-family: var(--mono); font-size: 10.5px; }
  .legend span { display: inline-flex; align-items: center; gap: var(--space-2); }
  .legend i { width: 12px; height: 2px; background: var(--author-color); }
  .hover-card { position: fixed; z-index: 60; width: min(430px, calc(100vw - 32px)); max-height: min(380px, calc(100vh - 32px)); overflow: auto; padding: var(--space-3); border: 1px solid var(--border-hover); border-radius: var(--radius-md); background: var(--panel); box-shadow: var(--shadow-dialog); color: var(--text); transform: translateX(-50%); }
  .hover-card.above { transform: translate(-50%, -100%); }
  .hover-card > strong { display: block; font-size: 12px; }
  .hover-count, .hover-empty { display: block; margin-top: var(--space-1); color: var(--text-faint); font-size: 10.5px; }
  .hover-links { display: grid; gap: var(--space-1); margin-top: var(--space-3); }
  .hover-links a { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-sm); color: var(--text); font-size: 11.5px; line-height: 1.35; text-decoration: none; }
  .hover-links a:hover { background: var(--surface); }
  .hover-links a span { color: var(--link); font-family: var(--mono); }
  @media (max-width: 760px) {
    .title-row, .panel-head { align-items: flex-start; flex-direction: column; }
    .panel-head p { text-align: left; }
    .controls { grid-template-columns: 1fr; }
    .heatmap { grid-template-columns: 112px repeat(var(--bucket-count), minmax(24px, 1fr)) 44px; min-width: calc(var(--heatmap-width) - 28px); }
  }
</style>
