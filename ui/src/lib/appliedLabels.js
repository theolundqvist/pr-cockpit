export function labelsAfterMutations(names, mutations) {
  const labels = new Set(names);
  for (const mutation of mutations) {
    if (mutation.state === "failed") continue;
    if (mutation.kind === "add-labels") for (const name of mutation.payload.labels) labels.add(name);
    else if (mutation.kind === "remove-labels") for (const name of mutation.payload.labels) labels.delete(name);
  }
  return labels;
}
