<script>
  let { reactions } = $props();

  const EMOJI = {
    THUMBS_UP: "👍",
    THUMBS_DOWN: "👎",
    LAUGH: "😄",
    HOORAY: "🎉",
    CONFUSED: "😕",
    HEART: "❤️",
    ROCKET: "🚀",
    EYES: "👀",
  };
</script>

{#if reactions?.length}
  <div class="reactions">
    {#each reactions as r (r.content)}
      <span class="pill" class:mine={r.viewerReacted} title={r.content.toLowerCase().replace(/_/g, " ")}>
        <span class="emoji">{EMOJI[r.content] ?? "❓"}</span>
        <span class="count">{r.count}</span>
      </span>
    {/each}
  </div>
{/if}

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 9px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--panel-raised);
  }
  .pill.mine {
    border-color: var(--link);
    background: var(--link-bg);
  }
  .emoji {
    font-size: 12.5px;
  }
  .count {
    font-family: var(--sans);
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .pill.mine .count {
    color: var(--text);
  }
</style>
