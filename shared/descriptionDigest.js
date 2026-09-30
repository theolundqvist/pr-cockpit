// Fingerprint of a PR description. The server stores it when a detail is written and the
// renderer computes it from the description it shows, so both sides must hash identically;
// plain arithmetic keeps it synchronous and available outside secure contexts.
/** @param {string} body @returns {string} */
export function descriptionDigest(body) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${body.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}
