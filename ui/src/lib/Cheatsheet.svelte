<script>
  import { isTypingTarget } from "./dom.js";
  import { prefs } from "./prefs.svelte.js";

  let open = $state(false);

  let agentItems = $derived(
    prefs.agents
      .filter((a) => a.trigger === "keybind" && a.enabled && a.keybind)
      .map((a) => {
        if (a.id === "fixer") return { key: a.keybind, label: "auto-merge" };
        if (a.id === "autofix") return { key: a.keybind, label: "auto-fix (or bulk auto-fix a selected range, from inbox)" };
        if (a.id === "rescorer") return { key: a.keybind, label: "re-score Greptile review" };
        return { key: a.keybind, label: `${a.name || "custom agent"} (custom agent)` };
      }),
  );

  const GROUPS = [
    {
      title: "Navigation",
      items: [
        { key: "⌘K", label: "jump to PR" },
        { key: "/", label: "search / filter" },
        { key: "⇧H / ⇧L", label: "back / forward" },
        { key: "⌘,", label: "settings" },
        { key: "⌘+ / ⌘- / ⌘0", label: "zoom in / out / reset" },
        { key: "j / k", label: "move selection / scroll" },
        { key: "⇧J / ⇧K", label: "next / prev file (files tab) · select range (inbox)" },
        { key: "gg / G", label: "jump to top / bottom" },
        { key: "1-9", label: "apply saved view" },
        { key: "esc", label: "back / close" },
      ],
    },
    {
      title: "PR actions",
      items: [
        { key: "⏎", label: "open PR" },
        { key: "d", label: "toggle files / conversation" },
        { key: "⌘1 / ⌘2 / ⌘3", label: "switch tab: conversation / files / agents" },
        { key: "c", label: "comment (conversation) / changes range (files tab)" },
        { key: "r", label: "reply" },
        { key: "e", label: "open editor (or archive, from inbox)" },
        { key: "⇧E", label: "edit description (conversation tab)" },
        { key: "v", label: "review" },
        { key: "s", label: "assign" },
        { key: "q", label: "request review" },
        { key: "p", label: "prompt agent" },
        { key: "m", label: "merge" },
        { key: "⇧M", label: "force merge" },
        { key: "⇧C", label: "close PR" },
        { key: "u", label: "update branch" },
        { key: "x", label: "close PR · toggle tests (files tab)" },
        { key: "h", label: "file history on base branch (files tab)" },
        { key: "o", label: "open on github" },
        { key: "⇧T", label: "focus terminal" },
        { key: "z", label: "undo archive" },
        { key: "⌘⌥C", label: "copy GitHub PR URL" },
        { key: "⌘⇧C", label: "copy PR Cockpit link (PR page)" },
      ],
    },
    {
      title: "Views",
      items: [
        { key: "A", label: "toggle archived (list view)" },
        { key: "C", label: "recently merged/closed (list view)" },
        { key: "⌘F", label: "open filter" },
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
    <div class="sheet mono" onmousedown={(e) => e.stopPropagation()}>
      <div class="sheet-head">
        <span>Keyboard shortcuts</span>
        <span class="sheet-hint">esc to close</span>
      </div>
      <div class="sheet-body">
        {#each GROUPS as group}
          <div class="sheet-group">
            <div class="sheet-group-title">{group.title}</div>
            {#each group.title === "PR actions" ? [...group.items, ...agentItems] : group.items as item}
              <div class="sheet-row">
                <kbd>{item.key}</kbd>
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
  .sheet-row kbd {
    flex: none;
    min-width: 40px;
    text-align: center;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 1px 6px;
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
  .sheet-row kbd {
    color: var(--text-dim);
    background: var(--surface);
    border-color: var(--border);
    border-bottom-width: 1px;
    border-radius: 5px;
    box-shadow: var(--shadow-xs);
  }
  .sheet-label {
    color: var(--text-dim);
  }
</style>
