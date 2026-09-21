<script>
  import { onMount } from "svelte";
  import { NOTIFICATION_EVENTS, NOTIFICATION_FIELDS } from "../../../shared/notificationRules.ts";
  import { NOTIFICATION_EXAMPLES, newNotificationCondition, newNotificationRule, retargetNotificationCondition } from "./notificationEditor.js";
  import { NOTIFICATION_DRAIN_EVENT, notificationPermission } from "./desktopNotifications.js";
  import { notificationDelivery } from "./notificationDelivery.svelte.js";
  import { viewer } from "./viewer.svelte.js";

  let { settings = $bindable(), issues = new Map() } = $props();

  const isShell = navigator.userAgent.includes("Electron");
  const FIELD_IDS = Object.keys(NOTIFICATION_FIELDS);
  const OPERATOR_LABELS = { is: "is", isNot: "is not", contains: "contains", notContains: "doesn't contain" };
  const OPTION_LABELS = {
    actorType: { human: "a person", bot: "a bot" },
    participation: { author: "I opened it", assignee: "I'm assigned", reviewer: "my review is requested" },
    reviewState: { approved: "approved", changes_requested: "changes requested", commented: "commented", dismissed: "dismissed" },
    isDraft: { true: "yes", false: "no" },
  };
  const PLACEHOLDERS = { actor: "login or $me", prAuthor: "login or $me", repository: "owner/name", title: "text in the title", body: "text in the comment" };

  let permission = $state(notificationPermission());
  let requesting = $state(false);

  onMount(() => {
    const refreshPermission = () => { permission = notificationPermission(); };
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  });

  function requestDrain() {
    window.dispatchEvent(new Event(NOTIFICATION_DRAIN_EVENT));
  }

  // The only permission prompt in the app: an explicit click here. A grant lets App deliver
  // anything already queued right away instead of waiting for the next event.
  async function allowNotifications() {
    requesting = true;
    try {
      permission = await Notification.requestPermission();
    } finally {
      requesting = false;
    }
    if (permission === "granted") requestDrain();
  }

  function toggleEvent(rule, id) {
    rule.events = rule.events.includes(id) ? rule.events.filter((event) => event !== id) : [...rule.events, id];
  }

  function setField(rule, index, field) {
    rule.conditions[index] = retargetNotificationCondition(rule.conditions[index], field);
  }

  function addRule(rule = newNotificationRule()) {
    settings.rules = [...settings.rules, rule];
  }

  function removeRule(id) {
    settings.rules = settings.rules.filter((rule) => rule.id !== id);
  }
</script>


<label class="check-field settings-option">
  <input class="check" type="checkbox" bind:checked={settings.enabled} />
  <span class="check-text">
    <span class="check-label">Desktop notifications</span>
  </span>
</label>

