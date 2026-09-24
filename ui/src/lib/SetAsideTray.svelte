<script>
  import { tick } from "svelte";
  import { setAside, bringBack, bringBackAll, syncSetAside } from "./setAside.svelte.js";
  import { isTypingTarget } from "./dom.js";
  import { isRecordingShortcut } from "./shortcutCapture.js";
  import Kbd from "./Kbd.svelte";

  let panel = $state();
  let trigger = $state();
  let returnFocus;
  let openedAtHash;

  function close(restoreFocus = true) {
    panel?.hidePopover();
    setAside.open = false;
    if (restoreFocus) tick().then(() => {
      const target = trigger?.isConnected ? trigger : returnFocus?.isConnected ? returnFocus : document.querySelector(".inbox .row.selected, .inbox .row");
      target?.focus();
    });
  }

  async function toggle() {
    if (panel?.matches(":popover-open")) return close();
    returnFocus = document.activeElement;
    openedAtHash = location.hash;
    panel?.showPopover();
    setAside.open = true;
    await tick();
    panel?.querySelector(".pr-link")?.focus();
  }

  async function restore(pr, index) {
    if (!bringBack(pr)) return;
    if (!setAside.items.length) return close();
    await tick();
    const buttons = panel.querySelectorAll(".restore");
    buttons[Math.min(index, buttons.length - 1)]?.focus();
  }

  function restoreAll() {
    if (bringBackAll()) close();
  }

  $effect(() => {
    if (!setAside.items.length && setAside.open) close();
  });

  $effect(() => {
    function onKey(event) {
      if (event.defaultPrevented || isRecordingShortcut()) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g" && !isTypingTarget(event.target) && setAside.items.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggle();
        return;
      }
      if (!setAside.open) return;
      // The tray owns keys while open; letters must not act on the PR underneath.
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const links = [...panel.querySelectorAll(".pr-link")];
        const current = links.indexOf(document.activeElement.closest(".aside-row")?.querySelector(".pr-link"));
        const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : Math.max(0, Math.min(links.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        links[next]?.focus();
      } else if (event.key === "Tab") {
        // Keep keyboard navigation in this small dialog until explicitly dismissed.
        const controls = [...panel.querySelectorAll("a, button")];
        const index = controls.indexOf(document.activeElement);
        if (event.shiftKey && index <= 0) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (!event.shiftKey && index === controls.length - 1) {
          event.preventDefault();
          controls[0]?.focus();
        }
      } else if (!isTypingTarget(event.target) && event.key.length === 1 && !(event.key === " " && event.target.closest("button"))) event.preventDefault();
    }
    // A queued hashchange may arrive after the user has already opened the tray
    // on the new page. Only dismiss for a navigation after opening.
    const onHash = () => { if (location.hash !== openedAtHash) close(false); };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("storage", syncSetAside);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("storage", syncSetAside);
      window.removeEventListener("hashchange", onHash);
    };
  });
</script>

