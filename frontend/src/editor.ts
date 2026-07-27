import {
  EditorView,
  keymap,
  Decoration,
  DecorationSet,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { basicSetup } from "codemirror";
import { sql } from "@codemirror/lang-sql";
import {
  EditorState,
  Compartment,
  StateField,
  StateEffect,
  Prec,
} from "@codemirror/state";
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
  /// Toggle inline AI completion (Copilot-style ghost text). When `enabled`,
  /// `provider` is called (debounced) with the SQL typed so far and its result
  /// is shown as faint ghost text after the cursor; Tab accepts it.
  setAiComplete(
    enabled: boolean,
    provider?: (prefix: string) => Promise<string | null>
  ): void;
}

/// Inline AI-completion: a faint "ghost" suggestion rendered after the cursor.
/// State holds the current suggestion string; any edit or cursor move clears it.
const setInline = StateEffect.define<string | null>();

const inlineField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null;
    if (!tr.startState.selection.eq(tr.state.selection)) return null;
    for (const e of tr.effects) if (e.is(setInline)) return e.value;
    return value;
  },
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-ai-ghost";
    s.textContent = this.text;
    return s;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.build(u.view);
    }
    build(view: EditorView) {
      const text = view.state.field(inlineField);
      if (!text) {
        this.decorations = Decoration.none;
        return;
      }
      const sel = view.state.selection.main;
      if (sel.anchor !== sel.head) {
        this.decorations = Decoration.none;
        return;
      }
      const deco = Decoration.widget({ widget: new GhostWidget(text), side: 1 });
      this.decorations = Decoration.set([deco.range(sel.head)]);
    }
  },
  { decorations: (v) => v.decorations }
);

/// Accept the ghost suggestion on Tab; dismiss it on Escape. Falls through to
/// the default keymap (incl. the regular autocomplete popup) when no ghost is
/// present, so normal editing/Tab-to-accept-completion is unaffected.
const acceptInline = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view) => {
        const text = view.state.field(inlineField);
        if (!text) return false;
        const head = view.state.selection.main.head;
        view.dispatch({
          changes: { from: head, insert: text },
          selection: { anchor: head + text.length },
          effects: setInline.of(null),
          scrollIntoView: true,
        });
        return true;
      },
    },
    {
      key: "Escape",
      run: (view) => {
        if (view.state.field(inlineField)) {
          view.dispatch({ effects: setInline.of(null) });
          return true;
        }
        return false;
      },
    },
  ])
);

/// Create a CodeMirror SQL editor mounted into `parent`.
/// `onRun` fires on Ctrl/Cmd+Enter; the schema powers table/column autocomplete.
/// `aiProvider` powers inline AI completion when enabled via `setAiComplete`.
export function createEditor(
  parent: HTMLElement,
  _onChange: (value: string) => void,
  onRun: () => void,
  aiProvider?: (prefix: string) => Promise<string | null>
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

  // Inline AI completion: debounced request to `aiProvider` while typing.
  let aiEnabled = false;
  let aiProviderRef: ((prefix: string) => Promise<string | null>) | undefined =
    aiProvider;
  let aiTimer: ReturnType<typeof setTimeout> | null = null;
  const aiUpdateListener = EditorView.updateListener.of((u) => {
    if (!aiEnabled || !aiProviderRef) return;
    if (!u.docChanged) return;
    if (aiTimer) clearTimeout(aiTimer);
    const view = u.view;
    aiTimer = setTimeout(() => {
      const head = view.state.selection.main.head;
      if (head !== view.state.selection.main.anchor) return;
      const prefix = view.state.doc.toString().slice(0, head);
      aiProviderRef!(prefix)
        .then((suggestion) => {
          // Only apply if the cursor hasn't moved since we scheduled.
          if (view.state.selection.main.head === head) {
            view.dispatch({
              effects: setInline.of(
                suggestion && suggestion.length > 0 ? suggestion : null
              ),
            });
          }
        })
        .catch(() => {
          /* network/LLM error — silently skip the suggestion */
        });
    }, 500);
  });

  const state = EditorState.create({
    extensions: [
      basicSetup,
      autocompletion(),
      runKeymap,
      updateListener,
      themeConf.of(initialDark ? oneDark : []),
      schemaConf.of(sql()),
      inlineField,
      inlineDecorations,
      acceptInline,
      aiUpdateListener,
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
    setAiComplete(
      enabled: boolean,
      provider?: (prefix: string) => Promise<string | null>
    ) {
      aiEnabled = enabled;
      if (provider) aiProviderRef = provider;
      if (!enabled) view.dispatch({ effects: setInline.of(null) });
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
