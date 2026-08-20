export function timedFlag(durationMs, onExpire) {
  const state = $state({ value: null });
  let timer = null;
  return {
    get value() {
      return state.value;
    },
    show(value = true) {
      state.value = value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.value = null;
        onExpire?.();
      }, durationMs);
    },
    clear() {
      state.value = null;
      clearTimeout(timer);
    },
  };
}
