import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { initTheme } from "./lib/theme.svelte.js";
import { initPrefs } from "./lib/prefs.svelte.js";
import { initCodeHighlight } from "./lib/codeHighlight.svelte.js";
import { initHistory } from "./lib/history.svelte.js";
import { initQuota } from "./lib/quota.svelte.js";
import { initNativePalette } from "./lib/nativePalette.js";

initNativePalette();
initTheme();
initPrefs();
initHistory();
initQuota();
mount(App, { target: document.getElementById("app") });
// Highlighting only decorates code that renders later. Warm it after the first screen has
// painted: an idle callback alone fires while startup requests are in flight and then
// compiles grammars just as the inbox response needs the main thread.
setTimeout(() => requestIdleCallback(initCodeHighlight, { timeout: 1000 }), 1000);
