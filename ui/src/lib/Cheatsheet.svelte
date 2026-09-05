<script>
  import Kbd from "./Kbd.svelte";
  import { isTypingTarget } from "./dom.js";
  import { prefs } from "./prefs.svelte.js";
  import { PAGE_NAVIGATION } from "./navigationShortcuts.js";

  let open = $state(false);

  let agentItems = $derived(
    prefs.agents
      .filter((a) => a.trigger === "keybind" && a.enabled && a.keybind)
      .map((a) => {
        if (a.id === "fixer") return { key: a.keybind, label: "auto-merge" };
        if (a.id === "autofix") return { key: a.keybind, label: "auto-fix" };
        if (a.id === "rescorer") return { key: a.keybind, label: "re-score review" };
        return { key: a.keybind, label: a.name || "custom agent" };
      }),
  );

  const GROUPS = [
    {
      title: "Navigation",
      items: [
        { key: "⌘K", label: "jump to PR" },
        ...PAGE_NAVIGATION.map((item) => ({
          key: item.keyLabel,
          label: item.title.replace("Go to ", "").toLowerCase(),
        })),
        { key: "⌘N", label: "new window" },
        { key: "⇧⏎ / ⌘⏎", label: "jump list: new window / github" },
        { key: "/", label: "search / filter" },
        { key: "⇧H / ⇧L", label: "back / forward" },
        { key: "⌘+ / ⌘- / ⌘0", label: "zoom in / out / reset" },
        { key: "j / k", label: "move" },
        { key: "⇧J / ⇧K", label: "next / previous file or PR" },
        { key: "gg / G", label: "top / bottom" },
        { key: "1-9", label: "saved view" },
        { key: "esc", label: "back / close" },
      ],
    },
    {
      title: "PR actions",
      items: [
        { key: "⏎", label: "open PR" },
        { key: "d", label: "toggle files / conversation" },
        { key: "⌘1 / ⌘2 / ⌘3", label: "conversation / files / agents" },
        { key: "c", label: "comment / changes range" },
        { key: "r", label: "reply" },
        { key: "e", label: "inline editor / archive" },
        { key: "⇧E", label: "external editor" },
        { key: "v", label: "review" },
        { key: "s", label: "assign / pin from inbox" },
        { key: "q", label: "request review" },
        { key: "p", label: "prompt agent" },
        { key: "m", label: "merge" },
        { key: "⇧M", label: "force merge" },
        { key: "⇧C", label: "close PR" },
        { key: "u", label: "update branch" },
        { key: "x", label: "close / tests" },
        { key: "h", label: "file history" },
        { key: "o", label: "open on github" },
        { key: "t", label: "switch branch" },
        { key: "z", label: "undo archive" },
        { key: "⌘⌥C", label: "copy GitHub PR URL" },
        { key: "⌘⇧C", label: "copy PR Cockpit link (PR page)" },
      ],
    },
    {
      title: "Views",
      items: [
        { key: "A", label: "archived" },
        { key: "Tab", label: "cycle open / all PRs / recently merged" },
        { key: "⌘F", label: "filter" },
      ],
    },
  ];

  $effect(() => {
    function onKey(e) {
      if (!open) {
        if (e.key === "?" && !isTypingTarget(e.target)) {
          open = true;
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Escape" || e.key === "?") {
        open = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
</script>

{#if open}
  <div class="scrim" onmousedown={() => (open = false)}>
    <div class="sheet" onmousedown={(e) => e.stopPropagation()}>
      <div class="sheet-head">
        <span>Shortcuts</span>
        <span class="sheet-hint"><Kbd keys="esc" /></span>
      </div>
      <div class="sheet-body">
        {#each GROUPS as group}
          <div class="sheet-group">
            <div class="sheet-group-title">{group.title}</div>
            {#each group.title === "PR actions" ? [...group.items, ...agentItems] : group.items as item}
              <div class="sheet-row">
                <span class="sheet-shortcut"><Kbd keys={item.key} /></span>
                <span class="sheet-label">{item.label}</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(4, 6, 9, 0.6);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 10vh;
    z-index: 60;
  }
  .sheet {
    width: 100%;
    max-width: 720px;
    max-height: 76vh;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .sheet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text);
  }
  .sheet-hint {
    font-size: 11px;
    color: var(--text-faint);
  }
  .sheet-body {
    overflow-y: auto;
    padding: 14px 18px 20px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 20px 28px;
  }
  .sheet-group-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 8px;
  }
  .sheet-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
  }
  .sheet-shortcut {
    display: inline-flex;
    min-width: 86px;
  }
  .sheet-label {
    font-size: 12.5px;
    color: var(--text-faint);
  }

  .scrim {
    background: color-mix(in srgb, var(--text) 22%, transparent);
    backdrop-filter: blur(4px);
  }
  .sheet {
    background: var(--panel);
    border-color: var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow-dialog);
  }
  .sheet-head {
    padding: 16px 18px;
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-weight: 600;
  }
  .sheet-body {
    padding: 18px;
  }
  .sheet-group-title {
    font-family: var(--sans);
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--text-dim);
  }
  .sheet-label {
    color: var(--text-dim);
  }
</style>
