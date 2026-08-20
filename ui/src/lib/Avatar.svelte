<script>
  let { login, url, size = 18 } = $props();
  let failed = $state(false);
</script>

{#if url && !failed}
  <img
    class="avatar"
    src={url}
    alt={login ?? ""}
    style="width: {size}px; height: {size}px"
    onerror={() => (failed = true)}
  />
{:else}
  <span class="avatar fallback" style="width: {size}px; height: {size}px; font-size: {size * 0.5}px">
    {(login ?? "?").charAt(0).toUpperCase()}
  </span>
{/if}

<style>
  .avatar {
    flex: none;
    border-radius: 50%;
    object-fit: cover;
    background: var(--panel-raised);
  }
  .fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-weight: 600;
    text-transform: uppercase;
  }
</style>