{#snippet asideIcon()}
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M5 5h14v14H5zM5 13h4l2 3h2l2-3h4M9 9h6" />
  </svg>
{/snippet}

{#if setAside.items.length}
  <button bind:this={trigger} class="aside-pill" class:expanded={setAside.open} type="button" onclick={toggle} aria-expanded={setAside.open} aria-controls="set-aside-tray" aria-haspopup="dialog" title="Open set-aside PRs (⌘G / Ctrl+G)">
    {@render asideIcon()}
    <span><strong>{setAside.items.length}</strong> {setAside.items.length === 1 ? "PR" : "PRs"} set aside</span>
    <svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d={setAside.open ? "m4 6 4 4 4-4" : "m4 10 4-4 4 4"} /></svg>
  </button>
{/if}

<div bind:this={panel} id="set-aside-tray" class="aside-tray" popover="auto" role="dialog" aria-labelledby="set-aside-title" onbeforetoggle={(event) => (setAside.open = event.newState === "open")}>
  <header>
    <div><h2 id="set-aside-title">Set aside <span>{setAside.items.length}</span></h2><p>Out of your way. Here when you’re ready.</p></div>
    <button class="close" type="button" aria-label="Close set aside" onclick={() => close()}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>
  </header>
  <div class="aside-list">
    {#each setAside.items as pr, index (`${pr.repo}#${pr.number}`)}
      <div class="aside-row">
        <a class="pr-link" href={`#/pr/${pr.repo}/${pr.number}`} onclick={() => close(false)}>
          <span class="pr-mark">{@render asideIcon()}</span>
          <span class="pr-copy"><span class="pr-title" title={pr.title}>{pr.title}</span><span class="pr-meta">{pr.repo} <span>#{pr.number}</span></span></span>
        </a>
        <button class="restore" type="button" aria-label={`Bring back ${pr.title}`} title="Bring back to the main view" onclick={() => restore(pr, index)}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5-4 4 4 4M4 9h8a4 4 0 0 1 0 8" /></svg>
          <span>Bring back</span>
        </button>
      </div>
    {/each}
  </div>
  <footer><span><Kbd keys="esc" /> close</span><button type="button" onclick={restoreAll}>Bring back all</button></footer>
</div>

<style>
  .aside-pill { position: fixed; bottom: calc(var(--keybar-height, 38px) + 18px); left: 18px; z-index: 35; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px; border: 1px solid var(--border); border-radius: 24px; background: var(--panel); color: var(--text); box-shadow: 0 4px 18px #00000016; font: 13px var(--sans); cursor: pointer; }
  .aside-pill strong { font-weight: 650; font-variant-numeric: tabular-nums; }
  svg { width: 20px; height: 20px; flex: none; }
  .chevron { width: 14px; height: 14px; color: var(--text-dim); }
  button:hover, .aside-pill.expanded { background: var(--surface); }
  button:active { transform: scale(.98); }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--link); outline-offset: -3px; }
  .aside-tray { position: fixed; inset: auto auto calc(var(--keybar-height, 38px) + 74px) 18px; margin: 0; padding: 0; width: min(500px, calc(100vw - 36px)); max-height: min(620px, calc(100dvh - 150px)); border: 1px solid var(--border); border-radius: 16px; background: var(--panel); color: var(--text); box-shadow: var(--shadow-dialog); font-family: var(--sans); overflow: hidden; }
  .aside-tray:popover-open { display: flex; flex-direction: column; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 20px 16px; }
  h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 650; }
  h2 span { padding: 2px 6px; background: var(--surface); border-radius: 6px; font-size: 11px; color: var(--text-dim); }
  p { margin: 7px 0 0; font-size: 12px; color: var(--text-dim); }
  .close { display: grid; place-items: center; border: 0; border-radius: 6px; padding: 4px; color: var(--text-dim); background: transparent; cursor: pointer; }
  .close svg { width: 16px; height: 16px; }
  .aside-list { overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 8px; }
  .aside-row { display: flex; align-items: center; border-radius: 9px; }
  .aside-row:hover, .aside-row:focus-within { background: var(--surface); }
  .pr-link { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; padding: 13px 10px; border-radius: 9px; color: inherit; text-decoration: none; }
  .pr-mark { display: flex; color: var(--text-faint); }
  .pr-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .pr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
  .pr-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 11px; }
  .pr-meta span { color: var(--text-faint); margin-left: 5px; }
  .restore { display: flex; align-items: center; gap: 4px; flex: none; margin-right: 8px; padding: 7px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); color: var(--text-dim); font: 11px var(--sans); cursor: pointer; }
  .restore svg { width: 15px; height: 15px; }
  footer { display: flex; justify-content: space-between; align-items: center; padding: 12px 18px; border-top: 1px solid var(--border); }
  footer > span { display: flex; gap: 6px; align-items: center; color: var(--text-faint); font-size: 11px; }
  footer button { border: 0; background: transparent; border-radius: 6px; padding: 5px 7px; color: var(--text-dim); font: 12px var(--sans); cursor: pointer; }
  @media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
    .aside-pill { bottom: calc(74px + env(safe-area-inset-bottom)); left: 12px; }
    .aside-tray { left: 12px; bottom: calc(130px + env(safe-area-inset-bottom)); width: calc(100vw - 24px); max-height: calc(100dvh - 160px - env(safe-area-inset-bottom)); }
    .restore span { display: none; }
    .restore { min-width: 36px; min-height: 36px; justify-content: center; }
  }
</style>
