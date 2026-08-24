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
initCodeHighlight();
initHistory();
initQuota();
mount(App, { target: document.getElementById("app") });
