import * as monaco from "monaco-editor";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { ColumnInfo, ForeignKeyInfo, TableMeta } from "./types";
import { api } from "./api";

// Configure Monaco environment for web workers if needed, or fallback to simple main-thread evaluation
if (typeof window !== "undefined") {
  (window as any).MonacoEnvironment = {
    getWorkerUrl: function (_moduleId: any, _label: string) {
      // In Tauri / Vite local context, standard basic language mode works without external worker URLs
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
        self.MonacoEnvironment = {
          baseUrl: '${window.location.origin}/'
        };
      `)}`;
    },
  };
}

export interface EditorHandle {
  view: { destroy: () => void; focus: () => void };
  editor: monaco.editor.IStandaloneCodeEditor;
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
  setAiComplete(
    enabled: boolean,
    provider?: (prefix: string) => Promise<string | null>
  ): void;
}

// SQL Statement parsing helpers
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

// SQL helper: scan for table names & aliases
function parseFromTables(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!sql.trim()) return map;

  const fromJoinRe =
    /\b(?:FROM|JOIN)\s+([^;()]+?)(?=\s+(?:WHERE|ON|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|JOIN|SET|;|$))/gi;
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

// Global active schema context shared with Monaco Completion Provider
let currentConnId: string | null = null;
let currentDb: string | null = null;
let prefetchedTables: TableMeta[] = [];
let isPrefetching = false;

const colLruCache = new Map<string, ColumnInfo[]>();
const fkCache = new Map<string, ForeignKeyInfo[]>();

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

// Register Monaco MySQL Completion Item Provider ONCE
let providerRegistered = false;

