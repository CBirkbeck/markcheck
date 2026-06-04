import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: "es2021",
    rollupOptions: {
      // Bundle the results page (script + CSS). Opened via chrome.tabs.create.
      input: { results: "src/results/results.html" },
    },
  },
  test: { globals: true, environment: "node" },
});
