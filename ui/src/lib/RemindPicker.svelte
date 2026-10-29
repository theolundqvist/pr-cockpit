<script>
  import { onMount, tick } from "svelte";

  let { anchor, onSelect, onClose } = $props();
  const id = $props.id();
  let panel;
  let input;
  let query = $state("");
  let activeIndex = $state(0);
  let dateModule = $state(null);
  let finished = false;
  let suggestions = $derived(dateModule?.nlQueryToDateSuggestions(query) ?? []);
  let activeOption = $derived(suggestions[activeIndex] ? `${id}-option-${activeIndex}` : undefined);

  function close() {
    if (finished) return;
    finished = true;
    onClose();
  }

  function choose(suggestion) {
    if (finished || !suggestion) return;
    if (onSelect(suggestion.date.getTime()) !== false) finished = true;
  }

  function positionPanel() {
    if (!panel?.matches(":popover-open")) return;
    const scale = Number.parseFloat(getComputedStyle(panel.closest("#app")).zoom) || 1;
    panel.style.maxWidth = `${(window.innerWidth - 16) / scale}px`;
    panel.style.maxHeight = `${(window.innerHeight - 16) / scale}px`;
    const target = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(target.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(target.bottom + 6, window.innerHeight - rect.height - 8));
    panel.style.left = `${(Number.parseFloat(panel.style.left) || 0) + (left - rect.left) / scale}px`;
    panel.style.top = `${(Number.parseFloat(panel.style.top) || 0) + (top - rect.top) / scale}px`;
  }

  function onKey(event) {
    event.stopImmediatePropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(suggestions[activeIndex]);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      activeIndex = event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, suggestions.length - 1) : Math.max(0, Math.min(suggestions.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
      if (activeOption) panel.querySelector(`#${CSS.escape(activeOption)}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Tab") {
      event.preventDefault();
      input.focus();
    }
  }

  onMount(() => {
    const capture = (event) => event.stopImmediatePropagation();
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keypress", capture, { capture: true });
    window.addEventListener("keyup", capture, { capture: true });
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, { capture: true });
    const observer = new ResizeObserver(positionPanel);
    observer.observe(panel);
    panel.showPopover();
    positionPanel();
    input.focus({ preventScroll: true });
    void import("./reminderDate.ts").then(async (module) => {
      if (finished) return;
      dateModule = module;
      await tick();
      if (!finished) positionPanel();
    });
    return () => {
      finished = true;
      observer.disconnect();
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keypress", capture, { capture: true });
      window.removeEventListener("keyup", capture, { capture: true });
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, { capture: true });
    };
  });
</script>

<div bind:this={panel} class="remind-picker" popover="auto" role="dialog" data-prompt-dialog aria-labelledby={`${id}-title`} onbeforetoggle={(event) => { if (event.newState === "closed") close(); }}>
  <header>
    <h2 id={`${id}-title`}>Remind me</h2>
    <button class="close" type="button" tabindex="-1" aria-label="Close reminder picker" onpointerdown={(event) => event.preventDefault()} onclick={close}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
  </header>
  <div class="search-wrap">
    <input bind:this={input} bind:value={query} oninput={() => (activeIndex = 0)} role="combobox" aria-label="Set Reminder" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-options`} aria-activedescendant={activeOption} placeholder="Set Reminder" autocomplete="off" spellcheck="false" />
  </div>
  <div class="options" id={`${id}-options`} role="listbox" aria-label="Reminder dates">
    {#each suggestions as suggestion, index}
      <button id={`${id}-option-${index}`} class="option" class:active={index === activeIndex} type="button" role="option" aria-selected={index === activeIndex} tabindex="-1" onpointermove={() => (activeIndex = index)} onpointerdown={(event) => event.preventDefault()} onclick={() => choose(suggestion)}>
        <span class="label">{suggestion.label}</span>
        <time datetime={suggestion.date.toISOString()}>{dateModule.formatReminderDate(suggestion.date, suggestion.timezone)}</time>
      </button>
    {:else}
      <div class="empty" role="status">{dateModule ? 'Try "tomorrow" or "next week"' : "Loading dates…"}</div>
    {/each}
  </div>
</div>

<style>
  .remind-picker { position: fixed; inset: 0 auto auto 0; margin: 0; padding: 0; width: 420px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-raised); color: var(--text); box-shadow: var(--shadow-dialog); font-family: var(--sans); overflow: hidden; }
  .remind-picker:popover-open { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 16px 12px; }
  h2 { margin: 0; font-size: 15px; font-weight: 650; }
  .close { display: grid; place-items: center; padding: 4px; border: 0; border-radius: 6px; background: transparent; color: var(--text-dim); cursor: pointer; }
  .close svg { width: 16px; height: 16px; }
  .close:hover { background: var(--surface-hover); }
  .search-wrap { flex: none; padding: 0 12px 8px; }
  input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px; outline: none; background: var(--panel); color: var(--text); font: 13px var(--sans); }
  input:focus { border-color: var(--link); box-shadow: 0 0 0 2px var(--focus-ring); }
  input::placeholder { color: var(--text-faint); }
  .options { min-height: 0; padding: 0 6px 6px; overflow-y: auto; overscroll-behavior: contain; }
  .option { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; min-height: 38px; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: 500 12px var(--sans); text-align: left; cursor: pointer; }
  .option.active, .option:hover, .option:focus-visible { outline: none; background: var(--surface-hover); }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  time { flex: none; color: var(--text-dim); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .empty { padding: 14px 10px; color: var(--text-faint); font-size: 12px; text-align: center; }
  @media (max-width: 480px) { .option { align-items: flex-start; flex-direction: column; gap: 4px; } .label { max-width: 100%; } }
</style>
