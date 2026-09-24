import { showFlash } from "./flash.svelte.js";

const KEY = "cockpit:pr-groups:v1";
function read() {
  const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PR groups");
  return Object.fromEntries(Object.entries(value).filter(([, group]) => typeof group === "string"));
}
export const assignments = $state({ values: {} });
// Initialized only while grouping is enabled.
export function syncAssignments() {
  try { assignments.values = read(); } catch { /* Retain the current assignments. */ }
}
export function assignPr(key, group) {
  try {
    const values = read();
    if (group) values[key] = group;
    else delete values[key];
    localStorage.setItem(KEY, JSON.stringify(values));
    assignments.values = values;
    return true;
  } catch {
    showFlash("Couldn't save the group. Please try again.");
    return false;
  }
}
export function onAssignmentStorage(event) {
  if (event.storageArea === localStorage && (event.key === KEY || event.key === null)) syncAssignments();
}
