<script>
  import { setRecordingShortcut } from "./shortcutCapture.js";
  import { capturedShortcut } from "./shortcutPlatform.js";

  let { value = "", defaultValue = "", platform = "darwin", onChange } = $props();

  let recording = $state(false);
  let flash = $state("");
  let el = $state(null);

  const display = $derived(recording ? flash || "Press a shortcut…" : value || `${defaultValue} (default)`);

  function onKeydown(e) {
    // Swallow every key while recording so in-app shortcuts (palette, find, …) can't
    // steal the combo. Capture phase + stopImmediatePropagation beats every bubble
    // handler; Palette also listens in capture, so it checks the recording flag.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      onChange("");
      recording = false;
      return;
    }
    if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      flash = "add a modifier";
      return;
    }
    onChange(capturedShortcut(e, platform));
    recording = false;
  }

  $effect(() => {
    setRecordingShortcut(recording);
    if (!recording) return;
    window.addEventListener("keydown", onKeydown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeydown, { capture: true });
      setRecordingShortcut(false);
    };
  });
</script>

<button
  bind:this={el}
  type="button"
  class="shortcut-input mono"
  class:recording
  class:unset={!value && !recording}
  onclick={() => {
    flash = "";
    recording = true;
    el?.focus();
  }}
  onblur={() => (recording = false)}
>{display}</button>

<style>
  .shortcut-input {
    width: 220px;
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 13px;
    padding: 9px 11px;
    cursor: pointer;
  }
  .shortcut-input:hover {
    border-color: var(--text-faint);
  }
  .shortcut-input.recording {
    border-color: var(--review);
    color: var(--text-dim);
  }
  .shortcut-input.unset {
    color: var(--text-faint);
  }
</style>
