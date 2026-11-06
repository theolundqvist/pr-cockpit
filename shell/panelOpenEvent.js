function createPanelOpenEvent(name) {
  let pending = null;
  return {
    get pending() { return pending !== null; },
    request(detail = {}) { pending = { detail }; },
    clear() { pending = null; },
    takeScript() {
      if (!pending) return null;
      const { detail } = pending;
      pending = null;
      return `window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, {detail:${JSON.stringify(detail)}}))`;
    },
  };
}

module.exports = { createPanelOpenEvent };
