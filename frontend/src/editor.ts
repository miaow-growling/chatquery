import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { ColumnInfo, TableMeta } from "./types";
import { api } from "./api";

// Configure @monaco-editor/react to use the local bundled monaco instance
loader.config({ monaco });

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

// SQL statement splitting & boundaries
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

// Global active schema context
let currentConnId: string | null = null;
let currentDb: string | null = null;
let prefetchedTables: TableMeta[] = [];
let isPrefetching = false;

const colLruCache = new Map<string, ColumnInfo[]>();
/// Short-lived negative cache: tables whose last column fetch FAILED or
/// returned empty. Without this, a single transient failure would either be
/// retried on every keystroke (request storm) or — worse — get cached as an
/// empty array forever, permanently hiding that table's columns.
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

/// Shared column loader for the completion provider: LRU-cached, with a
/// short negative TTL so failures are retried later instead of poisoning
/// the cache with an empty list.
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
    // Empty result: don't cache permanently (the table might be case-
    // sensitive on the server, or the fetch raced a schema switch).
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

// Register Monaco MySQL Completion Item Provider ONCE
let providerRegistered = false;

// --- Inline AI completion (Copilot-style ghost text) ------------------------
// Module-level because Monaco providers are registered per-language (global),
// while our editor instance (and its aiProvider closure) may be recreated.
let aiEnabled = false;
let aiProviderFn: ((prefix: string) => Promise<string | null>) | undefined;
let aiInlineRegistered = false;
/// Set by createEditor — the provider needs to close the suggest widget
/// when an AI suggestion arrives, or the widget suppresses the ghost.
let activeEditor: monaco.editor.IStandaloneCodeEditor | null = null;

/// Trim overlapping prefix from LLM response. Many models repeat the last few
/// tokens (e.g. prompt ends with "SELECT ", model returns "SELECT * FROM t").
function trimOverlap(prefix: string, suggestion: string): string {
  let s = suggestion.trimStart();
  const cleanPrefix = prefix.trimEnd();
  for (let len = Math.min(cleanPrefix.length, s.length); len > 0; len--) {
    if (cleanPrefix.endsWith(s.slice(0, len))) {
      s = s.slice(len);
      break;
    }
  }
  return s;
}

