import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 2 expects the dev server on a stable port and prefers no clear screen
// so its own logs stay visible alongside Vite's. Use the conventional 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  // Don't watch src-tauri output — Tauri handles that itself.
  envPrefix: ["VITE_", "TAURI_"],
  optimizeDeps: {
    entries: ["index.html"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    rollupOptions: {
      output: {
        // Keep the two heaviest dependencies out of the main chunk so
        // first paint ships app code only; the lazy route views split
        // on their own via React.lazy in App.tsx.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@monolythium/core-sdk") || id.includes("@monolythium+core-sdk")) {
            return "core-sdk";
          }
          if (id.includes("/cmdk@") || id.includes("/cmdk/")) return "cmdk";
          if (
            /\/(react|react-dom|scheduler)@/.test(id) ||
            /node_modules\/(react|react-dom|scheduler)\//.test(id) ||
            id.includes("react-router")
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
