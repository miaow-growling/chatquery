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
import { sql, MySQL } from "@codemirror/lang-sql";
import {
  EditorState,
  EditorSelection,
  Compartment,
  StateField,
  StateEffect,
  Prec,
} from "@codemirror/state";
import { undo, redo, indentMore, indentLess } from "@codemirror/commands";
import {
  autocompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { TableMeta } from "./types";
import { api } from "./api";

export interface EditorHandle {
  view: EditorView;
  getDoc(): string;
  /// Point the editor's autocomplete at a connection/database. Replaces the
  /// old eager full-schema load: completion is now fetched lazily (by name
  /// prefix, bounded) as you type, so an 8000-table schema never freezes the
  /// UI. `null, null` clears the context (e.g. non-MySQL / no connection).
  setSchemaContext(connId: string | null, db: string | null): void;
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
  /// --- Right-click menu commands (Navicat-style) ---------------------------
  undo(): void;
  redo(): void;
  /// Copy the current selection to the system clipboard (no-op when empty).
  copy(): void;
  /// Cut the current selection to the system clipboard (no-op when empty).
  cut(): void;
  /// Paste from the system clipboard at the cursor.
  paste(): Promise<void>;
  /// Delete the current selection without copying (no-op when empty).
  deleteSelection(): void;
  /// Select the entire document.
  selectAll(): void;
  /// Toggle `-- ` line comments across the selection (or the current line
  /// when nothing is selected). Re-runnable to uncomment.
  toggleComment(): void;
  /// Upper-case (`upper=true`) or lower-case the selection (no-op when empty).
  changeCase(upper: boolean): void;
  /// Increase / decrease indentation of the selection's lines.
  indent(): void;
  outdent(): void;
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

/// Clipboard helpers. The Tauri webview is served over `http://localhost`
/// (a secure context), so `navigator.clipboard` works; the `execCommand`
/// branch is a graceful fallback for any environment that blocks it.
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore — clipboard unavailable */
    }
    ta.remove();
  }
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

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

  // --- Lazy, bounded schema autocomplete (replaces the old eager full-schema
  // load that froze the UI on large databases). The editor only knows WHICH
  // connection/database it is editing; table/column names are fetched from the
  // backend on demand, by name prefix, with a hard LIMIT. Two small client
  // caches avoid re-querying the server on every keystroke. ---
  let ctxConnId: string | null = null;
  let ctxDb: string | null = null;
  let colCache = new Map<string, string[]>();
  let tableCache = new Map<string, TableMeta[]>();

