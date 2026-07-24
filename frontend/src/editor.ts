import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { sql } from "@codemirror/lang-sql";
import { EditorState, Compartment } from "@codemirror/state";
import { autocompletion } from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { Schema } from "./types";

export interface EditorHandle {
  view: EditorView;
  getDoc(): string;
  setSchema(schema: Schema): void;
  clear(): void;
  insert(text: string): void;
  /// Replace the entire document (used when switching query tabs).
  replaceValue(text: string): void;
  /// Current selection text, or "" if nothing is selected. Powers "run
  /// selection only" — falls back to the whole doc when empty.
  getSelection(): string;
  /// Format the current selection (or the whole doc if nothing is selected)
  /// using sql-formatter. Returns true if formatting was applied.
  formatSql(): boolean;
  /// Switch between the dark (oneDark) and default light editor theme. The
  /// app's own palette is handled in CSS; this only re-themes CodeMirror so
  /// the editor doesn't stay light-on-dark (Phase 18).
  setTheme(dark: boolean): void;
}

/// Create a CodeMirror SQL editor mounted into `parent`.
/// `onRun` fires on Ctrl/Cmd+Enter; the schema powers table/column autocomplete.
export function createEditor(
  parent: HTMLElement,
  _onChange: (value: string) => void,
  onRun: () => void
): EditorHandle {
  const schemaConf = new Compartment();
  // Editor theme slot (Phase 18): oneDark for the dark app palette, no theme
  // (basicSetup's light default) for the light app palette. Read the initial
  // value from <html data-theme> so a persisted theme survives reload.
  const themeConf = new Compartment();
  const initialDark = document.documentElement.dataset.theme !== "light";

  const runKeymap = keymap.of([
    {
      key: "Mod-Enter",
      run: () => {
        onRun();
        return true;
      },
    },
  ]);

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) _onChange(u.state.doc.toString());
  });

  const state = EditorState.create({
    extensions: [
      basicSetup,
      autocompletion(),
      runKeymap,
      updateListener,
      themeConf.of(initialDark ? oneDark : []),
      schemaConf.of(sql()),
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    getDoc() {
      return view.state.doc.toString();
    },
    setSchema(s: Schema) {
      const map: Record<string, string[]> = {};
      for (const t of s.tables) {
        map[t.name] = t.columns.map((c) => c.name);
      }
      view.dispatch({
        effects: schemaConf.reconfigure(
          sql({ schema: map, upperCaseKeywords: true })
        ),
      });
    },
    clear() {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
      });
    },
    insert(text: string) {
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
      view.focus();
    },
    replaceValue(text: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getSelection() {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    setTheme(dark: boolean) {
      view.dispatch({
        effects: themeConf.reconfigure(dark ? oneDark : []),
      });
    },
    formatSql() {
      const { from, to } = view.state.selection.main;
      const hasSelection = from !== to;
      const text = hasSelection
        ? view.state.sliceDoc(from, to)
        : view.state.doc.toString();
      if (!text.trim()) return false;
      try {
        const formatted = formatSqlText(text, {
          language: "mysql" as SqlLanguage,
          tabWidth: 2,
          keywordCase: "upper",
        });
        if (hasSelection) {
          view.dispatch({
            changes: { from, to, insert: formatted },
            selection: { anchor: from, head: from + formatted.length },
          });
        } else {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: formatted },
          });
        }
        view.focus();
        return true;
      } catch {
        return false;
      }
    },
  };
}