<div class="field">
  <span class="label">This device</span>
  {#if permission === "unsupported"}
    <span class="hint">This {isShell ? "app" : "browser"} cannot show desktop notifications.</span>
  {:else if permission === "granted"}
    <span class="hint status-ok">Allowed</span>
    {#if notificationDelivery.error}
      <span class="hint invalid-hint" role="alert">Delivery failed: {notificationDelivery.error}</span>
      <button class="btn" type="button" onclick={requestDrain}>Retry now</button>
    {/if}
  {:else if permission === "denied"}
    <span class="hint invalid-hint">Allow notifications in {isShell ? "system" : "browser"} settings, then reload.</span>
  {:else}
    <button class="btn" type="button" disabled={requesting} onclick={allowNotifications}>{requesting ? "Waiting…" : "Allow notifications"}</button>
  {/if}
</div>

<div class="field">
  <span class="label">Rules</span>
  {#if settings.rules.length === 0}
    <span class="hint">Add a rule to receive notifications.</span>
  {/if}
</div>

{#each settings.rules as rule (rule.id)}
  <div class="rule-card" class:rule-disabled={!rule.enabled}>
    <div class="rule-head">
      <label class="rule-toggle">
        <input class="check" type="checkbox" bind:checked={rule.enabled} aria-label={`Enable ${rule.name || "rule"}`} />
        <span>{rule.enabled ? "On" : "Off"}</span>
      </label>
      <input class="input rule-name" bind:value={rule.name} aria-label="Rule name" placeholder="Rule name" spellcheck="false" autocomplete="off" />
    </div>

    <div class="rule-section">
      <span class="section-label" id={`events-${rule.id}`}>Events</span>
      <div class="chips" role="group" aria-labelledby={`events-${rule.id}`}>
        {#each NOTIFICATION_EVENTS as event}
          <button class="chip" class:chip-on={rule.events.includes(event.id)} type="button" aria-pressed={rule.events.includes(event.id)} onclick={() => toggleEvent(rule, event.id)}>{event.label}</button>
        {/each}
      </div>
    </div>

    <div class="rule-section">
      <label class="section-label" for={`match-${rule.id}`}>Conditions</label>
      <div class="match-row">
        <select id={`match-${rule.id}`} class="input narrow" bind:value={rule.match} disabled={rule.conditions.length < 2}>
          <option value="all">All must match</option>
          <option value="any">Any may match</option>
        </select>
        {#if rule.conditions.length === 0}<span class="hint match-hint">Every selected event.</span>{/if}
      </div>
      {#each rule.conditions as condition, index}
        {@const definition = NOTIFICATION_FIELDS[condition.field]}
        <div class="condition-row">
          <select class="input condition-field" value={condition.field} aria-label="Condition field" onchange={(e) => setField(rule, index, e.currentTarget.value)}>
            {#each FIELD_IDS as id}
              <option value={id}>{NOTIFICATION_FIELDS[id].label}</option>
            {/each}
          </select>
          <select class="input condition-operator" bind:value={condition.operator} aria-label="Condition operator">
            {#each definition.operators as operator}
              <option value={operator}>{OPERATOR_LABELS[operator]}</option>
            {/each}
          </select>
          {#if definition.options.length}
            <select class="input condition-value" bind:value={condition.value} aria-label="Condition value">
              {#each definition.options as option}
                <option value={option}>{OPTION_LABELS[condition.field]?.[option] ?? option}</option>
              {/each}
            </select>
          {:else}
            <input class="input condition-value" class:invalid={!condition.value.trim()} bind:value={condition.value} placeholder={PLACEHOLDERS[condition.field]} aria-label="Condition value" aria-invalid={!condition.value.trim()} spellcheck="false" autocomplete="off" />
          {/if}
          <button class="reset-link remove-condition" type="button" onclick={() => (rule.conditions = rule.conditions.filter((_, i) => i !== index))}>Remove</button>
          {#if condition.field === "actor" || condition.field === "prAuthor"}
            <span class="hint condition-hint"><code>$me</code> = {viewer.login || "your login"}</span>
          {:else if condition.field === "body"}
            <span class="hint condition-hint">Comments and reviews only.</span>
          {/if}
        </div>
      {/each}
      <button class="reset-link" type="button" onclick={() => (rule.conditions = [...rule.conditions, newNotificationCondition()])}>Add condition</button>
    </div>

    {#if issues.has(rule.id)}
      <span class="hint invalid-hint rule-issue" role="alert">{issues.get(rule.id)}</span>
    {/if}
    <button class="reset-link remove-rule" type="button" onclick={() => removeRule(rule.id)}>Remove rule</button>
  </div>
{/each}

<div class="rule-actions">
  <button class="btn" type="button" onclick={() => addRule()}>Add rule</button>
  <span class="hint examples-label">Examples</span>
  {#each NOTIFICATION_EXAMPLES as example}
    <button class="btn" type="button" title={example.hint} onclick={() => addRule(example.build(viewer.login))}>{example.label}</button>
  {/each}
</div>

<style>
  .field, .settings-option {
    display: block;
    min-width: 0;
    margin: 0;
    padding: 18px 0;
    border-top: 1px solid var(--border-soft);
  }
  .label { display: block; margin-bottom: 2px; color: var(--text); font-size: 14px; font-weight: 500; line-height: 20px; }
  .hint { display: block; margin-bottom: 10px; font-family: var(--sans); font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .hint:last-child { margin-bottom: 0; }
  .status-ok { color: var(--ready); }
  .invalid-hint { color: var(--fail); }
  .input {
    width: 100%;
    max-width: 100%;
    min-height: 36px;
    box-sizing: border-box;
    padding: 8px 11px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 20px;
  }
  .input.narrow { width: 200px; }
  .input:focus { outline: 2px solid var(--link); outline-offset: 2px; }
  .input:disabled { opacity: 0.6; cursor: default; }
  .input.invalid { border-color: var(--fail); }
  .check-field { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .check-label { display: block; color: var(--text); font-size: 14px; line-height: 21px; }
  .check-text { min-width: 0; }
  .check {
    appearance: none;
    position: relative;
    width: 36px;
    height: 21px;
    margin: 0;
    flex: none;
    border: 0;
    border-radius: 999px;
    background: var(--switch-unchecked);
    cursor: pointer;
  }
  .check::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--switch-thumb);
    box-shadow: var(--shadow-control-hairline);
  }
  .check:checked { background: var(--link); }
  .check:checked::after { transform: translateX(15px); }
  .check:disabled { opacity: 0.6; cursor: default; }
  .check:focus-visible, .btn:focus-visible, .chip:focus-visible, .reset-link:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 3px;
  }
  .rule-card { border-top: 1px solid var(--border-soft); padding: 20px 0; }
  .rule-disabled .rule-section, .rule-disabled .rule-name { opacity: 0.6; }
  .rule-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .rule-toggle { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; font-size: 12px; color: var(--text-dim); }
  .rule-toggle span { min-width: 20px; }
  .rule-name { width: 300px; }
  .rule-section { margin-bottom: 14px; }
  .section-label { display: block; margin-bottom: 8px; color: var(--text-dim); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    min-height: 28px;
    padding: 4px 11px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    cursor: pointer;
  }
  .chip-on { background: var(--link); box-shadow: var(--shadow-control-filled); color: var(--on-brand); }
  .match-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-bottom: 8px; }
  .match-hint { margin: 0; }
  .condition-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1.6fr) auto; gap: 6px 8px; align-items: center; margin-bottom: 8px; }
  .condition-hint { grid-column: 1 / -1; margin: 0; }
  .condition-hint code { font-family: var(--mono); font-size: 11px; }
  .rule-issue { margin: 4px 0 8px; }
  .reset-link { padding: 0; background: none; border: 0; color: var(--link); font-size: 12px; line-height: 1.5; cursor: pointer; }
  .reset-link:hover { text-decoration: underline; }
  .remove-condition { justify-self: start; }
  .remove-rule { display: block; margin-top: 4px; }
  .rule-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 20px 0 8px; }
  .examples-label { margin: 0; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 36px;
    padding: 8px 14px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .btn:disabled { background: var(--disabled-bg); box-shadow: none; color: var(--disabled-fg); cursor: default; }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled) { background: var(--surface-hover); }
    .chip:hover:not(.chip-on) { background: var(--surface-hover); color: var(--text); }
    .check:hover:not(:disabled) { background: var(--switch-unchecked-hover); }
    .check:checked:hover:not(:disabled) { background: var(--brand-hover); }
  }
  @media (max-width: 760px) {
    .condition-row { grid-template-columns: 1fr; }
    .rule-head { flex-wrap: wrap; }
    .rule-name { width: 100%; }
  }
</style>
