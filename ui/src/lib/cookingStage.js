// Labels describe the workflow; draft state and ordinary CI do not imply kitchen activity.
// Each stage lists the labels that mean it. A bare `order` is the request Kitchen has not yet labelled itself,
// so it already counts as an order.
const STAGES = [
  [["kitchen: serving"], "Serving"],
  [["kitchen: baked"], "Baked"],
  [["kitchen: oven"], "In the oven"],
  [["kitchen: chef"], "Chef working"],
  [["kitchen: prepped"], "Waiting for oven"],
  [["kitchen: prep"], "Preparing"],
  [["kitchen: ordered"], "Queued"],
  [["kitchen: order", "order"], "Order requested"],
];
const BURNT = "kitchen: burnt";

function labelSet(pr) {
  return new Set((pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name).toLowerCase().trim()));
}

function isOpen(pr) {
  return pr.state !== "MERGED" && pr.state !== "CLOSED";
}

export function isBurnt(pr) {
  return isOpen(pr) && labelSet(pr).has(BURNT);
}

export function cookingStage(pr) {
  if (!isOpen(pr) || pr.mergeFailed) return null;
  const labels = labelSet(pr);
  // A stale active label must never hide a workflow that needs intervention.
  if (labels.has(BURNT)) return null;
  const rank = STAGES.findIndex(([names]) => names.some((name) => labels.has(name)));
  if (rank < 0) return null;
  const label = STAGES[rank][0].find((name) => labels.has(name));
  // Kitchen takes a stacked PR only once the PRs below it land; until then the bare order just waits.
  const title = label === "order" && pr.baseIsDefaultBranch === false ? "Waiting for lower layers" : STAGES[rank][1];
  return { label, title, rank };
}