function ensureCompletionProvider() {
  if (providerRegistered) return;
  providerRegistered = true;

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "`"],
    provideCompletionItems: async (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: monaco.languages.CompletionItem[] = [];

      // Always include SQL snippets & templates (available even without active db)
      suggestions.push(
        {
          label: "sel",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "SELECT * FROM ...",
          documentation: { value: "常用 SELECT 查询模板" },
          insertText: "SELECT ${1:*} FROM ${2:table} WHERE ${3:1=1} LIMIT ${4:100};",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_0_sel",
        },
        {
          label: "select_all",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "SELECT * FROM ...",
          documentation: { value: "常用 SELECT 查询模板" },
          insertText: "SELECT ${1:*} FROM ${2:table};",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_1_sel",
        },
        {
          label: "ins",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "INSERT INTO ...",
          documentation: { value: "常用 INSERT 插入模板" },
          insertText: "INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_2_ins",
        },
        {
          label: "upd",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "UPDATE ... SET ...",
          documentation: { value: "常用 UPDATE 更新模板" },
          insertText: "UPDATE ${1:table} SET ${2:col} = ${3:val} WHERE ${4:id} = ${5:val};",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_3_upd",
        }
      );

      const connId = currentConnId;
      const db = currentDb;
      if (!connId || !db) return { suggestions };

      const lineContent = model.getLineContent(position.lineNumber);
      const textBefore = lineContent.slice(0, position.column - 1);
      const fullDoc = model.getValue();
      const offset = model.getOffsetAt(position);
      const [stmtStart, stmtEnd] = statementRange(fullDoc, offset, offset);
      const statementText = fullDoc.slice(stmtStart, stmtEnd);
      const tablesMap = parseFromTables(statementText);

      const inTablePos =
        /\b(FROM|JOIN|INTO|TABLE|UPDATE)\s+[\w`]*$/i.test(textBefore) ||
        /\b(FROM|JOIN|INTO|TABLE|UPDATE)\s*$/i.test(textBefore.slice(0, word.startColumn - 1));

      // 1) `alias.` or `table.` completion
      const dotMatch = textBefore.match(/([A-Za-z0-9_`]+)\.\s*$/);
      if (dotMatch) {
        const ref = dotMatch[1].replace(/[`"]/g, "");
        const realTable = tablesMap.get(ref.toLowerCase()) ?? ref;
        let cols = getCachedCols(realTable);
        if (!cols) {
          try {
            cols = await api.listColumns(connId, db, realTable);
          } catch {
            cols = [];
          }
          setCachedCols(realTable, cols);
        }

        const dotSuggestions: monaco.languages.CompletionItem[] = cols.map((c) => ({
          label: c.name,
          kind: c.key === "PRI" ? monaco.languages.CompletionItemKind.Keyword : monaco.languages.CompletionItemKind.Field,
          detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${realTable}`,
          documentation: c.comment ? { value: `**注释:** ${c.comment}` } : undefined,
          insertText: c.name,
          range,
          sortText: c.key === "PRI" ? `00_${c.name}` : `01_${c.name}`,
        }));

        return { suggestions: dotSuggestions };
      }

      // 2) In Table position (FROM, JOIN, INTO, UPDATE)
      if (inTablePos) {
        let tables = prefetchedTables;
        if (tables.length === 0) {
          try {
            tables = await api.searchTables(connId, db, null, 200);
          } catch {
            tables = [];
          }
        }

        for (const t of tables) {
          suggestions.push({
            label: t.name,
            kind: t.is_view ? monaco.languages.CompletionItemKind.Interface : monaco.languages.CompletionItemKind.Class,
            detail: t.is_view ? "View 视图" : "Table 数据表",
            documentation: { value: `数据库 **${db}** 中的${t.is_view ? "视图" : "数据表"}` },
            insertText: t.name,
            range,
            sortText: `00_${t.name}`,
          });
        }

        return { suggestions };
      }

      // 3) Normal column position (SELECT, WHERE, SET, ON, etc.)
      if (tablesMap.size > 0) {
        const distinctTables = Array.from(new Set(tablesMap.values()));
        const colPromises = distinctTables.map(async (t) => {
          let cols = getCachedCols(t);
          if (!cols) {
            try {
              cols = await api.listColumns(connId, db, t);
            } catch {
              cols = [];
            }
            setCachedCols(t, cols);
          }
          return cols.map((c) => ({ c, t }));
        });

        const allCols = (await Promise.all(colPromises)).flat();
        const seenCol = new Set<string>();

        for (const { c, t } of allCols) {
          const cl = c.name.toLowerCase();
          if (seenCol.has(cl)) continue;
          seenCol.add(cl);

          suggestions.push({
            label: c.name,
            kind: c.key === "PRI" ? monaco.languages.CompletionItemKind.Keyword : monaco.languages.CompletionItemKind.Field,
            detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${t}`,
            documentation: c.comment ? { value: `**表:** ${t}\n\n**类型:** ${c.data_type}\n\n**注释:** ${c.comment}` } : { value: `**表:** ${t}\n\n**类型:** ${c.data_type}` },
            insertText: c.name,
            range,
            sortText: c.key === "PRI" ? `00_${c.name}` : `01_${c.name}`,
          });
        }
      }

      // 4) If no tables yet, also suggest table names
      if (tablesMap.size === 0) {
        let tables = prefetchedTables;
        if (tables.length === 0) {
          try {
            tables = await api.searchTables(connId, db, null, 200);
          } catch {
            tables = [];
          }
        }
        for (const t of tables) {
          suggestions.push({
            label: t.name,
            kind: t.is_view ? monaco.languages.CompletionItemKind.Interface : monaco.languages.CompletionItemKind.Class,
            detail: t.is_view ? "View 视图" : "Table 数据表",
            insertText: t.name,
            range,
            sortText: `10_${t.name}`,
          });
        }
      }

      return { suggestions };
    },
  });
}

// Custom ChatQuery Dark Theme for Monaco
monaco.editor.defineTheme("chatquery-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "c586c0", fontStyle: "bold" },
    { token: "string.sql", foreground: "ce9178" },
    { token: "number", foreground: "b5cea8" },
    { token: "comment", foreground: "6a9955", fontStyle: "italic" },
    { token: "operator.sql", foreground: "569cd6" },
  ],
  colors: {
    "editor.background": "#16161a",
    "editor.foreground": "#e4e4e7",
    "editorCursor.foreground": "#6366f1",
    "editor.lineHighlightBackground": "#1e1e24",
    "editorLineNumber.foreground": "#52525b",
    "editorLineNumber.activeForeground": "#a1a1aa",
    "editorIndentGuide.background": "#27272a",
    "editorSuggestWidget.background": "#1e1e24",
    "editorSuggestWidget.border": "#3f3f46",
    "editorSuggestWidget.selectedBackground": "#6366f1",
    "editorSuggestWidget.highlightForeground": "#38bdf8",
  },
});

monaco.editor.defineTheme("chatquery-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "8b5cf6", fontStyle: "bold" },
    { token: "string.sql", foreground: "a855f7" },
    { token: "number", foreground: "098658" },
    { token: "comment", foreground: "71717a", fontStyle: "italic" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#18181b",
    "editorCursor.foreground": "#6366f1",
    "editor.lineHighlightBackground": "#f4f4f5",
    "editorSuggestWidget.selectedBackground": "#6366f1",
  },
});

/// Create a Monaco SQL editor mounted into `parent`.
export function createEditor(
  parent: HTMLElement,
  _onChange: (value: string) => void,
  onRun: () => void,
  _aiProvider?: (prefix: string) => Promise<string | null>
): EditorHandle {
  ensureCompletionProvider();

  const isDark = document.documentElement.dataset.theme !== "light";

  const editor = monaco.editor.create(parent, {
    value: "",
    language: "sql",
    theme: isDark ? "chatquery-dark" : "chatquery-light",
    fontSize: 13,
    fontFamily: "var(--font-mono, 'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, monospace)",
    lineNumbers: "on",
    lineHeight: 21,
    roundedSelection: true,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    smoothScrolling: true,
    minimap: { enabled: false },
    tabSize: 2,
    wordWrap: "on",
    quickSuggestions: {
      other: true,
      comments: true,
      strings: true,
    },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: "on",
    tabCompletion: "on",
    snippetSuggestions: "top",
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    fixedOverflowWidgets: true,
    suggest: {
      showKeywords: true,
      showSnippets: true,
      showFunctions: true,
      showFields: true,
      showClasses: true,
      showInterfaces: true,
      localityBonus: true,
      shareSuggestSelections: true,
    },
  });

  // Subscribe to changes
  editor.onDidChangeModelContent(() => {
    _onChange(editor.getValue());
  });

  // Shortcut: Cmd/Ctrl + Enter => onRun()
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
    onRun();
  });

  return {
    view: {
      destroy: () => editor.dispose(),
      focus: () => editor.focus(),
    },
    editor,
    getDoc() {
      return editor.getValue();
    },
    setSchemaContext(connId: string | null, db: string | null) {
      currentConnId = connId;
      currentDb = db;
      prefetchedTables = [];
      colLruCache.clear();
      fkCache.clear();
      if (connId && db) {
        void prefetchTables(connId, db);
      }
    },
    clear() {
      editor.setValue("");
    },
    insert(text: string) {
      const selection = editor.getSelection();
      if (selection) {
        editor.executeEdits("insert", [
          {
            range: selection,
            text,
            forceMoveMarkers: true,
          },
        ]);
      } else {
        const position = editor.getPosition();
        if (position) {
          editor.executeEdits("insert", [
            {
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              text,
              forceMoveMarkers: true,
            },
          ]);
        }
      }
      editor.focus();
    },
    replaceValue(text: string) {
      editor.setValue(text);
    },
    getSelection() {
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) return "";
      return editor.getModel()?.getValueInRange(selection) ?? "";
    },
    getStatement() {
      const doc = editor.getValue();
      const pos = editor.getPosition();
      if (!pos) return doc.trim();
      const offset = editor.getModel()?.getOffsetAt(pos) ?? 0;
      const [s, e] = statementRange(doc, offset, offset);
      return doc.slice(s, e).trim();
    },
    setTheme(dark: boolean) {
      monaco.editor.setTheme(dark ? "chatquery-dark" : "chatquery-light");
    },
    setAiComplete(
      _enabled: boolean,
      _provider?: (prefix: string) => Promise<string | null>
    ) {
      // Placeholder for Monaco Inline Completion Provider
    },
    formatSql() {
      const model = editor.getModel();
      if (!model) return false;
      const selection = editor.getSelection();
      const hasSel = selection && !selection.isEmpty();
      const text = hasSel ? model.getValueInRange(selection!) : model.getValue();
      if (!text.trim()) return false;

      try {
        const formatted = formatSqlText(text, {
          language: "mysql" as SqlLanguage,
          tabWidth: 2,
          keywordCase: "upper",
        });

        if (hasSel && selection) {
          editor.executeEdits("format", [{ range: selection, text: formatted }]);
        } else {
          editor.setValue(formatted);
        }
        editor.focus();
        return true;
      } catch {
        return false;
      }
    },
    undo() {
      editor.trigger("contextMenu", "undo", null);
      editor.focus();
    },
    redo() {
      editor.trigger("contextMenu", "redo", null);
      editor.focus();
    },
    copy() {
      document.execCommand("copy");
    },
    cut() {
      document.execCommand("cut");
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
      const selection = editor.getSelection();
      if (selection && !selection.isEmpty()) {
        editor.executeEdits("delete", [{ range: selection, text: "" }]);
      }
      editor.focus();
    },
    selectAll() {
      const model = editor.getModel();
      if (model) {
        editor.setSelection(model.getFullModelRange());
      }
      editor.focus();
    },
    toggleComment() {
      editor.getAction("editor.action.commentLine")?.run();
      editor.focus();
    },
    changeCase(upper: boolean) {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || selection.isEmpty() || !model) return;
      const text = model.getValueInRange(selection);
      const out = upper ? text.toUpperCase() : text.toLowerCase();
      editor.executeEdits("changeCase", [{ range: selection, text: out }]);
      editor.focus();
    },
    indent() {
      editor.getAction("editor.action.indentLines")?.run();
      editor.focus();
    },
    outdent() {
      editor.getAction("editor.action.outdentLines")?.run();
      editor.focus();
    },
  };
}
