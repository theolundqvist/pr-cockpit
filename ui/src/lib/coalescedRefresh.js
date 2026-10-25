// Keep refreshes serial while retaining one catch-up request for events received during a load.
// Each completed snapshot is applied by refresh before the catch-up starts.
export function coalescedRefresh(refresh) {
  let inFlight = null;
  let queued = false;

  return () => {
    queued = true;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(async () => {
      try {
        do {
          queued = false;
          await refresh();
        } while (queued);
      } finally {
        inFlight = null;
      }
    });
    return inFlight;
  };
}
