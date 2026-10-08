import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Tauri expects a fixed dev port and ignores Vite's default "clear screen".
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: {
    include: ["mermaid", "dayjs"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
