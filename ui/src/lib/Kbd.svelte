<script>
  let { keys, label = null } = $props();

  const GLYPHS = {
    cmd: "⌘",
    command: "⌘",
    "⌘": "⌘",
    shift: "⇧",
    "⇧": "⇧",
    alt: "⌥",
    option: "⌥",
    "⌥": "⌥",
    ctrl: "⌃",
    control: "⌃",
    "⌃": "⌃",
    enter: "↩",
    return: "↩",
    esc: "Esc",
    escape: "Esc",
    backspace: "⌫",
    delete: "⌫",
    left: "←",
    right: "→",
    up: "↑",
    down: "↓",
  };

  const LABELS = {
    "⌘": "Command",
    "⇧": "Shift",
    "⌥": "Option",
    "⌃": "Control",
    "↩": "Enter",
    "⌫": "Delete",
    "←": "Left arrow",
    "→": "Right arrow",
    "↑": "Up arrow",
    "↓": "Down arrow",
    Esc: "Escape",
  };

  function keyPart(value) {
    const raw = String(value).trim();
    const normalized = raw.toLowerCase();
    const glyph = GLYPHS[normalized] ?? GLYPHS[raw] ?? (raw.length === 1 ? raw.toUpperCase() : raw);
    return { type: "key", glyph, label: LABELS[glyph] ?? glyph };
  }

  function parseKeys(value) {
    if (Array.isArray(value)) return value.flatMap((key, index) => index ? [{ type: "gap" }, keyPart(key)] : [keyPart(key)]);

    const text = String(value ?? "").trim();
    if (!text) return [];

    if (text.includes(" / ")) {
      return text.split(/\s+\/\s+/).flatMap((part, index) => [
        ...(index ? [{ type: "separator", glyph: "/" }] : []),
        ...parseKeys(part),
      ]);
    }
    if (text.includes("+")) return text.split("+").flatMap((part) => parseKeys(part));

    const compact = [...text];
    if (compact.length > 1 && compact.some((char) => "⌘⇧⌥⌃↑↓←→".includes(char))) {
      return compact.map(keyPart);
    }

    return [keyPart(text)];
  }

  let parts = $derived(parseKeys(keys));
  let accessibleLabel = $derived(label ?? parts.filter((part) => part.type === "key").map((part) => part.label).join(" "));
</script>

<kbd class="kbd" aria-label={accessibleLabel}>
  {#each parts as part, index (index)}
    {#if part.type === "key"}
      <span class="keycap" aria-hidden="true">{part.glyph}</span>
    {:else if part.type === "separator"}
      <span class="separator" aria-hidden="true">{part.glyph}</span>
    {/if}
  {/each}
</kbd>

<style>
  .kbd {
    display: inline-flex;
    width: auto;
    min-width: 0;
    height: auto;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .keycap {
    display: inline-flex;
    min-width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--surface-hover) 50%, transparent);
    color: color-mix(in srgb, var(--text-dim) 80%, transparent);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }
  .separator {
    color: var(--text-faint);
    font-family: var(--sans);
    font-size: 11px;
    line-height: 20px;
  }
</style>
