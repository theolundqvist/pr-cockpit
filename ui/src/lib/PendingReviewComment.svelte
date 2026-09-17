<script>
  import { renderMarkdown } from "./markdown.js";
  import MutationBadge from "./MutationBadge.svelte";
  import Kbd from "./Kbd.svelte";
  import { presentMutationError } from "./mutationError.js";

  let { comment, mutations = [], onEdit, onDelete } = $props();
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let deleting = $state(false);
  let actionError = $state("");
  let editMutation = $derived(mutations.find((mutation) => mutation.kind === "edit-pending-comment"));
  let deleteMutation = $derived(mutations.find((mutation) => mutation.kind === "delete-pending-comment"));
  let displayBody = $derived(editMutation?.payload.body ?? comment.body);

  function startEditing() {
    draft = displayBody;
    actionError = "";
    editing = true;
  }

  async function save() {
    const body = draft.trim();
    if (!body || body === displayBody || saving) {
      if (body === displayBody) editing = false;
      return;
    }
    saving = true;
    actionError = "";
    try {
      await onEdit(comment.id, body);
      editing = false;
    } catch (error) {
      actionError = presentMutationError("edit pending review comment", error).message;
    } finally {
      saving = false;
    }
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      actionError = "";
      editing = false;
    } else if (!event.isComposing && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  }

  async function remove() {
    if (deleting) return;
    actionError = "";
    deleting = true;
    try {
      await onDelete(comment.id);
    } catch (error) {
      actionError = presentMutationError("remove pending review comment", error).message;
    } finally {
      deleting = false;
    }
  }
</script>

<div class="pending-comment" class:removing={deleteMutation?.state === "pending"}>
  <div class="pending-head">
    <span class="draft-label">Pending review comment</span>
    {#if editMutation}<MutationBadge state={editMutation.state} onRetry={() => editMutation.onRetry()} onDiscard={() => editMutation.onDiscard()} />{/if}
    {#if deleteMutation}<MutationBadge state={deleteMutation.state} onRetry={() => deleteMutation.onRetry()} onDiscard={() => deleteMutation.onDiscard()} />{/if}
  </div>
  {#if actionError}<div class="action-error" role="alert">{actionError}</div>{/if}
  {#if editing}
    <textarea bind:value={draft} oninput={() => (actionError = "")} onkeydown={onKeydown}></textarea>
    <div class="actions">
      <button class="primary" disabled={!draft.trim() || saving} onclick={save}>{saving ? "Saving…" : "Save"}{#if draft.trim() && !saving} <Kbd keys={["cmd", "enter"]} />{/if}</button>
      <button onclick={() => ((actionError = ""), (editing = false))}>Cancel</button>
    </div>
  {:else}
    <div class="md">{@html renderMarkdown(displayBody)}</div>
    <div class="actions">
      <button disabled={!!deleteMutation} onclick={startEditing}>Edit</button>
      <button class="danger" disabled={deleting || deleteMutation?.state === "pending"} onclick={remove}>{deleting || deleteMutation?.state === "pending" ? "Removing…" : "Remove"}</button>
    </div>
  {/if}
</div>

<style>
  .pending-comment {
    border: 1px solid color-mix(in srgb, var(--link) 45%, var(--border));
    border-radius: 6px;
    background: var(--panel);
    padding: 8px 10px;
  }
  .pending-comment.removing { opacity: 0.65; }
  .pending-head, .actions { display: flex; align-items: center; gap: 8px; }
  .pending-head { margin-bottom: 6px; }
  .draft-label { color: var(--link); font-size: 11.5px; font-weight: 600; }
  textarea { width: 100%; min-height: 54px; resize: vertical; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); padding: 8px; font: 12.5px var(--md-font, var(--sans)); }
  textarea:focus { outline: none; border-color: var(--text-faint); }
  .action-error { color: var(--fail); font-size: 11.5px; margin-bottom: 6px; }
  .actions { margin-top: 7px; }
  button { border: 1px solid var(--border); border-radius: 6px; background: var(--panel-raised); color: var(--text-dim); padding: 4px 9px; font-size: 11.5px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--text-faint); color: var(--text); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--link); color: var(--on-brand); }
  button.danger { color: var(--fail); }
</style>
