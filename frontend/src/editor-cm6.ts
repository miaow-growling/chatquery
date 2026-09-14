import {
  EditorState,
  Compartment,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo as cmUndo,
  redo as cmRedo,
  selectAll as cmSelectAll,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  snippetCompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { sql, MySQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { ColumnInfo, TableMeta } from "./types";
import { api } from "./api";

export interface EditorHandle {
  view: { destroy: () => void; focus: () => void };
  editor?: any;
  getDoc(): string;
  setSchemaContext(connId: string | null, db: string | null): void;
  clear(): void;
  insert(text: string): void;
  replaceValue(text: string): void;
  getSelection(): string;
  getStatement(): string;
  formatSql(): boolean;
  setTheme(dark: boolean): void;
  undo(): void;
  redo(): void;
  copy(): void;
  cut(): void;
  paste(): Promise<void>;
  deleteSelection(): void;
  selectAll(): void;
  toggleComment(): void;
  changeCase(upper: boolean): void;
  indent(): void;
  outdent(): void;
  scrollToBottom?(): void;
  getSelectionRange(): { from: number; to: number };
  getCursorPosition(): number;
  replaceRange(from: number, to: number, text: string): void;
}

// ============================================================================
// SQL Statement Boundary Detection & Splitting (dialect-agnostic)
// ============================================================================

interface StatementBound {
  termStart: number;
  termEnd: number;
  len: number;
}

function statementBounds(doc: string): StatementBound[] {
  const bounds: StatementBound[] = [];
  let delim = ";";
  let i = 0;
  const n = doc.length;
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const readIdent = (start: number) => {
    let j = start;
    while (j < n && /[A-Za-z0-9_]/.test(doc[j])) j++;
    return j;
  };
  while (i < n) {
    const c = doc[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < n) {
        if (doc[i] === q) {
          if (doc[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (q !== "`" && doc[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && doc[i + 1] === "*") {
      const close = doc.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (
      c === "-" &&
      doc[i + 1] === "-" &&
      (doc[i + 2] === " " || doc[i + 2] === "\t")
    ) {
      const nl = doc.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "#") {
      const nl = doc.indexOf("\n", i + 1);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (isIdentStart(c)) {
      const wordEnd = readIdent(i);
      if (doc.slice(i, wordEnd).toUpperCase() === "DELIMITER") {
        let j = wordEnd;
        while (j < n && (doc[j] === " " || doc[j] === "\t")) j++;
        let k = j;
        while (
          k < n &&
          doc[k] !== " " &&
          doc[k] !== "\t" &&
          doc[k] !== "\n" &&
          doc[k] !== "\r"
        )
          k++;
        if (k > j) delim = doc.slice(j, k);
        i = k;
        continue;
      }
      i = wordEnd;
      continue;
    }
    if (doc.startsWith(delim, i)) {
      bounds.push({ termStart: i, termEnd: i + delim.length, len: delim.length });
      i += delim.length;
      continue;
    }
    i++;
  }
  return bounds;
}

export function statementRange(
  doc: string,
  from: number,
  to: number
): [number, number] {
  const bounds = statementBounds(doc);
  let start = 0;
  for (const b of bounds) {
    if (b.termEnd <= from) start = b.termEnd;
    else break;
  }
  let end = doc.length;
  for (const b of bounds) {
    if (b.termStart >= to) {
      end = b.len > 1 ? b.termEnd : b.termStart;
      break;
    }
  }
  const head = doc.slice(start, end);
  const dm = head.match(/^\s*DELIMITER\s+\S+[^\S\r\n]*\r?\n?/i);
  if (dm) start += dm[0].length;
  return [start, Math.max(start, end)];
}

export function splitStatements(doc: string): string[] {
  const bounds = statementBounds(doc);
  const out: string[] = [];
  let prev = 0;
  for (const b of bounds) {
    const stmt = doc.slice(prev, b.termStart).trim();
    if (stmt) out.push(stmt);
    prev = b.termEnd;
  }
  const tail = doc.slice(prev).trim();
  if (tail) out.push(tail);
  return out;
}

function parseFromTables(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!sql.trim()) return map;

  const fromJoinRe =
    /\b(?:FROM|JOIN)\s+([^;()]+?)(?=\s+(?:WHERE|ON|USING|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|NATURAL|STRAIGHT_JOIN|UNION|WINDOW|SET|FOR|;|$))/gi;
  let m: RegExpExecArray | null;
  while ((m = fromJoinRe.exec(sql))) {
    const list = m[1] ?? "";
    for (const raw of list.split(",")) {
      const t = raw.trim();
      if (!t || t.startsWith("(")) continue;
      const tm = t.match(
        /^[`"]?([A-Za-z0-9_]+)[`"]?(?:\.[`"]?([A-Za-z0-9_]+)[`"]?)?(?:\s+(?:AS\s+)?([`"]?[A-Za-z0-9_]+[`"]?))?$/i
      );
      if (!tm) continue;
      const tableName = tm[2] ?? tm[1];
      const alias = tm[3] ? tm[3].replace(/[`"]/g, "") : undefined;
      if (!tableName || tableName.startsWith("(")) continue;
      const key = (alias ?? tableName).toLowerCase();
      if (!map.has(key)) map.set(key, tableName);
      if (!map.has(tableName.toLowerCase())) map.set(tableName.toLowerCase(), tableName);
    }
  }

  const updateRe = /\bUPDATE\s+([`"]?[A-Za-z0-9_]+[`"]?(?:\.[`"]?[A-Za-z0-9_]+[`"]?)?)\s*(?:AS\s+)?([`"]?[A-Za-z0-9_]+[`"]?)?/gi;
  while ((m = updateRe.exec(sql))) {
    const rawTable = m[1].replace(/[`"]/g, "");
    const tableName = rawTable.includes(".") ? rawTable.split(".")[1] : rawTable;
    const alias = m[2] ? m[2].replace(/[`"]/g, "") : undefined;
    const key = (alias ?? tableName).toLowerCase();
    if (!map.has(key)) map.set(key, tableName);
    if (!map.has(tableName.toLowerCase())) map.set(tableName.toLowerCase(), tableName);
  }

  const insDelRe = /\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+([`"]?[A-Za-z0-9_]+[`"]?(?:\.[`"]?[A-Za-z0-9_]+[`"]?)?)/gi;
  while ((m = insDelRe.exec(sql))) {
    const rawTable = m[1].replace(/[`"]/g, "");
    const tableName = rawTable.includes(".") ? rawTable.split(".")[1] : rawTable;
    if (tableName) {
      map.set(tableName.toLowerCase(), tableName);
    }
  }

  return map;
}

// ============================================================================
// Schema Metadata Cache & Introspection
// ============================================================================

let currentConnId: string | null = null;
let currentDb: string | null = null;
let prefetchedTables: TableMeta[] = [];
let isPrefetching = false;

const colLruCache = new Map<string, ColumnInfo[]>();
const failedColTables = new Map<string, number>();
const FAILED_COL_TTL_MS = 10_000;

const getCachedCols = (table: string): ColumnInfo[] | undefined => {
  const key = table.toLowerCase();
  const cols = colLruCache.get(key);
  if (cols) {
    colLruCache.delete(key);
    colLruCache.set(key, cols);
  }
  return cols;
};

const setCachedCols = (table: string, cols: ColumnInfo[]) => {
  const key = table.toLowerCase();
  if (colLruCache.has(key)) colLruCache.delete(key);
  colLruCache.set(key, cols);
  if (colLruCache.size > 80) {
    const oldestKey = colLruCache.keys().next().value;
    if (oldestKey) colLruCache.delete(oldestKey);
  }
};

const loadColumns = async (
  connId: string,
  db: string,
  table: string
): Promise<ColumnInfo[]> => {
  const cached = getCachedCols(table);
  if (cached) return cached;

  const key = table.toLowerCase();
  const lastFail = failedColTables.get(key);
  if (lastFail && Date.now() - lastFail < FAILED_COL_TTL_MS) return [];

  try {
    const cols = await api.listColumns(connId, db, table);
    if (cols.length > 0) {
      setCachedCols(table, cols);
      return cols;
    }
    failedColTables.set(key, Date.now());
    return [];
  } catch (e) {
    console.warn(`[editor] listColumns failed for ${db}.${table}:`, e);
    failedColTables.set(key, Date.now());
    return [];
  }
};

const prefetchTables = async (connId: string, db: string) => {
  if (isPrefetching) return;
  isPrefetching = true;
  try {
    const tables = await api.searchTables(connId, db, null, 3000);
    if (currentConnId === connId && currentDb === db) {
      prefetchedTables = tables;
    }
  } catch {
    // Ignored
  } finally {
    isPrefetching = false;
  }
};

// ============================================================================
// CodeMirror 6 Autocomplete Provider (Intelligent Schema + Snippets)
// ============================================================================

const STATIC_SNIPPETS: Completion[] = [
  snippetCompletion("SELECT ${1:*} FROM ${2:table} WHERE ${3:1=1} LIMIT ${4:100};", {
    label: "sel",
    detail: "SELECT * FROM ...",
    type: "keyword",
    boost: 99,
  }),
  snippetCompletion("SELECT ${1:*} FROM ${2:table};", {
    label: "select_all",
    detail: "SELECT * FROM ...",
    type: "keyword",
    boost: 98,
  }),
  snippetCompletion("INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});", {
    label: "ins",
    detail: "INSERT INTO ...",
    type: "keyword",
    boost: 97,
  }),
  snippetCompletion("UPDATE ${1:table} SET ${2:col} = ${3:val} WHERE ${4:id} = ${5:val};", {
    label: "upd",
    detail: "UPDATE ... SET ...",
    type: "keyword",
    boost: 96,
  }),
  { label: "SELECT", type: "keyword", boost: 90 },
  { label: "FROM", type: "keyword", boost: 89 },
  { label: "WHERE", type: "keyword", boost: 88 },
  { label: "INSERT INTO", type: "keyword", boost: 87 },
  { label: "UPDATE", type: "keyword", boost: 86 },
  { label: "DELETE FROM", type: "keyword", boost: 85 },
  { label: "LEFT JOIN", type: "keyword", boost: 84 },
  { label: "INNER JOIN", type: "keyword", boost: 83 },
  { label: "GROUP BY", type: "keyword", boost: 82 },
  { label: "ORDER BY", type: "keyword", boost: 81 },
  { label: "LIMIT", type: "keyword", boost: 80 },
];

async function customSqlCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const word = context.matchBefore(/[\w`.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const fullDoc = context.state.doc.toString();
  const textBefore = fullDoc.slice(0, context.pos);
  const connId = currentConnId;
  const db = currentDb;

  // 1) Check for `alias.` or `table.` column trigger
  const dotMatch = textBefore.match(/([A-Za-z0-9_`]+)\.\s*[\w`]*$/);
  if (dotMatch && connId && db) {
    const rawRef = dotMatch[1].replace(/[`"]/g, "");
    const [stmtStart, stmtEnd] = statementRange(fullDoc, context.pos, context.pos);
    const statementText = fullDoc.slice(stmtStart, stmtEnd);
    const tablesMap = parseFromTables(statementText);
    const realTable = tablesMap.get(rawRef.toLowerCase()) ?? rawRef;
    const cols = await loadColumns(connId, db, realTable);

    const fromPos = dotMatch.index! + dotMatch[1].length + 1;
    const colOptions: Completion[] = cols.map((c) => ({
      label: c.name,
      type: c.key === "PRI" ? "property" : "field",
      detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${realTable}`,
      info: c.comment || undefined,
      boost: c.key === "PRI" ? 100 : 50,
    }));

    return {
      from: fromPos,
      options: colOptions,
      validFor: /^[\w`]*$/,
    };
  }

  const options: Completion[] = [...STATIC_SNIPPETS];

  // 2) Table position completion (FROM, JOIN, INTO, UPDATE)
  const inTablePos =
    /\b(FROM|JOIN|INTO|TABLE|UPDATE)\s+[\w`]*$/i.test(textBefore);

  if (inTablePos && connId && db) {
    const typed = word.text.replace(/[`"]/g, "");
    let tables: TableMeta[] = [];
    if (typed) {
      try {
        const [pre, sub, fuzzy] = await Promise.all([
          api.searchTables(connId, db, typed, 20),
          api.searchTables(connId, db, `*${typed}*`, 20),
          api.searchTables(connId, db, `~${typed}~`, 20),
        ]);
        const seen = new Set<string>();
        for (const t of [...pre, ...sub, ...fuzzy]) {
          if (seen.has(t.name)) continue;
          seen.add(t.name);
          tables.push(t);
          if (tables.length >= 20) break;
        }
      } catch {
        tables = [];
      }
    } else {
      tables = prefetchedTables.slice(0, 20);
    }

    for (const t of tables) {
      options.push({
        label: t.name,
        type: t.is_view ? "interface" : "class",
        detail: t.comment ? t.comment : t.is_view ? "View 视图" : "Table 数据表",
        info: t.comment ? `${t.name}\n注释：${t.comment}` : undefined,
        boost: 85,
      });
    }

    return {
      from: word.from,
      options,
      validFor: /^[\w`]*$/,
    };
  }

  // 3) Normal column position (SELECT, WHERE, etc.)
  if (connId && db) {
    const [stmtStart, stmtEnd] = statementRange(fullDoc, context.pos, context.pos);
    const statementText = fullDoc.slice(stmtStart, stmtEnd);
    const tablesMap = parseFromTables(statementText);
    if (tablesMap.size > 0) {
      const distinctTables = Array.from(new Set(tablesMap.values()));
      const colPromises = distinctTables.map(async (t) => {
        const cols = await loadColumns(connId, db, t);
        return cols.map((c) => ({ c, t }));
      });
      const allCols = (await Promise.all(colPromises)).flat();
      const seenCol = new Set<string>();

      for (const { c, t } of allCols) {
        const cl = c.name.toLowerCase();
        if (seenCol.has(cl)) continue;
        seenCol.add(cl);

        options.push({
          label: c.name,
          type: c.key === "PRI" ? "property" : "field",
          detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${t}`,
          info: c.comment || undefined,
          boost: c.key === "PRI" ? 70 : 40,
        });
      }
    }
  }

  return {
    from: word.from,
    options,
    validFor: /^[\w`]*$/,
  };
}

// ============================================================================
// Themes & Appearance
// ============================================================================

const themeCompartment = new Compartment();

const lightTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-surface, #ffffff)",
      color: "var(--text-primary, #1c1c1e)",
      fontSize: "13px",
      fontFamily: "var(--font-mono, 'JetBrains Mono', Menlo, Consolas, monospace)",
    },
    ".cm-content": {
      caretColor: "var(--brand, #4f46e5)",
      lineHeight: "21px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-canvas, #f5f5f7)",
      color: "var(--text-tertiary, #8e8e93)",
      borderRight: "1px solid var(--border-soft, #e5e5ea)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(0, 0, 0, 0.04)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(0, 0, 0, 0.06)",
      color: "var(--text-primary, #1c1c1e)",
    },
  },
  { dark: false }
);

const darkTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--bg-surface, #141826)",
      color: "var(--text-primary, #edeffb)",
      fontSize: "13px",
      fontFamily: "var(--font-mono, 'JetBrains Mono', Menlo, Consolas, monospace)",
    },
    ".cm-content": {
      caretColor: "var(--brand, #6366f1)",
      lineHeight: "21px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-canvas, #0b0d16)",
      color: "var(--text-tertiary, #5c6488)",
      borderRight: "1px solid var(--border, #262d44)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.07)",
      color: "var(--text-primary, #edeffb)",
    },
  },
  { dark: true }
);

// ============================================================================
// Main Factory: createEditor
// ============================================================================

export function createEditor(
  parent: HTMLElement,
  _onChange: (value: string) => void,
  onRun: () => void,
  onCmdK?: () => void
): EditorHandle {
  const isDark = document.documentElement.dataset.theme !== "light";

  const runKeymap = keymap.of([
    {
      key: "Mod-Enter",
      run: () => {
        onRun();
        return true;
      },
    },
    {
      key: "Mod-k",
      run: () => {
        if (onCmdK) {
          onCmdK();
          return true;
        }
        return false;
      },
    },
  ]);

  const changeListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      _onChange(update.state.doc.toString());
    }
  });

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    foldGutter(),
    indentOnInput(),
    bracketMatching(),
    dropCursor(),
    highlightSelectionMatches(),
    sql({
      dialect: MySQL,
    }),
    autocompletion({
      override: [customSqlCompletion],
      defaultKeymap: true,
    }),
    themeCompartment.of(isDark ? [darkTheme, oneDark] : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]),
    keymap.of([
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...searchKeymap,
    ]),
    runKeymap,
    changeListener,
    EditorView.lineWrapping,
  ];

  const state = EditorState.create({
    doc: "",
    extensions,
  });

  const view = new EditorView({
    state,
    parent,
  });

  return {
    view: {
      destroy: () => view.destroy(),
      focus: () => view.focus(),
    },
    editor: view,
    getDoc() {
      return view.state.doc.toString();
    },
    setSchemaContext(connId: string | null, db: string | null) {
      currentConnId = connId;
      currentDb = db;
      prefetchedTables = [];
      colLruCache.clear();
      failedColTables.clear();
      if (connId && db) {
        void prefetchTables(connId, db);
      }
    },
    clear() {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
      });
    },
    insert(text: string) {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    replaceValue(text: string) {
      if (view.state.doc.toString() === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getSelection() {
      const { from, to } = view.state.selection.main;
      if (from === to) return "";
      return view.state.sliceDoc(from, to);
    },
    getStatement() {
      const doc = view.state.doc.toString();
      const pos = view.state.selection.main.head;
      const [s, e] = statementRange(doc, pos, pos);
      return doc.slice(s, e).trim();
    },
    formatSql() {
      const doc = view.state.doc.toString();
      const { from, to } = view.state.selection.main;
      const hasSel = from !== to;
      const text = hasSel ? view.state.sliceDoc(from, to) : doc;
      if (!text.trim()) return false;

      try {
        const formatted = formatSqlText(text, {
          language: "mysql" as SqlLanguage,
          tabWidth: 2,
          keywordCase: "upper",
        });

        if (hasSel) {
          view.dispatch({
            changes: { from, to, insert: formatted },
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
    setTheme(dark: boolean) {
      view.dispatch({
        effects: themeCompartment.reconfigure(
          dark ? [darkTheme, oneDark] : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]
        ),
      });
    },
    undo() {
      cmUndo(view);
    },
    redo() {
      cmRedo(view);
    },
    copy() {
      const text = this.getSelection();
      if (text) void navigator.clipboard.writeText(text);
    },
    cut() {
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        const text = view.state.sliceDoc(from, to);
        void navigator.clipboard.writeText(text);
        view.dispatch({ changes: { from, to, insert: "" } });
      }
      view.focus();
    },
    async paste() {
      try {
        const text = await navigator.clipboard.readText();
        if (text) this.insert(text);
      } catch {
        // Ignored
      }
    },
    deleteSelection() {
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        view.dispatch({ changes: { from, to, insert: "" } });
      }
      view.focus();
    },
    selectAll() {
      cmSelectAll(view);
    },
    toggleComment() {
      // Toggle SQL comment `-- ` on current line(s)
      const state = view.state;
      const { from, to } = state.selection.main;
      const startLine = state.doc.lineAt(from);
      const endLine = state.doc.lineAt(to);
      const changes = [];

      for (let l = startLine.number; l <= endLine.number; l++) {
        const line = state.doc.line(l);
        if (line.text.trimStart().startsWith("--")) {
          const commentIdx = line.text.indexOf("--");
          const len = line.text[commentIdx + 2] === " " ? 3 : 2;
          changes.push({ from: line.from + commentIdx, to: line.from + commentIdx + len, insert: "" });
        } else {
          changes.push({ from: line.from, to: line.from, insert: "-- " });
        }
      }

      view.dispatch({ changes });
      view.focus();
    },
    changeCase(upper: boolean) {
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      const text = view.state.sliceDoc(from, to);
      const out = upper ? text.toUpperCase() : text.toLowerCase();
      view.dispatch({ changes: { from, to, insert: out } });
      view.focus();
    },
    indent() {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: "  " } });
    },
    outdent() {
      // Outdent: if lines start with 2 spaces, strip them
      const state = view.state;
      const { from, to } = state.selection.main;
      const startLine = state.doc.lineAt(from);
      const endLine = state.doc.lineAt(to);
      const changes = [];

      for (let l = startLine.number; l <= endLine.number; l++) {
        const line = state.doc.line(l);
        if (line.text.startsWith("  ")) {
          changes.push({ from: line.from, to: line.from + 2, insert: "" });
        } else if (line.text.startsWith(" ")) {
          changes.push({ from: line.from, to: line.from + 1, insert: "" });
        }
      }

      if (changes.length > 0) view.dispatch({ changes });
    },
    scrollToBottom() {
      const len = view.state.doc.length;
      view.dispatch({
        selection: { anchor: len },
        scrollIntoView: true,
      });
    },
    getSelectionRange() {
      const { from, to } = view.state.selection.main;
      return { from, to };
    },
    getCursorPosition() {
      return view.state.selection.main.head;
    },
    replaceRange(from: number, to: number, text: string) {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    },
  };
}
