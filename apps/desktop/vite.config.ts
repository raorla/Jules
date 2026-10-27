import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Interface du desktop : la même que le web (packages/ui), servie par Tauri depuis dist/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@jules/source"] },
  // Tauri attend un port fixe en développement.
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
  clearScreen: false,
});
