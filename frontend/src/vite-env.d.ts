/// <reference types="vite/client" />

// Monaco ESM side-effect imports (contributions, language registers) ship no
// per-file .d.ts; they resolve fine at runtime via the exports map. Exact
// paths that DO have declarations (editor.api) take precedence over this
// wildcard, so API typing is unaffected.
declare module "monaco-editor/*";
