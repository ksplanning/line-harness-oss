import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const workerRoot = fileURLToPath(new URL(".", import.meta.url));

// React + Tailwind は salon-booking ページ (?page=salon-book) でのみ使う。
// main.ts から動的 import するので React チャンクは別ファイルに分離され、
// 既存の form / Google Calendar booking 利用者には load されない。
export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss()],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(workerRoot, "index.html"),
            "internal-form-logic": resolve(workerRoot, "src/client/internal-form-logic.ts"),
          },
          output: {
            entryFileNames: (chunk) => chunk.name === "internal-form-logic"
              ? "assets/internal-form-logic.js"
              : "assets/[name]-[hash].js",
          },
        },
      },
    },
  },
});
