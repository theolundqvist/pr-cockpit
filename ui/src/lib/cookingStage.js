// Labels describe the workflow; draft state and ordinary CI do not imply kitchen activity.
const STAGES = [
  ["kitchen: serving", "Serving"],
  ["kitchen: baked", "Baked"],
  ["kitchen: oven", "In the oven"],
  ["kitchen: chef", "Chef working"],
  ["kitchen: prepped", "Waiting for oven"],
  ["kitchen: prep", "Preparing"],
  ["kitchen: ordered", "Queued"],
  ["kitchen: order", "Order requested"],
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
  const rank = STAGES.findIndex(([label]) => labels.has(label));
  return rank < 0 ? null : { label: STAGES[rank][0], title: STAGES[rank][1], rank };
}
