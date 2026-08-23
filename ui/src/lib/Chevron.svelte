<script>
  let { direction = "down", size = 14 } = $props();

  let path = $derived(direction === "right" ? "m9 18 6-6-6-6" : "m6 9 6 6 6-6");
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={path} />
</svg>

<style>
  svg {
    display: block;
    flex: none;
    color: var(--text-faint);
  }
</style>
