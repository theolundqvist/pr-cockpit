// Runs the first call immediately, then folds every call inside the following window into one
// trailing run. A poll publishes an invalidation per refreshed PR; the view reloads once for
// the burst instead of once per event, and never later than one window after the last event.
export function burstGate(run, windowMs) {
  let timer = null;
  let pending = false;

  function close() {
    if (!pending) {
      timer = null;
      return;
    }
    pending = false;
    run();
    timer = setTimeout(close, windowMs);
  }

  return {
    trigger() {
      if (timer) {
        pending = true;
        return;
      }
      run();
      timer = setTimeout(close, windowMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}
