import { fetchQuota } from "./api.js";

export const quota = $state({ resources: null });

export function initQuota() {
  const load = () =>
    fetchQuota()
      .then((next) => (quota.resources = next))
      .catch(() => {});
  load();
  setInterval(load, 60_000);
}
