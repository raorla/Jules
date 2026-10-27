import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// SPA servie par l'api. En développement, `/v1` est relayé vers l'api locale.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@jules/source"] },
  build: { outDir: "dist", sourcemap: true },
  server: { proxy: { "/v1": "http://127.0.0.1:3001" } },
});
