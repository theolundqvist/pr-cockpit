import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  // shared/taskList.js parses with the renderer's own marked instance.
  resolve: { dedupe: ["marked"] },
  // Module workers share Shiki's grammar chunks with the page instead of inlining a copy.
  worker: { format: "es" },
  build: {
    outDir: "../static",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4820",
    },
  },
});
