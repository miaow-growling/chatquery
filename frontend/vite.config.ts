import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

const host = process.env.TAURI_DEV_HOST;

// Tauri expects a fixed dev port and ignores Vite's default "clear screen".
export default defineConfig({
  plugins: [
    react(),
    (monacoEditorPlugin as any).default
      ? (monacoEditorPlugin as any).default({
          languageWorkers: ["editorWorkerService"],
          customLanguages: [{ label: "sql", entry: "vs/basic-languages/sql/sql.contribution" }],
        })
      : (monacoEditorPlugin as any)({
          languageWorkers: ["editorWorkerService"],
          customLanguages: [{ label: "sql", entry: "vs/basic-languages/sql/sql.contribution" }],
        }),
  ],
  clearScreen: false,
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
