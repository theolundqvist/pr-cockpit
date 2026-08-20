<script>
  import { presentMutationError } from "./mutationError.js";

  let { action, error, onRetry, onDiscard } = $props();
  let failure = $derived(presentMutationError(action, error));
</script>

<div class="failure" role="alert">
  <div class="failure-head">
    <span class="failure-icon" aria-hidden="true">!</span>
    <div class="failure-copy">
      <strong>{failure.title}</strong>
      <p>{failure.message}</p>
    </div>
  </div>
  <div class="failure-actions">
    <button class="retry" onclick={onRetry}>Try again</button>
    <button class="dismiss" onclick={onDiscard}>Dismiss</button>
  </div>
  <details>
    <summary>Technical details</summary>
    <pre>{failure.details}</pre>
  </details>
</div>

<style>
  .failure {
    min-width: 0;
    padding: 11px;
    border: 1px solid color-mix(in srgb, var(--fail) 42%, var(--border));
    border-radius: 10px;
    background: var(--fail-bg);
    font-family: var(--sans);
  }
  .failure-head {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }
  .failure-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--fail);
    border-radius: 50%;
    color: var(--fail);
    font-size: 12px;
    font-weight: 700;
  }
  .failure-copy {
    min-width: 0;
  }
  .failure-copy strong {
    display: block;
    color: var(--fail);
    font-size: 12.5px;
    line-height: 1.3;
  }
  .failure-copy p {
    margin: 3px 0 0;
    color: var(--text-dim);
    font-size: 11.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
  }
  .failure-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    margin-top: 10px;
  }
  .failure-actions button {
    min-height: 28px;
    padding: 4px 9px;
    border-radius: 6px;
    font-family: var(--sans);
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .retry {
    border: 1px solid color-mix(in srgb, var(--fail) 38%, var(--border));
    background: var(--panel);
    color: var(--fail);
  }
  .dismiss {
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-dim);
  }
  .failure-actions button:hover {
    background: var(--panel-raised);
  }
  details {
    margin-top: 8px;
    padding-top: 7px;
    border-top: 1px solid color-mix(in srgb, var(--fail) 16%, var(--border));
  }
  summary {
    width: fit-content;
    color: var(--text-faint);
    font: 10.5px/1.3 var(--mono);
    cursor: pointer;
  }
  pre {
    max-height: 120px;
    margin: 7px 0 0;
    padding: 8px;
    overflow: auto;
    border-radius: 6px;
    background: var(--code-block-bg);
    color: var(--text-dim);
    font: 10.5px/1.4 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