// Lightweight FROM/JOIN scanner for the current statement. Extracts an
// (alias -> real table) map so autocomplete can suggest columns of the
// tables the user is actually querying — including JOINed tables and
// aliases. Handles `schema.table`, `AS alias`, comma-separated lists, and
// the various `* JOIN` forms. Sub-queries (`FROM (...)`) are skipped, which
// is an acceptable limitation (no derived-table column completion).
function parseFromTables(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const re =
    /\b(FROM|JOIN)\s+([^;()]+?)(?=\s+(?:WHERE|ON|GROUP BY|ORDER BY|LIMIT|HAVING|JOIN|;|$))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const list = m[2] ?? "";
    for (const raw of list.split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const tm = t.match(
        /^[`"]?([A-Za-z0-9_]+)[`"]?(?:\.[`"]?([A-Za-z0-9_]+)[`"]?)?\s*(?:AS\s+)?[`"]?([A-Za-z0-9_]+)?[`"]?$/i
      );
      if (!tm) continue;
      const tableName = tm[2] ?? tm[1];
      const alias = tm[3];
      if (!tableName || tableName.startsWith("(")) continue;
      const key = (alias ?? tableName).toLowerCase();
      if (!map.has(key)) map.set(key, tableName);
    }
  }
  return map;
}

  const schemaCompleter: CompletionSource = async (context) => {
    // Capture into consts so the non-null narrowing survives `await` (the
    // outer lets are mutated by setSchemaContext, which TS can't track).
    const connId = ctxConnId;
    const db = ctxDb;
    if (!connId || !db) return null;

  // The identifier being typed (or empty at BOF / after Ctrl-Space).
  const word = context.matchBefore(/[\w`]+/);
  let from: number;
  let prefix: string;
  if (word) {
    from = word.from;
    prefix = word.text;
  } else if (context.explicit) {
    from = context.pos;
    prefix = "";
  } else {
    return null;
  }
  const lowerPrefix = prefix.toLowerCase();

  const before = context.state.doc.sliceString(0, from);
  // Scan the ENTIRE current statement (text before AND after the cursor) for
  // FROM/JOIN clauses, so column completion fires in the SELECT list and WHERE
  // clause too — not only after the FROM keyword. Previously we only scanned
  // `before`, so typing a column left of the FROM (e.g. `SELECT col▍ FROM t`)
  // found no tables and wrongly fell through to table-name suggestions.
  const docText = context.state.doc.toString();
  const stmtStart = docText.lastIndexOf(";", from - 1) + 1;
  const semiAfter = docText.indexOf(";", from);
  const stmtEnd = semiAfter === -1 ? docText.length : semiAfter;
  const tablesMap = parseFromTables(docText.slice(stmtStart, stmtEnd));

  // Are we typing in a table-name position (right after FROM / JOIN / a comma)?
  // Used to decide whether table suggestions belong here. When composing a
  // column name we must NOT dump unrelated tables whose names happen to share
  // the column prefix.
  const preWord = word ? before.slice(0, word.from) : before;
  const inTablePos = /(\bFROM\b|\bJOIN\b|\,)\s*$/i.test(preWord);

  // 1) `alias.` / `table.` column completion — resolve the alias to the real table.
  const colMatch = before.match(/([A-Za-z0-9_`]+)\.\s*$/);
  if (colMatch) {
    const ref = colMatch[1].replace(/`/g, "");
    const realTable = tablesMap.get(ref.toLowerCase()) ?? ref;
    let cols = colCache.get(realTable);
    if (!cols) {
      try {
        cols = (await api.listColumns(connId, db, realTable)).map(
          (c) => c.name
        );
      } catch {
        cols = [];
      }
      colCache.set(realTable, cols);
    }
    const options = cols
      .filter((c) => c.toLowerCase().startsWith(lowerPrefix))
      .map(
        (c): Completion => ({
          label: c,
          type: "property",
          detail: realTable,
        })
      );
    return { from, options, validFor: /^[\w`]*$/ };
  }

  // 2) Column context: FROM/JOIN present -> suggest columns of every referenced
  //    table (deduped), with the origin table shown as detail. Table names are
  //    only offered when the cursor is in a table position (see `inTablePos`),
  //    so composing a column never shows unrelated tables. lang-sql's keyword
  //    completion runs in parallel.
  if (tablesMap.size > 0) {
    const fetches = Array.from(tablesMap.values()).map(async (t) => {
      let cols = colCache.get(t);
      if (!cols) {
        try {
          cols = (await api.listColumns(connId, db, t)).map((c) => c.name);
        } catch {
          cols = [];
        }
        colCache.set(t, cols);
      }
      return cols.map((c) => ({ c, t }));
    });
    const all = (await Promise.all(fetches)).flat();
    const seen = new Set<string>();
    const colOpts: Completion[] = [];
    for (const { c, t } of all) {
      const cl = c.toLowerCase();
      if (seen.has(cl)) continue;
      seen.add(cl);
      if (lowerPrefix && !cl.startsWith(lowerPrefix)) continue;
      colOpts.push({ label: c, type: "property", detail: t });
    }

    let tableOpts: Completion[] = [];
    // Only offer table names when the cursor is actually in a table position
    // (right after FROM/JOIN/comma). When composing a column name we show
    // columns only — never a pile of tables that merely share the prefix.
    if (inTablePos) {
      try {
        const tables = await api.searchTables(connId, db, prefix || null, 200);
        tableOpts = tables
          .filter((t) => !lowerPrefix || t.name.toLowerCase().startsWith(lowerPrefix))
          .map(
            (t): Completion => ({
              label: t.name,
              detail: t.is_view ? "view" : "table",
            })
          );
      } catch {
        /* ignore — column suggestions still work */
      }
    }
    return { from, options: [...colOpts, ...tableOpts], validFor: /^[\w`]*$/ };
  }

  // 3) No FROM yet — just suggest table names (keywords handled by lang-sql).
  try {
    const tables = await api.searchTables(connId, db, prefix || null, 200);
    const filtered = tables.filter(
      (t) => !lowerPrefix || t.name.toLowerCase().startsWith(lowerPrefix)
    );
    return {
      from,
      options: filtered.map(
        (t): Completion => ({
          label: t.name,
          detail: t.is_view ? "view" : "table",
        })
      ),
      validFor: /^[\w`]*$/,
    };
  } catch {
    return null;
  }
};

  const schemaCompleterExt = MySQL.language.data.of({
    autocomplete: schemaCompleter,
  });

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
      schemaConf.of(sql({ dialect: MySQL, upperCaseKeywords: true })),
      schemaCompleterExt,
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
    setSchemaContext(connId: string | null, db: string | null) {
      ctxConnId = connId;
      ctxDb = db;
      colCache.clear();
      tableCache.clear();
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
    undo() {
      undo(view);
      view.focus();
    },
    redo() {
      redo(view);
      view.focus();
    },
    copy() {
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      void writeClipboard(view.state.sliceDoc(from, to));
    },
    cut() {
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      const text = view.state.sliceDoc(from, to);
      void writeClipboard(text);
      view.dispatch({ changes: { from, to, insert: "" } });
      view.focus();
    },
    async paste() {
      const text = await readClipboard();
      if (!text) return;
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
      view.focus();
    },
    deleteSelection() {
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      view.dispatch({ changes: { from, to, insert: "" } });
      view.focus();
    },
    selectAll() {
      view.dispatch({
        selection: EditorSelection.range(0, view.state.doc.length),
      });
      view.focus();
    },
    toggleComment() {
      const sel = view.state.selection.main;
      const startLine = view.state.doc.lineAt(sel.from);
      const endLine = view.state.doc.lineAt(sel.to);
      const fromPos = startLine.from;
      const toPos = endLine.to;
      const lines = view.state.sliceDoc(fromPos, toPos).split("\n");
      const allCommented =
        lines.length > 0 && lines.every((l) => l.trimStart().startsWith("--"));
      const newLines = lines.map((l) =>
        allCommented
          ? l.replace(/^(\s*)--\s?/, "$1")
          : l.replace(/^(\s*)/, "$1-- ")
      );
      const newText = newLines.join("\n");
      view.dispatch({
        changes: { from: fromPos, to: toPos, insert: newText },
        selection: { anchor: fromPos, head: fromPos + newText.length },
      });
      view.focus();
    },
    changeCase(upper: boolean) {
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      const text = view.state.sliceDoc(from, to);
      const out = upper ? text.toUpperCase() : text.toLowerCase();
      view.dispatch({
        changes: { from, to, insert: out },
        selection: { anchor: from, head: from + out.length },
      });
      view.focus();
    },
    indent() {
      indentMore(view);
      view.focus();
    },
    outdent() {
      indentLess(view);
      view.focus();
    },
  };
}
