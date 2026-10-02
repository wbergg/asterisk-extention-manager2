import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), tailwindcss()],
  build: {
    // Wrangler serves this directory as the Worker's static assets.
    outDir: fileURLToPath(new URL("../public", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:ui` proxies the API to a local `wrangler dev` so the SPA
    // can be developed with hot reload against the real Worker.
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
