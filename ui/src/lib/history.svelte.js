import { historyBackAction } from "./historyAction.js";

export const history = $state({ canBack: false, canForward: false });

export function goBack() {
  if (history.canBack) window.history.back();
}

export function goForward() {
  if (history.canForward) window.history.forward();
}

export function goBackOrFallback(fallback) {
  const action = historyBackAction(history.canBack, fallback);
  if (action === "back") goBack();
  else if (action === "fallback") location.hash = fallback;
}

export function initHistory() {
  const nav = window.navigation;
  if (nav) {
    const sync = () => {
      history.canBack = nav.canGoBack;
      history.canForward = nav.canGoForward;
    };
    sync();
    nav.addEventListener("currententrychange", sync);
    return;
  }

  let counter = 0;
  let cur = 0;
  let max = 0;
  window.history.replaceState({ navId: 0 }, "");

  const sync = () => {
    history.canBack = cur > 0;
    history.canForward = cur < max;
  };

  window.addEventListener("hashchange", () => {
    const navId = window.history.state?.navId;
    if (typeof navId === "number") {
      cur = navId;
    } else {
      cur = ++counter;
      max = cur;
      window.history.replaceState({ navId: cur }, "");
    }
    sync();
  });
  sync();
}
