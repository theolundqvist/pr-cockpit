<script>
  import { DRAFT_PREFIX, isDraftPr } from "../../../shared/prGrouping.ts";
  import { prefs } from "./prefs.svelte.js";
  import { relativeTime } from "./time.js";
  import Avatar from "./Avatar.svelte";
  import CurrentBranchBadge from "./CurrentBranchBadge.svelte";

  // The inbox's PR row. Views without the queue's selection, drag and rename state pass only the PR, its status and a link.
  let {
    pr,
    status,
    href,
    age = undefined,
    ageTitle = undefined,
    editing = false,
    selected = false,
    multiSelected = false,
    archived = false,
    stacked = false,
    dragging = false,
    dropBefore = false,
    dropAfter = false,
    descriptionChanged = false,
    editor = undefined,
    badge = undefined,
    meta = undefined,
    keys = undefined,
    media = undefined,
    ...rest
  } = $props();

  function greptileTitle(greptileStatus) {
    if (greptileStatus === "stale") return "reviewed before recent pushes - the score may no longer reflect the current state";
    if (greptileStatus === "addressed") return "reviewed before recent pushes, but every thread that reviewer left is resolved";
    return "Greptile confidence";
  }
</script>

<svelte:element
  this={editing ? "div" : "a"}
  role={editing ? "group" : "link"}
  class="row {status.tone}"
  class:selected
  class:multi-selected={multiSelected}
  class:archived-row={archived}
  class:stack-child={stacked}
  class:dragging
  class:drop-before={dropBefore}
  class:drop-after={dropAfter}
  href={editing ? undefined : href}
  {...rest}
