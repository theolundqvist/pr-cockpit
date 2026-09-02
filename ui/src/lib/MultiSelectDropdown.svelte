<script>
  import { tick } from "svelte";
  import { fuzzyMatch } from "./fuzzy.js";
  import Kbd from "./Kbd.svelte";

  let { label, options = [], selected = [], plural, onchange, keybind = null, open = $bindable(false) } = $props();

  let root = $state(null);
  let menu = $state(null);
  let input = $state(null);
  let query = $state("");
  let activeIndex = $state(0);

  function optionValue(option) {
    return typeof option === "string" ? option : option.value;
  }

  function optionLabel(option) {
    return typeof option === "string" ? option : option.label;
  }

  let showSearch = $derived(options.length > 8);
  let selectedLabels = $derived(selected.map((value) =>
    optionLabel(options.find((option) => optionValue(option) === value) ?? value)
  ));
  let buttonLabel = $derived(
    selected.length === 0
      ? `All ${plural}`
      : selected.length === 1
        ? selectedLabels[0]
        : `${selected.length} ${plural}`,
  );
  let filteredOptions = $derived.by(() => {
    const normalized = query.trim();
    if (!normalized) return options;
    return options
      .map((option) => ({ option, match: fuzzyMatch(normalized, optionLabel(option)) }))
      .filter((entry) => entry.match)
      .sort((left, right) => right.match.score - left.match.score)
      .map((entry) => entry.option);
  });

  $effect(() => {
    query;
    activeIndex = 0;
  });

  function closeMenu(focusTrigger = true) {
    open = false;
    query = "";
    if (focusTrigger) root?.querySelector(".trigger")?.focus();
  }

  function toggleMenu() {
    if (open) closeMenu(false);
    else open = true;
  }

  $effect(() => {
    if (!open) return;
    const closeOutside = (event) => {
      if (!root?.contains(event.target)) closeMenu(false);
    };
    const closeOnEscape = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      closeMenu();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    void tick().then(() => {
      if (showSearch) input?.focus();
      else menu?.querySelector('[aria-checked="true"]')?.focus() ?? menu?.querySelector("button")?.focus();
    });
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  });

  function toggleOption(option) {
    const value = optionValue(option);
    if (selected.length === 0) {
      onchange([value]);
      return;
    }
    onchange(selected.includes(value) ? selected.filter((selectedValue) => selectedValue !== value) : [...selected, value]);
  }

  function moveFocus(event) {
    if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...menu.querySelectorAll("button")];
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
    event.preventDefault();
  }

  function onSearchKey(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = filteredOptions.length === 0
        ? 0
        : (activeIndex + direction + filteredOptions.length) % filteredOptions.length;
    } else if (event.key === "Enter") {
      const option = filteredOptions[activeIndex];
      if (option) toggleOption(option);
    } else if (event.key === "Escape") {
      if (query) {
        query = "";
        activeIndex = 0;
      } else {
        closeMenu();
      }
    } else {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
  }
</script>

<div class="multi-select" bind:this={root}>
  <span class="field-label">{label}</span>
  <button
    class="trigger"
    type="button"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggleMenu}
    onkeydown={(event) => {
      if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        open = true;
        event.preventDefault();
      }
    }}
  >
    <span class="trigger-label">{buttonLabel}</span>
    <span class="trigger-tail">
      {#if keybind}<Kbd keys={keybind} />{/if}
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg>
    </span>
  </button>

  {#if open}
    <div class="menu" role="menu" tabindex="-1" aria-label={`${label} filters`} bind:this={menu} onkeydown={moveFocus}>
      {#if showSearch}
        <div class="search-wrap">
          <input
            class="search-input"
            bind:this={input}
            bind:value={query}
            onkeydown={onSearchKey}
            placeholder={`Find ${plural}`}
            aria-label={`Search ${plural}`}
            autocomplete="off"
            spellcheck="false"
          />
          {#if selected.length > 0}<span class="selected-hint">{selected.length} selected</span>{/if}
        </div>
      {/if}
      {#if !query}
        <button class="option all" type="button" role="menuitemcheckbox" aria-checked={selected.length === 0} onclick={() => onchange([])}>
          <span class="check" aria-hidden="true">{selected.length === 0 ? "✓" : ""}</span>
          <span>All {plural}</span>
        </button>
        <div class="separator"></div>
      {/if}
      {#each filteredOptions as option, index (optionValue(option))}
        {@const value = optionValue(option)}
        <button
          type="button"
          class="option"
          class:active={showSearch && index === activeIndex}
          role="menuitemcheckbox"
          aria-checked={selected.includes(value)}
          onclick={() => toggleOption(option)}
        >
          <span class="check" aria-hidden="true">{selected.includes(value) ? "✓" : ""}</span>
          <span>{optionLabel(option)}</span>
        </button>
      {:else}
        <div class="empty">No matching {plural}</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .multi-select { position: relative; display: flex; align-items: center; gap: 6px; }
  .field-label { color: var(--text-faint); font-size: 11px; }
  .trigger { display: flex; width: 176px; height: 30px; min-width: 0; padding: 0 8px 0 10px; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--panel); font: 500 12px var(--sans); cursor: pointer; }
  .trigger:hover, .trigger[aria-expanded="true"] { border-color: var(--border-strong); background: var(--panel-raised); }
  .trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trigger-tail { display: flex; flex: none; align-items: center; gap: 6px; }
  .trigger svg { width: 14px; height: 14px; flex: none; fill: none; stroke: var(--text-faint); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
  .menu { position: absolute; z-index: 40; top: calc(100% + 6px); right: 0; width: 260px; max-height: 340px; overflow-y: auto; padding: 5px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-raised); box-shadow: var(--shadow-lg); }
  .search-wrap { display: flex; min-width: 0; padding: 2px 2px 5px; align-items: center; gap: 6px; }
  .search-input { width: 100%; min-width: 0; height: 29px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; outline: none; color: var(--text); background: var(--panel); font: 12px var(--sans); }
  .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus-ring); }
  .search-input::placeholder { color: var(--text-faint); }
  .selected-hint { flex: none; color: var(--text-faint); font: 10px var(--mono); white-space: nowrap; }
  .option { display: grid; width: 100%; min-height: 30px; padding: 5px 7px; grid-template-columns: 17px minmax(0, 1fr); align-items: center; gap: 7px; border: 0; border-radius: 5px; color: var(--text); background: transparent; font: 500 12px var(--sans); text-align: left; cursor: pointer; }
  .option:hover, .option:focus-visible, .option.active { outline: none; background: var(--surface-hover); }
  .option > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .option.all { font-weight: 600; }
  .check { display: inline-grid; width: 15px; height: 15px; place-items: center; border: 1px solid var(--border-strong); border-radius: 4px; color: var(--native-on-accent); background: transparent; font-size: 10px; line-height: 1; }
  .option[aria-checked="true"] .check { border-color: var(--accent); background: var(--accent); }
  .separator { height: 1px; margin: 4px 2px; background: var(--border); }
  .empty { padding: 10px; color: var(--text-faint); font-size: 11px; text-align: center; }
  @media (max-width: 900px) { .multi-select { flex: 1; } .trigger { width: 100%; } }
</style>
