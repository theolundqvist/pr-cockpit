import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { initTheme, theme } from "./lib/theme.svelte.js";
import { initPrefs } from "./lib/prefs.svelte.js";
import { initHistory } from "./lib/history.svelte.js";
import { initQuota } from "./lib/quota.svelte.js";
import { initNativePalette } from "./lib/nativePalette.js";
import { warmHighlightWorker } from "./lib/offThreadHighlight.js";

initNativePalette();
initTheme();
initPrefs();
initHistory();
initQuota();
mount(App, { target: document.getElementById("app") });
// Start the highlighting worker once the first screen has painted, so the first conversation
// code block and Files view colour at once instead of waiting for grammars to load.
setTimeout(() => requestIdleCallback(() => warmHighlightWorker(theme.shiki), { timeout: 1000 }), 1000);
