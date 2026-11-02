import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI on :1440 and forwards /api to the Rust server (`openblocks serve`).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1440,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:47880", changeOrigin: true } },
  },
  build: {
    target: "es2022",
    cssMinify: true,
    chunkSizeWarningLimit: 1500,
  },
});
