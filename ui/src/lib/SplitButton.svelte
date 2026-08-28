<script>
  import Kbd from "./Kbd.svelte";

  let {
    tone = "green",
    open = false,
    mainDisabled = false,
    caretDisabled = false,
    optionsLabel,
    onMain,
    onToggle,
    main,
    menu,
  } = $props();
</script>

<div class="split-button {tone}" data-split-action>
  <button class="split-main" type="button" disabled={mainDisabled} onclick={onMain}>
    {@render main()}
  </button>
  <button
    class="split-caret"
    class:open
    type="button"
    disabled={caretDisabled}
    aria-label={optionsLabel}
    aria-expanded={open}
    aria-haspopup="menu"
    onclick={onToggle}
  >
    {#if open}<Kbd keys="esc" />{/if}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
  </button>
  {#if open}{@render menu()}{/if}
</div>

<style>
  .split-button {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
  }
  button {
    min-height: 32px;
    border: 0;
    background: var(--wait);
    color: var(--on-brand);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .green button {
    background: light-dark(#1f883d, #238636);
  }
  .red button {
    background: var(--fail);
  }
  .blocked button {
    background: var(--fail-bg);
    color: var(--fail);
  }
  .split-main {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding-inline: 13px;
    border-radius: 999px 0 0 999px;
  }
  .split-caret {
    display: flex;
    width: 34px;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 6px;
    border-left: 1px solid color-mix(in srgb, #fff 24%, transparent);
    border-radius: 0 999px 999px 0;
  }
  .split-caret.open {
    width: auto;
  }
  svg {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  button:disabled {
    background: var(--disabled-bg);
    color: var(--disabled-fg);
    cursor: default;
  }
  .green button:disabled {
    background: color-mix(in srgb, light-dark(#1f883d, #238636) 38%, var(--bg));
    color: var(--on-brand);
  }
  @media (hover: hover) and (pointer: fine) {
    button:hover:not(:disabled) {
      filter: brightness(1.1);
    }
    .green button:hover:not(:disabled) {
      background: light-dark(#1a7f37, #2ea043);
      filter: none;
    }
    .blocked button:hover:not(:disabled) {
      background: color-mix(in srgb, var(--fail-bg) 72%, var(--fail) 12%);
      filter: none;
    }
  }
  button:active:not(:disabled) {
    transform: scale(0.99);
  }
</style>