>
  {#if stacked}<span class="stack-glyph" aria-hidden="true">└</span>{/if}
  <span class="row-avatar">
    {#if descriptionChanged}
      <span class="description-dot" role="img" aria-label="Description changed" title="Description changed since you last read it"></span>
    {/if}
    <Avatar login={pr.author} url={`https://github.com/${pr.author}.png?size=64`} size={30} />
  </span>
  {#if badge}
    {@render badge()}
  {:else}
    <span class="row-badge-slot"><span class="row-badge badge {status.tone}">{status.label}</span></span>
  {/if}
  <div class="row-main">
    {#if editing}
      {@render editor()}
    {:else}
    <div class="row-title">
      {#if isDraftPr(pr)}<span class="badge wait row-draft">Draft</span>{/if}
      <span class="row-title-text">{pr.title.startsWith(DRAFT_PREFIX) ? pr.title.slice(DRAFT_PREFIX.length) : pr.title}</span>
      {#if pr.rank != null}
        <span class="pinned-mark" title="Pinned until merged or archived" aria-label="Pinned">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m7 3 6 0-1 4 3 3v1H5v-1l3-3-1-4Z" />
            <path d="M10 11v6" />
          </svg>
        </span>
      {/if}
    </div>
    {/if}
    <div class="row-meta mono">
      {#if meta}
        {@render meta()}
      {:else}
        {@const statsDiffer = pr.additions !== pr.rawAdditions || pr.deletions !== pr.rawDeletions}
        <span class="num">#{pr.number}</span>
        <span class="sep">·</span>
        <span>{pr.repo.split("/")[1] ?? pr.repo}</span>
        {#if prefs.inboxLabels !== "off" && pr.labels?.length}
          <span class="sep">·</span>
          <span class="labels" class:dots={prefs.inboxLabels === "dot"}>
            {#each pr.labels as label (label.name)}
              {#if prefs.inboxLabels === "dot"}
                <span class="label-dot" style:--label-color={label.color ? `#${label.color}` : null} title={label.name} role="img" aria-label={label.name}></span>
              {:else}
                <span class="label-name" style:--label-color={label.color ? `#${label.color}` : null}>{label.name}</span>
              {/if}
            {/each}
          </span>
        {/if}
        <span class="sep">·</span>
        <span class="branch">{pr.baseRef} <span class="arrow">←</span> {pr.headRef}</span>
        {#if pr.localBranch === pr.headRef}
          <CurrentBranchBadge label="checked out" />
        {/if}
        <span class="sep">·</span>
        <span class="add" title={statsDiffer ? `+${pr.rawAdditions} including tests` : undefined}>+{pr.additions}</span>
        <span class="del" title={statsDiffer ? `−${pr.rawDeletions} including tests` : undefined}>−{pr.deletions}</span>
        {#if pr.unresolvedCount > 0}
          <span class="sep">·</span>
          <span class="threads">{pr.unresolvedCount} unresolved</span>
        {/if}
      {/if}
    </div>
  </div>
  {#if pr.reviewScore != null}
    {@const fromGreptile = pr.reviewScore === pr.greptileConfidence}
    <span
      class="greptile"
      class:stale={(fromGreptile && pr.greptileStatus === "stale") || (!fromGreptile && pr.reviewScoreStale)}
      class:addressed={fromGreptile && pr.greptileStatus === "addressed"}
      title={fromGreptile ? greptileTitle(pr.greptileStatus) : pr.reviewScoreStale ? "lowest reviewer score — reviewed before recent pushes, may be out of date" : "lowest reviewer score"}
    >
      {pr.reviewScore}/5
    </span>
  {/if}
  {#if keys}<span class="row-keys">{@render keys()}</span>{/if}
  {@render media?.(pr)}
  <span class="row-age mono" title={ageTitle}>{relativeTime(age ?? pr.updatedAt)}</span>
</svelte:element>

<style>
  .archived-row {
    opacity: 0.5;
  }
  .archived-row.selected {
    opacity: 0.8;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 11px 12px 11px 10px;
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    border-left: 2px solid transparent;
  }
  .row.stack-child {
    margin-left: 26px;
  }
  .stack-glyph {
    flex: none;
    color: var(--text-faint);
    align-self: center;
    user-select: none;
  }
  .row .stack-glyph {
    width: 14px;
    margin-left: -8px;
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row.drop-before {
    box-shadow: inset 0 2px 0 var(--link);
  }
  .row.drop-after {
    box-shadow: inset 0 -2px 0 var(--link);
  }
  .row.selected {
    background: var(--panel-raised);
    border-left-color: var(--review);
  }
  .row.fail.selected {
    border-left-color: var(--fail);
  }
  .row.ready.selected {
    border-left-color: var(--ready);
  }
  .row.wait.selected {
    border-left-color: var(--wait);
  }
  .row.merged.selected {
    border-left-color: var(--merged);
  }
  .row.closed.selected {
    border-left-color: var(--closed);
  }
  .row.multi-selected {
    background: var(--link-bg);
  }
  .row-avatar {
    position: relative;
    flex: none;
    display: flex;
    margin-top: 1px;
  }
  .row-badge {
    flex: none;
    margin-top: 1px;
    min-width: 74px;
    justify-content: center;
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: 14.5px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
  }
  /* global: a `meta` snippet is written in the caller's scope */
  .row-meta :global(.num) {
    color: var(--text-dim);
  }
  .row-meta :global(.sep) {
    color: var(--meta-sep);
  }
  .row-meta .branch {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-meta .arrow {
    color: var(--text-faint);
  }
  .row-meta .labels {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
    --label-color: var(--text-faint);
  }
  .row-meta .labels.dots {
    gap: 3px;
    flex-shrink: 0;
  }
  .row-meta .label-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--label-color);
    flex-shrink: 0;
  }
  .row-meta .label-name {
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--label-color) 55%, transparent);
    background: color-mix(in srgb, var(--label-color) 22%, transparent);
    color: var(--text-dim);
    line-height: 14px;
    flex-shrink: 0;
  }
  .row-meta .add {
    color: var(--ready);
  }
  .row-meta .del {
    color: var(--fail);
  }
  .row-meta .threads {
    color: var(--review);
  }
  .greptile {
    flex: none;
    margin-top: 1px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .greptile.stale {
    color: var(--text-faint);
    opacity: 0.6;
  }
  .greptile.addressed {
    color: var(--ready);
    border-color: var(--ready);
    opacity: 0.85;
  }
  .row-age {
    flex: none;
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 2px;
  }
  /* Key hints get reserved space left of the media, so selecting a row never moves its deck or age. */
  .row-keys {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    width: 56px;
  }
  .row {
    position: relative;
    gap: 13px;
    min-height: 62px;
    padding: 12px 14px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    border-radius: 0;
    transition: none;
  }
  .row.stack-child {
    margin-left: 26px;
    border-left: 1px solid var(--border-soft);
  }
  @media (hover: hover) and (pointer: fine) {
    .row:hover {
      border-color: var(--border-soft);
      background: var(--surface);
    }
  }
  .row.selected {
    border-color: var(--border-soft);
    background: color-mix(in srgb, var(--link-bg) 48%, var(--panel));
    box-shadow: none;
  }
  .row.selected::before {
    content: "";
    position: absolute;
    top: 10px;
    bottom: 10px;
    left: 0;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: var(--review);
  }
  .row.fail.selected::before { background: var(--fail); }
  .row.ready.selected::before { background: var(--ready); }
  .row.wait.selected::before { background: var(--wait); }
  .row.merged.selected::before { background: var(--merged); }
  .row.closed.selected::before { background: var(--closed); }
  /* Keep the dot centered on the avatar even when row metadata wraps. */
  .description-dot {
    position: absolute;
    top: 50%;
    left: -8px;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    background: var(--native-blue);
  }
  .row.multi-selected {
    border-color: var(--border-soft);
    background: var(--link-bg);
  }
  .row-badge {
    min-width: 78px;
    margin-top: 2px;
  }
  .row-title {
    font-size: 14.5px;
    font-weight: 620;
    letter-spacing: -0.014em;
  }
  .row-meta {
    margin-top: 4px;
    font-size: 11px;
    letter-spacing: -0.01em;
  }
  .greptile {
    border-color: var(--border);
    border-radius: 999px;
    padding: 2px 8px;
  }
  @media (max-width: 720px) {
    .row-badge-slot {
      display: none;
    }
    .row-meta .branch,
    .row-meta .branch + .sep {
      display: none;
    }
  }
  .row {
    min-height: 60px;
    padding: 10px 12px;
    border-bottom-color: var(--border-soft);
  }
  .row-title {
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: 0;
  }
  .row-meta {
    margin-top: 2px;
    font-size: 12px;
    line-height: 16px;
    letter-spacing: 0;
  }
  .row.selected {
    background: var(--link-bg);
  }
  .row.selected::before {
    top: 0;
    bottom: 0;
    width: 2px;
    border-radius: 0;
    background: var(--link);
  }
  .row-badge {
    min-width: 0;
    margin-top: 0;
    justify-content: flex-start;
  }
  .row-badge-slot {
    display: flex;
    flex: 0 0 88px;
    align-items: flex-start;
    margin-top: 2px;
  }
  .greptile {
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: none;
  }

  .row-title {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .row-draft {
    flex: none;
  }
  .row-title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pinned-mark {
    display: inline-flex;
    width: 16px;
    height: 16px;
    flex: none;
    align-items: center;
    justify-content: center;
    color: var(--link);
  }
  .pinned-mark svg {
    width: 14px;
    height: 14px;
  }

  /* Phone: rows stack instead of holding desktop columns, and keyboard
     affordances give way to touch targets. */
  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      min-height: 0;
      column-gap: 10px;
      row-gap: 6px;
      padding: 12px 6px;
    }
    .row.stack-child {
      margin-left: 14px;
    }
    .stack-glyph {
      display: none;
    }
    .row-avatar {
      grid-column: 1;
      grid-row: 1 / span 2;
      margin-top: 2px;
    }
    .description-dot {
      left: -2px;
    }
    .row-main {
      grid-column: 2;
      grid-row: 1;
    }
    .row-age {
      grid-column: 3;
      grid-row: 1;
      margin-top: 2px;
    }
    .row-badge-slot {
      grid-column: 2;
      grid-row: 2;
      flex: none;
      margin-top: 0;
    }
    .greptile {
      grid-column: 3;
      grid-row: 2;
      justify-self: end;
      margin-top: 0;
    }
    .row :global(.kbd) {
      display: none;
    }
    .row-title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      white-space: normal;
      overflow: hidden;
    }
    .row-title-text {
      display: contents;
      white-space: normal;
    }
    .pinned-mark {
      display: none;
    }
    .row-meta {
      flex-wrap: wrap;
      white-space: normal;
      row-gap: 2px;
    }
    /* line counts lose to identity and blockers when the meta line has to fit
       a phone */
    .row-meta .add,
    .row-meta .del,
    .row-meta .del + .sep,
    .row-meta .sep:has(+ .add) {
      display: none;
    }
  }
</style>