function ensureAiInlineProvider() {
  if (aiInlineRegistered) return;
  aiInlineRegistered = true;

  monaco.languages.registerInlineCompletionsProvider("sql", {
    async provideInlineCompletions(model, position, _context, token) {
      if (!aiEnabled || !aiProviderFn) return { items: [] };
      const offset = model.getOffsetAt(position);
      const prefix = model.getValue().slice(0, offset);
      if (!prefix.trim()) return { items: [] };

      // Debounce: wait for a brief typing pause before invoking the LLM.
      // Monaco invokes on every keystroke; wait for a typing pause before
      // spending an LLM call. 600ms — long enough to skip fast typing
      // bursts (each would otherwise cancel the previous request on slow
      // models), short enough to feel responsive.
      await new Promise((r) => setTimeout(r, 600));
      if (token.isCancellationRequested) return { items: [] };

      try {
        let suggestion = await aiProviderFn!(prefix);
        if (token.isCancellationRequested || !suggestion || !suggestion.trim()) {
          return { items: [] };
        }

        suggestion = trimOverlap(prefix, suggestion);
        if (!suggestion) return { items: [] };

        // Monaco suppresses a first-time ghost while the suggest widget has
        // a selected item (the schema/keyword popup opens on nearly every
        // keystroke). Close it so the AI ghost can render at all; later
        // keystrokes reopen the popup and the ghost stays visible via
        // inlineSuggest.experimental.showOnSuggestConflict:"always".
        activeEditor?.trigger("ai", "hideSuggestWidget", {});

        // Copilot-style replacement range: when the cursor is mid-word
        // (`ins|`), replace from the word START so accepting the suggestion
        // yields `insert into …` instead of `insinsert into …`. The ghost
        // preview only shows the part after the cursor.
        const word = model.getWordUntilPosition(position);
        // The model may restart from the beginning of the current word
        // (`ins` typed, LLM returns `insert into …`): strip that leading
        // word overlap so insertion yields `insert into …`, not `insinsert…`.
        {
          const wl = (word.word || "").toLowerCase();
          const sl = suggestion.toLowerCase();
          if (wl && sl.startsWith(wl)) {
            suggestion = suggestion.slice(wl.length);
          }
        }
        const replaceRange: monaco.IRange =
          word.word && word.word.length > 0
            ? {
                startLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              }
            : {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              };

        return {
          items: [
            {
              // Full text from word start; Monaco displays only the suffix
              // beyond the cursor as ghost and replaces the word on accept.
              insertText: (word.word || "") + suggestion,
              range: replaceRange,
            },
          ],
        };
      } catch {
        // network/LLM error — silently skip this suggestion
        return { items: [] };
      }
    },
    disposeInlineCompletions() {},
  });
}

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

      // Always include SQL snippets & templates
      suggestions.push(
        {
          label: "select",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "SELECT",
          insertText: "SELECT ",
          range,
          sortText: "00_select",
        },
        {
          label: "sel",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "SELECT * FROM ...",
          documentation: "常用 SELECT 查询模板",
          insertText: "SELECT ${1:*} FROM ${2:table} WHERE ${3:1=1} LIMIT ${4:100};",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_0_sel",
        },
        {
          label: "from",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "FROM",
          insertText: "FROM ",
          range,
          sortText: "00_from",
        },
        {
          label: "where",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "WHERE",
          insertText: "WHERE ",
          range,
          sortText: "00_where",
        },
        {
          label: "insert",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "INSERT INTO",
          insertText: "INSERT INTO ",
          range,
          sortText: "00_insert",
        },
        {
          label: "update",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "UPDATE",
          insertText: "UPDATE ",
          range,
          sortText: "00_update",
        },
        {
          label: "delete",
          kind: monaco.languages.CompletionItemKind.Keyword,
          detail: "DELETE FROM",
          insertText: "DELETE FROM ",
          range,
          sortText: "00_delete",
        },
        {
          label: "select_all",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "SELECT * FROM ...",
          documentation: "常用 SELECT 查询模板",
          insertText: "SELECT ${1:*} FROM ${2:table};",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_1_sel",
        },
        {
          label: "ins",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "INSERT INTO ...",
          documentation: "常用 INSERT 插入模板",
          insertText: "INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});",
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: "00_2_ins",
        },
        {
          label: "upd",
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: "UPDATE ... SET ...",
          documentation: "常用 UPDATE 更新模板",
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
        const cols = await loadColumns(connId, db, realTable);

        const dotSuggestions: monaco.languages.CompletionItem[] = cols.map((c) => ({
          label: c.name,
          kind: c.key === "PRI" ? monaco.languages.CompletionItemKind.Keyword : monaco.languages.CompletionItemKind.Field,
          detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${realTable}`,
          documentation: c.comment || undefined,
          insertText: c.name,
          range,
          sortText: c.key === "PRI" ? `00_${c.name}` : `01_${c.name}`,
        }));

        return { suggestions: dotSuggestions };
      }

      // 2) In Table position (FROM, JOIN, INTO, UPDATE)
      if (inTablePos) {
        // LIVE keyword search — databases can hold thousands of tables and a
        // fixed first-200 list never reaches alphabetically-late names like
        // k_task. Query by the typed text (limit 20): PREFIX first (k_t →
        // k_task), plus a SUBSTRING pass (k → anything containing k) merged
        // and deduped so short prefixes still surface likely matches. Typing
        // more narrows everything.
        const typed = word.word || "";
        let tables: TableMeta[] = [];
        if (typed) {
          try {
            // Three live passes, merged & deduped, capped at 20:
            //   prefix  (k_t  → k_task…)          — exact start
            //   substring (*k* → any containing k) — partial memory
            //   fuzzy   (~k_tsk~ → k_task)         — typo tolerance
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
          tables = prefetchedTables;
          if (tables.length === 0) {
            try {
              tables = await api.searchTables(connId, db, null, 20);
            } catch {
              tables = [];
            }
          }
        }

        for (const t of tables) {
          // Skip the literal typed word itself (Monaco already echoes it as
          // the top suggestion; listing it again is noise).
          if (t.name === typed) continue;
          suggestions.push({
            label: t.name,
            kind: t.is_view ? monaco.languages.CompletionItemKind.Interface : monaco.languages.CompletionItemKind.Class,
            detail: t.is_view ? "View 视图" : "Table 数据表",
            documentation: `数据库 ${db} 中的${t.is_view ? "视图" : "数据表"}`,
            insertText: t.name,
            range,
            sortText: `00_${t.name}`,
          });
        }

        // Tell the user how to see more when the result is at the cap.
        if (tables.length >= 20) {
          suggestions.push({
            label: `… 继续输入以缩小范围（已显示 ${tables.length} 个匹配）`,
            kind: monaco.languages.CompletionItemKind.Text,
            insertText: "",
            range,
            sortText: "99_more",
          });
        }

        return { suggestions };
      }

      // 3) Normal column position (SELECT, WHERE, SET, ON, etc.)
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

          suggestions.push({
            label: c.name,
            kind: c.key === "PRI" ? monaco.languages.CompletionItemKind.Keyword : monaco.languages.CompletionItemKind.Field,
            detail: `${c.key === "PRI" ? "🔑 " : ""}${c.data_type} · ${t}`,
            documentation: c.comment ? `表: ${t}\n类型: ${c.data_type}\n注释: ${c.comment}` : `表: ${t}\n类型: ${c.data_type}`,
            insertText: c.name,
            range,
            sortText: c.key === "PRI" ? `00_${c.name}` : `01_${c.name}`,
          });
        }
      }

      // 4) If no tables yet, do not dump all tables when typing generic keywords
      return { suggestions };
    },
  });
}

// Register custom themes with correct suggest-widget foreground colors.
// Monaco's theme system sets these via JS-injected <style> tags with very high
// specificity, so this is more reliable than CSS overrides for the suggest widget.
let _themesRegistered = false;
function ensureThemes() {
  if (_themesRegistered) return;
  _themesRegistered = true;

  monaco.editor.defineTheme("cq-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      // Suggest widget
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#d4d4d8",
      "editorSuggestWidget.foreground": "#18181b",
      "editorSuggestWidget.selectedBackground": "#0078d4",
      "editorSuggestWidget.selectedForeground": "#ffffff",
      "editorSuggestWidget.highlightForeground": "#0078d4",
      "editorSuggestWidget.focusHighlightForeground": "#ffffff",
      // Ghost text (AI inline completion)
      "editorGhostText.foreground": "#6b7280",
      // Hover
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#d4d4d8",
      "editorHoverWidget.foreground": "#18181b",
    },
  });

  monaco.editor.defineTheme("cq-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editorSuggestWidget.background": "#1e1e1e",
      "editorSuggestWidget.border": "#454545",
      "editorSuggestWidget.foreground": "#d4d4d4",
      "editorSuggestWidget.selectedBackground": "#0078d4",
      "editorSuggestWidget.selectedForeground": "#ffffff",
      "editorSuggestWidget.highlightForeground": "#18a3ff",
      "editorSuggestWidget.focusHighlightForeground": "#ffffff",
      // Ghost text (AI inline completion)
      "editorGhostText.foreground": "#9ca3af",
      "editorHoverWidget.background": "#252526",
      "editorHoverWidget.border": "#454545",
      "editorHoverWidget.foreground": "#d4d4d4",
    },
  });
}

/// Create a Monaco SQL editor mounted into `parent`.
export function createEditor(
  parent: HTMLElement,
  _onChange: (value: string) => void,
  onRun: () => void,
  _aiProvider?: (prefix: string) => Promise<string | null>
): EditorHandle {
  ensureCompletionProvider();
  ensureThemes();
  ensureAiInlineProvider();
  if (_aiProvider) {
    aiProviderFn = _aiProvider;
    aiEnabled = true;
  }

  const isDark = document.documentElement.dataset.theme !== "light";

  const editor = monaco.editor.create(parent, {
    value: "",
    language: "sql",
    theme: isDark ? "cq-dark" : "cq-light",
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
    fixedOverflowWidgets: true,
    // Inline AI ghost text (Tab accepts) — provider in ensureAiInlineProvider.
    // showOnSuggestConflict: "always" — our SQL schema popup opens on nearly
    // every keystroke and Monaco hides inline suggestions while it is open,
    // so with the default "never" the ghost text could never appear. The
    // 0.56 typings don't expose `experimental` yet; the runtime honors it.
    inlineSuggest: {
      enabled: true,
      experimental: { showOnSuggestConflict: "always" },
    } as monaco.editor.IInlineSuggestOptions,
    // Monaco's default for quickSuggestions.other is 'offWhenInlineCompletions':
    // merely enabling inlineSuggest (above) silently disabled the schema/keyword
    // popup while typing — both completions vanished. 'on' restores the popup;
    // the AI ghost coexists via showOnSuggestConflict above. (Monaco's inline
    // auto-trigger only runs while a suggest item is selected, so the popup is
    // also what makes the ghost appear automatically.)
    quickSuggestions: { other: "on", comments: false, strings: false },
    // Use the app's own Navicat-style context menu (App.tsx buildEditorMenu:
    // 运行/格式化/注释/大小写/AI 引用…). Monaco's built-in menu would open
    // on top of it with only cut/copy/paste entries.
    contextmenu: false,
  });

  // Subscribe to changes
  editor.onDidChangeModelContent(() => {
    _onChange(editor.getValue());
  });
  // "写注释回车生成 SQL": Enter/Paste don't fire onDidType, so the inline
  // model won't refetch on its own. When a newline lands and AI completion
  // is on, explicitly trigger the ghost (the provider debounces the LLM call).
  editor.onDidChangeModelContent((e) => {
    if (!aiEnabled || !aiProviderFn) return;
    const last = e.changes[e.changes.length - 1];
    if (!last || !last.text.includes("\n")) return;
    setTimeout(() => {
      if (!aiEnabled) return;
      editor.trigger("ai", "editor.action.inlineSuggest.trigger", {});
    }, 120);
  });
  // Comment-to-SQL: cursor right after a `-- comment` (no Enter yet) is an
  // intent position — proactively ask for the AI ghost. Monaco's inline
  // trigger is unreliable there (comment tokens aren't "typing SQL").
  let commentTriggerTimer: ReturnType<typeof setTimeout> | null = null;
  editor.onDidChangeModelContent(() => {
    if (!aiEnabled || !aiProviderFn) return;
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return;
    const line = model.getLineContent(pos.lineNumber);
    const textBefore = line.slice(0, pos.column - 1).trimEnd();
    // Whole line is a comment and the cursor is at its end.
    if (!/^--\s*\S/.test(textBefore)) return;
    if (commentTriggerTimer) clearTimeout(commentTriggerTimer);
    commentTriggerTimer = setTimeout(() => {
      if (!aiEnabled) return;
      editor.trigger("ai", "editor.action.inlineSuggest.trigger", {});
    }, 400);
  });
  // While the suggest popup is open, Monaco filters the ORIGINAL provider
  // result locally on every keystroke — a fuzzy hit like k_task (which
  // doesn't contain the typed k_tsk) is dropped before our fuzzy query can
  // run again. Re-trigger suggest on each change: Monaco re-invokes the
  // provider in place (no flicker) and the live prefix/substring/fuzzy
  // search keeps matching the CURRENT input.
  //
  // Scope this to TABLE positions only: re-triggering elsewhere (SELECT,
  // WHERE, …) also resets the inline AI ghost on every keystroke, which
  // made the AI continuation feel broken ("打一个字建议就没了").
  let refreshSuggestTimer: ReturnType<typeof setTimeout> | null = null;
  editor.onDidChangeModelContent(() => {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return;
    const line = model.getLineContent(pos.lineNumber);
    const textBefore = line.slice(0, pos.column - 1);
    if (!/\b(?:FROM|JOIN|INTO|TABLE|UPDATE)\s+[\w`]*$/i.test(textBefore)) return;
    const widgetVisible = !!document.querySelector(".suggest-widget.visible");
    if (!widgetVisible) return;
    if (refreshSuggestTimer) clearTimeout(refreshSuggestTimer);
    refreshSuggestTimer = setTimeout(() => {
      editor.trigger("ai", "editor.action.triggerSuggest", {});
    }, 60);
  });
  // Expose this instance to the module-level AI inline provider (it must be
  // able to close the suggest widget when a suggestion arrives).
  activeEditor = editor;

  // macOS IMK error bubbles (IMKCFRunLoopWakeUpReliable) steal WebView focus,
  // and Monaco cancels the in-flight AI request on blur (its controller calls
  // model.stop('automatic') on editor blur). Refocusing should re-trigger the
  // ghost so the AI suggestion isn't silently lost after dismissing the bubble.
  editor.onDidFocusEditorText(() => {
    if (!aiEnabled || !aiProviderFn) return;
    const model = editor.getModel();
    if (!model) return;
    const pos = editor.getPosition();
    if (!pos) return;
    const prefix = model.getValue().slice(0, model.getOffsetAt(pos));
    if (!prefix.trim()) return;
    setTimeout(() => {
      if (!aiEnabled) return;
      editor.trigger("ai", "editor.action.inlineSuggest.trigger", {});
    }, 150);
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
      failedColTables.clear();
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
      monaco.editor.setTheme(dark ? "cq-dark" : "cq-light");
    },
    setAiComplete(
      enabled: boolean,
      provider?: (prefix: string) => Promise<string | null>
    ): void {
      aiEnabled = enabled;
      if (provider) aiProviderFn = provider;
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
      // Monaco's selection is internal (not a DOM selection), so
      // document.execCommand("copy") copies nothing — write explicitly.
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (sel && model && !sel.isEmpty()) {
        void navigator.clipboard.writeText(model.getValueInRange(sel));
      }
    },
    cut() {
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (sel && model && !sel.isEmpty()) {
        void navigator.clipboard.writeText(model.getValueInRange(sel));
        editor.executeEdits("cut", [{ range: sel, text: "" }]);
      }
      editor.focus();
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
