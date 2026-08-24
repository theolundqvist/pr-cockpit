<script>
  import Avatar from "./Avatar.svelte";

  let { title, users, current, onPick, onClose } = $props();

  let query = $state("");
  let index = $state(0);
  let inputEl = $state(null);

  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = q ? users.filter((u) => u.login.toLowerCase().includes(q)) : users;
    return list.slice(0, 200);
  });

  $effect(() => {
    filtered;
    if (index >= filtered.length) index = Math.max(0, filtered.length - 1);
  });

  function onKey(e) {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      index = Math.min(filtered.length - 1, index + 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      index = Math.max(0, index - 1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      const pick = filtered[index];
      if (pick) onPick(pick.login);
      e.preventDefault();
    } else if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    }
  }

  function mount(node) {
    node.focus();
  }
</script>

<div class="picker-backdrop" onclick={onClose} onkeydown={null} role="presentation">
  <div class="picker" onclick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
    <div class="picker-title">{title}</div>
    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={onKey}
      use:mount
      class="picker-input"
      placeholder="Filter people…"
      spellcheck="false"
      autocomplete="off"
    />
    <div class="picker-list">
      {#if filtered.length === 0}
        <div class="picker-empty">No matches</div>
      {:else}
        {#each filtered as user, i (user.login)}
          <button
            class="picker-row"
            class:active={i === index}
            onmousemove={() => (index = i)}
            onclick={() => onPick(user.login)}
          >
            <Avatar login={user.login} url={user.avatarUrl} size={18} />
            <span class="picker-login">{user.login}</span>
            {#if current.has(user.login)}<span class="picker-added">added</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
    <div class="picker-hint"><kbd>↑↓</kbd> move · <kbd>enter</kbd> toggle · <kbd>esc</kbd> close</div>
  </div>
</div>

<style>
  .picker-backdrop {
    position: fixed;
    inset: 0;
    background: var(--overlay, rgba(0, 0, 0, 0.4));
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 40;
  }
  .picker {
    width: 100%;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .picker-title {
    padding: 10px 14px;
    font-size: 12px;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border-soft);
  }
  .picker-input {
    margin: 10px 12px 8px;
    box-sizing: border-box;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    font-size: 13px;
    padding: 8px 10px;
  }
  .picker-input:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .picker-list {
    max-height: 320px;
    overflow-y: auto;
    padding: 4px;
  }
  .picker-row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 9px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .picker-row.active {
    background: var(--panel-raised);
  }
  .picker-login {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-added {
    flex: none;
    font-size: 10.5px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .picker-empty {
    padding: 16px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .picker-hint {
    padding: 8px 14px;
    border-top: 1px solid var(--border-soft);
    font-size: 11px;
    color: var(--text-faint);
  }
  .picker-hint kbd {
    color: color-mix(in srgb, var(--text-dim) 80%, transparent);
    font-family: var(--sans);
    font-weight: 500;
  }

  .picker-backdrop {
    background: color-mix(in srgb, var(--text) 22%, transparent);
    backdrop-filter: blur(4px);
  }
  .picker {
    background: var(--panel);
    border-color: var(--border);
    border-radius: 13px;
    box-shadow: var(--shadow-dialog);
  }
  .picker-title {
    padding: 13px 14px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-weight: 600;
  }
  .picker-input {
    min-height: 34px;
    background: var(--surface);
    border-color: var(--border);
    border-radius: 8px;
  }
  .picker-input:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .picker-row {
    min-height: 36px;
    border: 1px solid transparent;
    border-radius: 8px;
  }
  .picker-row.active {
    background: var(--surface);
    border-color: var(--border);
    box-shadow: var(--shadow-xs);
  }
</style>
