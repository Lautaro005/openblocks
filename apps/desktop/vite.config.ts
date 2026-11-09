import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// pdf.js reads these at run time (character maps, the 14 standard fonts, image decoders); they are
// served from /pdfjs/ next to the app.
const PDFJS = join(__dirname, "node_modules/pdfjs-dist");
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

function pdfjsAssets(): Plugin {
  return {
    name: "openblocks-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const [dir, file] = rel.split("/");
        if (!PDFJS_DIRS.includes(dir) || !file || file.includes("..")) return next();
        try {
          res.end(readFileSync(join(PDFJS, dir, file)));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const file of readdirSync(join(PDFJS, dir))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(PDFJS, dir, file)) });
        }
      }
    },
  };
}

// `npm run dev` serves the UI on :1440 and forwards /api to the Rust server (`openblocks serve`).
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
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
