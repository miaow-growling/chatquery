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
  snippet,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { oneDark } from "@codemirror/theme-one-dark";
import { format as formatSqlText, type SqlLanguage } from "sql-formatter";
import type { ColumnInfo, ForeignKeyInfo, TableMeta } from "./types";
import { api } from "./api";

/// Common MySQL builtin functions with signatures and short descriptions.
/// Shown instantly with `type: "function"` and boost when appropriate.
const MYSQL_FUNCTIONS: readonly Completion[] = [
  // Aggregate
  { label: "COUNT", type: "function", detail: "(expr)", info: "统计行数或非空值数量", apply: "COUNT(${1:*})" },
  { label: "SUM", type: "function", detail: "(expr)", info: "求和", apply: "SUM(${1:expr})" },
  { label: "AVG", type: "function", detail: "(expr)", info: "求平均值", apply: "AVG(${1:expr})" },
  { label: "MIN", type: "function", detail: "(expr)", info: "求最小值", apply: "MIN(${1:expr})" },
  { label: "MAX", type: "function", detail: "(expr)", info: "求最大值", apply: "MAX(${1:expr})" },
  { label: "GROUP_CONCAT", type: "function", detail: "(expr [SEPARATOR str])", info: "连接组内的字符串", apply: "GROUP_CONCAT(${1:expr})" },

  // Date & Time
  { label: "NOW", type: "function", detail: "()", info: "当前日期和时间 (YYYY-MM-DD HH:MM:SS)", apply: "NOW()" },
  { label: "CURDATE", type: "function", detail: "()", info: "当前日期 (YYYY-MM-DD)", apply: "CURDATE()" },
  { label: "CURTIME", type: "function", detail: "()", info: "当前时间 (HH:MM:SS)", apply: "CURTIME()" },
  { label: "DATE_FORMAT", type: "function", detail: "(date, format)", info: "按格式格式化日期，如 '%Y-%m-%d %H:%i:%s'", apply: "DATE_FORMAT(${1:date}, '${2:%Y-%m-%d}')" },
  { label: "DATEDIFF", type: "function", detail: "(expr1, expr2)", info: "返回两日期相差的天数 (expr1 - expr2)", apply: "DATEDIFF(${1:expr1}, ${2:expr2})" },
  { label: "DATE_ADD", type: "function", detail: "(date, INTERVAL expr unit)", info: "日期增加，如 INTERVAL 1 DAY", apply: "DATE_ADD(${1:date}, INTERVAL ${2:1} ${3:DAY})" },
  { label: "DATE_SUB", type: "function", detail: "(date, INTERVAL expr unit)", info: "日期减少，如 INTERVAL 1 DAY", apply: "DATE_SUB(${1:date}, INTERVAL ${2:1} ${3:DAY})" },
  { label: "TIMESTAMP", type: "function", detail: "(expr)", info: "转换为时间戳", apply: "TIMESTAMP(${1:expr})" },
  { label: "UNIX_TIMESTAMP", type: "function", detail: "([date])", info: "返回 Unix 时间戳秒数", apply: "UNIX_TIMESTAMP(${1:})" },
  { label: "FROM_UNIXTIME", type: "function", detail: "(unix_timestamp [, format])", info: "Unix 时间戳转日期格式", apply: "FROM_UNIXTIME(${1:timestamp})" },

  // String
  { label: "CONCAT", type: "function", detail: "(str1, str2, ...)", info: "连接多个字符串", apply: "CONCAT(${1:str1}, ${2:str2})" },
  { label: "CONCAT_WS", type: "function", detail: "(separator, str1, str2, ...)", info: "使用指定分隔符连接字符串", apply: "CONCAT_WS('${1:,}', ${2:str1}, ${3:str2})" },
  { label: "SUBSTRING", type: "function", detail: "(str, pos, len)", info: "截取子字符串", apply: "SUBSTRING(${1:str}, ${2:1}, ${3:len})" },
  { label: "LENGTH", type: "function", detail: "(str)", info: "返回字符串字节长度", apply: "LENGTH(${1:str})" },
  { label: "CHAR_LENGTH", type: "function", detail: "(str)", info: "返回字符串字符数", apply: "CHAR_LENGTH(${1:str})" },
  { label: "LOWER", type: "function", detail: "(str)", info: "转换为小写", apply: "LOWER(${1:str})" },
  { label: "UPPER", type: "function", detail: "(str)", info: "转换为大写", apply: "UPPER(${1:str})" },
  { label: "TRIM", type: "function", detail: "(str)", info: "去除首尾空格", apply: "TRIM(${1:str})" },
  { label: "REPLACE", type: "function", detail: "(str, from_str, to_str)", info: "替换字符串", apply: "REPLACE(${1:str}, '${2:from}', '${3:to}')" },
  { label: "LEFT", type: "function", detail: "(str, len)", info: "返回左边指定长度的字符", apply: "LEFT(${1:str}, ${2:len})" },
  { label: "RIGHT", type: "function", detail: "(str, len)", info: "返回右边指定长度的字符", apply: "RIGHT(${1:str}, ${2:len})" },

  // Control Flow & NULL
  { label: "IFNULL", type: "function", detail: "(expr1, expr2)", info: "如果 expr1 为 NULL 则返回 expr2", apply: "IFNULL(${1:expr1}, ${2:default_val})" },
  { label: "COALESCE", type: "function", detail: "(v1, v2, ...)", info: "返回参数列表中第一个非 NULL 值", apply: "COALESCE(${1:v1}, ${2:v2})" },
  { label: "NULLIF", type: "function", detail: "(expr1, expr2)", info: "如果 expr1 = expr2 则返回 NULL", apply: "NULLIF(${1:expr1}, ${2:expr2})" },
  { label: "IF", type: "function", detail: "(expr1, expr2, expr3)", info: "三元判断：expr1 为真返回 expr2，否则 expr3", apply: "IF(${1:condition}, ${2:true_val}, ${3:false_val})" },

  // Numeric
  { label: "ROUND", type: "function", detail: "(num [, decimals])", info: "四舍五入", apply: "ROUND(${1:num}, ${2:2})" },
  { label: "CEIL", type: "function", detail: "(num)", info: "向上取整", apply: "CEIL(${1:num})" },
  { label: "FLOOR", type: "function", detail: "(num)", info: "向下取整", apply: "FLOOR(${1:num})" },
  { label: "ABS", type: "function", detail: "(num)", info: "绝对值", apply: "ABS(${1:num})" },

  // JSON
  { label: "JSON_EXTRACT", type: "function", detail: "(json_doc, path)", info: "提取 JSON 路径对应的值", apply: "JSON_EXTRACT(${1:json_col}, '$.${2:key}')" },
  { label: "JSON_UNQUOTE", type: "function", detail: "(val)", info: "去除 JSON 字符串外层引号", apply: "JSON_UNQUOTE(${1:val})" },
  { label: "JSON_ARRAY", type: "function", detail: "([val, ...])", info: "构造 JSON 数组", apply: "JSON_ARRAY(${1:})" },
  { label: "JSON_OBJECT", type: "function", detail: "(k1, v1, ...)", info: "构造 JSON 对象", apply: "JSON_OBJECT('${1:key}', ${2:val})" },

  // Type Cast & Misc
  { label: "CAST", type: "function", detail: "(expr AS type)", info: "类型转换 (CHAR, SIGNED, DECIMAL, DATETIME...)", apply: "CAST(${1:expr} AS ${2:CHAR})" },
  { label: "DISTINCT", type: "keyword", detail: "关键字", info: "去除重复记录", apply: "DISTINCT " },
  { label: "EXISTS", type: "keyword", detail: "(subquery)", info: "判断子查询是否有结果", apply: "EXISTS (${1:SELECT 1 FROM ...})" },
];

/// Helpful SQL snippets for fast expansion.
const SQL_SNIPPETS: readonly Completion[] = [
  { label: "sel", type: "text", detail: "SELECT * FROM ...", info: "常用查询模板", apply: snippet("SELECT ${1:*} FROM ${2:table} WHERE ${3:1=1} LIMIT ${4:100};") },
  { label: "ins", type: "text", detail: "INSERT INTO ...", info: "插入记录模板", apply: snippet("INSERT INTO ${1:table} (${2:cols}) VALUES (${3:vals});") },
  { label: "upd", type: "text", detail: "UPDATE ... SET ...", info: "更新记录模板", apply: snippet("UPDATE ${1:table} SET ${2:col} = ${3:val} WHERE ${4:id} = ${5:val};") },
  { label: "del", type: "text", detail: "DELETE FROM ...", info: "删除记录模板", apply: snippet("DELETE FROM ${1:table} WHERE ${2:id} = ${3:val};") },
  { label: "join", type: "text", detail: "INNER JOIN ... ON ...", info: "关联查询模板", apply: snippet("INNER JOIN ${1:table} ON ${1:table}.${2:id} = ${3:prev}.${4:fk_id}") },
  { label: "leftjoin", type: "text", detail: "LEFT JOIN ... ON ...", info: "左外连接模板", apply: snippet("LEFT JOIN ${1:table} ON ${1:table}.${2:id} = ${3:prev}.${4:fk_id}") },
];

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
  /// The statement the cursor sits in — or, with an active selection, the
  /// selection expanded outward to the nearest `;` boundaries. Referencing SQL
  /// into the chat must never hand the model half a statement, so this snaps
  /// instead of slicing. Returns "" when the statement is blank.
  getStatement(): string;
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

/// Expand `[from, to)` to the enclosing statement by walking out to the
/// nearest statement terminator on each side.
///
/// Unlike a naive `;` scan, this respects string literals (`'...'`, `"..."`,
/// `` `...` ``), comments (`/* ... */`, `-- `, `#`), and MySQL `DELIMITER`
/// directives — so a `;` inside a string, comment, or stored-procedure body
/// no longer splits the statement early. The failure mode of the old scan
/// (referencing slightly too little) is gone; the new scan may reference
/// slightly too MUCH inside a `DELIMITER` body, which is the safer direction
/// for both chat references and autocomplete context.
/// Split a SQL document into individual statements, respecting string
/// literals, comments, and DELIMITER directives. Empty statements (just
/// whitespace between terminators) are filtered out. Returns the trimmed
/// statement text for each.
export function splitStatements(doc: string): string[] {
  const bounds = statementBounds(doc);
  const out: string[] = [];
  let prev = 0;
  for (const b of bounds) {
    const stmt = doc.slice(prev, b.termStart).trim();
    if (stmt) out.push(stmt);
    prev = b.termEnd;
  }
  // Trailing text after the last terminator (no trailing `;`).
  const tail = doc.slice(prev).trim();
  if (tail) out.push(tail);
  return out;
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
      // Multi-char delimiters ($$ / // / …) are INCLUDED so a stored-procedure
      // body ending in `END $$` stays a complete, runnable statement. The common
      // single `;` is excluded for a cleaner chat reference.
      end = b.len > 1 ? b.termEnd : b.termStart;
      break;
    }
  }
  // A `DELIMITER X` client directive is not server SQL. When it lands at the
  // head of a statement (e.g. just before a `CREATE PROCEDURE` using $$), drop
  // it so the reference is a runnable statement, not a client-script fragment.
  const head = doc.slice(start, end);
  const dm = head.match(/^\s*DELIMITER\s+\S+[^\S\r\n]*\r?\n?/i);
  if (dm) start += dm[0].length;
  return [start, Math.max(start, end)];
}

interface StatementBound {
  /// Index of the terminator's first char (exclusive end of the statement when
  /// the delimiter is the single `;`).
  termStart: number;
  /// Index just past the terminator.
  termEnd: number;
  /// Length of the terminator (1 for `;`, >1 for `$$`/`//`/…). Multi-char
  /// delimiters are kept INCLUDED in the returned statement so a stored-proc
  /// body like `END $$` stays complete and runnable.
  len: number;
}

/// Scan `doc` for every statement terminator, tracking MySQL `DELIMITER`
/// directives so a procedure body using `$$` (or `//`) as its terminator is
/// handled. String literals and comments are skipped so their content can
/// never be mistaken for a terminator.
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
    // --- string literals + quoted identifiers ---
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
        // backslash escape inside '...' and "..." (not in `...` identifiers)
        if (q !== "`" && doc[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    // --- block comment ---
    if (c === "/" && doc[i + 1] === "*") {
      const close = doc.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    // --- line comments: `-- ` (with a space) and `#` ---
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
    // --- DELIMITER directive: switches the terminator for following statements ---
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
    // --- terminator ---
    if (doc.startsWith(delim, i)) {
      bounds.push({ termStart: i, termEnd: i + delim.length, len: delim.length });
      i += delim.length;
      continue;
    }
    i++;
  }
  return bounds;
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

  // --- Fast In-Memory + LRU Schema Completion ---
  // Tables for the active DB are eagerly prefetched in the background when the
  // context switches. When typing, table completion runs 100% locally from
  // memory with 0ms latency. Columns for referenced tables are fetched
  // on-demand and kept in an LRU cache (capped to MAX_CACHED_TABLE_COLUMNS).
  let ctxConnId: string | null = null;
  let ctxDb: string | null = null;
  let prefetchedTables: TableMeta[] = [];
  let isPrefetchingTables = false;

  const MAX_CACHED_TABLE_COLUMNS = 80;
  // Map keeps insertion order; oldest entries evicted when size exceeds limit.
  const colLruCache = new Map<string, ColumnInfo[]>();
  let fkCache = new Map<string, ForeignKeyInfo[]>();

  const getCachedCols = (table: string): ColumnInfo[] | undefined => {
    const key = table.toLowerCase();
    const cols = colLruCache.get(key);
    if (cols) {
      // Refresh LRU order: delete & re-insert
      colLruCache.delete(key);
      colLruCache.set(key, cols);
    }
    return cols;
  };

  const setCachedCols = (table: string, cols: ColumnInfo[]) => {
    const key = table.toLowerCase();
    if (colLruCache.has(key)) colLruCache.delete(key);
    colLruCache.set(key, cols);
    if (colLruCache.size > MAX_CACHED_TABLE_COLUMNS) {
      const oldestKey = colLruCache.keys().next().value;
      if (oldestKey) colLruCache.delete(oldestKey);
    }
  };

  // Background table prefetch: grabs up to 3000 table names for current DB.
  // Typical schema payload is <100KB, making completions instantaneous.
  const prefetchTables = async (connId: string, db: string) => {
    if (isPrefetchingTables) return;
    isPrefetchingTables = true;
    try {
      const tables = await api.searchTables(connId, db, null, 3000);
      if (ctxConnId === connId && ctxDb === db) {
        prefetchedTables = tables;
      }
    } catch {
      // Ignored: autocomplete will fall back to lazy API query if needed
    } finally {
      isPrefetchingTables = false;
    }
  };

  // Enhanced multi-statement FROM / JOIN / UPDATE / INSERT / DELETE scanner.
  // Extracts an (alias -> real table) map so autocomplete can suggest columns of
  // the tables the user is actually querying. Handles aliases, backticks,
  // UPDATE t1 AS a, INSERT INTO t1, DELETE FROM t1, etc.
  function parseFromTables(sql: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!sql.trim()) return map;

    // Pattern 1: FROM or JOIN table [[AS] alias]
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
        // Also map the real table name so both `alias.col` and `table.col` resolve
        if (!map.has(tableName.toLowerCase())) map.set(tableName.toLowerCase(), tableName);
      }
    }

    // Pattern 2: UPDATE table [[AS] alias] SET ...
    const updateRe = /\bUPDATE\s+([`"]?[A-Za-z0-9_]+[`"]?(?:\.[`"]?[A-Za-z0-9_]+[`"]?)?)\s*(?:AS\s+)?([`"]?[A-Za-z0-9_]+[`"]?)?/gi;
    while ((m = updateRe.exec(sql))) {
      const rawTable = m[1].replace(/[`"]/g, "");
      const tableName = rawTable.includes(".") ? rawTable.split(".")[1] : rawTable;
      const alias = m[2] ? m[2].replace(/[`"]/g, "") : undefined;
      const key = (alias ?? tableName).toLowerCase();
      if (!map.has(key)) map.set(key, tableName);
      if (!map.has(tableName.toLowerCase())) map.set(tableName.toLowerCase(), tableName);
    }

    // Pattern 3: INSERT INTO table or DELETE FROM table
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

  /// Build a human-readable detail string for a column completion option.
  /// Shows type + PK indicator + origin table (when provided) + comment.
  function colDetail(c: ColumnInfo, table?: string): string {
    const pk = c.key === "PRI" ? "🔑 " : "";
    const parts = [`${pk}${c.data_type}`];
    if (table) parts.push(table);
    return parts.join(" · ");
  }

  /// Fetch and cache foreign-key relationships for a database.
  async function getFks(connId: string, db: string): Promise<ForeignKeyInfo[]> {
    const cached = fkCache.get(db);
    if (cached) return cached;
    try {
      const fks = await api.listRelationships(connId, db);
      fkCache.set(db, fks);
      return fks;
    } catch {
      return [];
    }
  }

  /// Find FK relationships that link any of `knownTables` to other tables.
  function findJoinSuggestions(
    fks: ForeignKeyInfo[],
    knownTables: string[]
  ): { table: string; column: string; refTable: string; refColumn: string }[] {
    const known = new Set(knownTables.map((t) => t.toLowerCase()));
    const out: { table: string; column: string; refTable: string; refColumn: string }[] = [];
    const seen = new Set<string>();
    for (const fk of fks) {
      if (known.has(fk.table_name.toLowerCase()) && !known.has(fk.referenced_table.toLowerCase())) {
        const key = `${fk.table_name}.${fk.referenced_table}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            table: fk.table_name,
            column: fk.column_name,
            refTable: fk.referenced_table,
            refColumn: fk.referenced_column,
          });
        }
      }
      if (known.has(fk.referenced_table.toLowerCase()) && !known.has(fk.table_name.toLowerCase())) {
        const key = `${fk.referenced_table}.${fk.table_name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            table: fk.referenced_table,
            column: fk.referenced_column,
            refTable: fk.table_name,
            refColumn: fk.column_name,
          });
        }
      }
    }
    return out;
  }

  const schemaCompleter: CompletionSource = async (context) => {
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

    // Scan statement for table references
    const docText = context.state.doc.toString();
    const [stmtStart, stmtEnd] = statementRange(docText, from, from);
    const statementText = docText.slice(stmtStart, stmtEnd);
    const tablesMap = parseFromTables(statementText);

    const preWord = word ? before.slice(0, word.from) : before;
    const inTablePos = /\b(FROM|JOIN|INTO|TABLE|UPDATE)\s+[\w`]*$/i.test(before) || /\b(FROM|JOIN|INTO|TABLE|UPDATE)\s*$/i.test(preWord);
    const isJoinPos = /\bJOIN\s+[\w`]*$/i.test(before) || /\bJOIN\s*$/i.test(preWord);

    // Helper to get columns for a table (from local LRU or fetch)
    const loadTableCols = async (t: string): Promise<ColumnInfo[]> => {
      let cols = getCachedCols(t);
      if (!cols) {
        try {
          cols = await api.listColumns(connId, db, t);
        } catch {
          cols = [];
        }
        setCachedCols(t, cols);
      }
      return cols;
    };

    // Helper to get matching tables from in-memory prefetched list
    const getMatchingTables = async (pfx: string): Promise<TableMeta[]> => {
      if (prefetchedTables.length > 0) {
        const lp = pfx.toLowerCase();
        return lp
          ? prefetchedTables.filter((t) => t.name.toLowerCase().startsWith(lp) || t.name.toLowerCase().includes(lp))
          : prefetchedTables;
      }
      // Fallback if prefetch hasn't finished yet
      try {
        const tables = await api.searchTables(connId, db, pfx || null, 200);
        return tables;
      } catch {
        return [];
      }
    };

    // 1) `alias.` / `table.` column completion (highest priority, boosted)
    const colMatch = before.match(/([A-Za-z0-9_`]+)\.\s*$/);
    if (colMatch) {
      const ref = colMatch[1].replace(/[`"]/g, "");
      const realTable = tablesMap.get(ref.toLowerCase()) ?? ref;
      const cols = await loadTableCols(realTable);
      const options = cols
        .filter((c) => !lowerPrefix || c.name.toLowerCase().startsWith(lowerPrefix) || c.name.toLowerCase().includes(lowerPrefix))
        .map(
          (c): Completion => ({
            label: c.name,
            type: c.key === "PRI" ? "keyword" : "property",
            boost: c.key === "PRI" ? 99 : 90,
            detail: colDetail(c),
            info: c.comment || undefined,
          })
        );
      return { from, options, validFor: /^[\w`]*$/ };
    }

    const completions: Completion[] = [];

    // 2) If in table position (FROM/JOIN/INTO/UPDATE): prioritize table names
    if (inTablePos) {
      // FK-driven JOIN suggestions
      if (isJoinPos && tablesMap.size > 0) {
        const fks = await getFks(connId, db);
        const knownTables = Array.from(new Set(tablesMap.values()));
        const joinSugs = findJoinSuggestions(fks, knownTables);
        for (const s of joinSugs) {
          const onClause = `${s.refTable} ON ${s.refTable}.${s.refColumn} = ${s.table}.${s.column}`;
          completions.push({
            label: s.refTable,
            type: "variable",
            boost: 98,
            detail: `🔗 ${s.table}.${s.column} → ${s.refTable}.${s.refColumn}`,
            apply: onClause,
          });
        }
      }

      const tables = await getMatchingTables(lowerPrefix);
      const fkLabels = new Set(completions.map((t) => t.label.toLowerCase()));
      for (const t of tables) {
        if (fkLabels.has(t.name.toLowerCase())) continue;
        completions.push({
          label: t.name,
          type: t.is_view ? "interface" : "class",
          boost: 90,
          detail: t.is_view ? "view" : "table",
        });
      }

      // Allow snippets when typing at line beginning or table position
      if (lowerPrefix) {
        for (const s of SQL_SNIPPETS) {
          if (s.label.startsWith(lowerPrefix)) completions.push({ ...s, boost: 30 });
        }
      }

      return { from, options: completions, validFor: /^[\w`]*$/ };
    }

    // 3) Normal clause position (SELECT, WHERE, GROUP BY, etc.)
    // A) If statement contains tables, suggest columns of those tables first (SUPER BOOST)
    if (tablesMap.size > 0) {
      const distinctTables = Array.from(new Set(tablesMap.values()));
      const colPromises = distinctTables.map(async (t) => {
        const cols = await loadTableCols(t);
        return cols.map((c) => ({ c, t }));
      });
      const allCols = (await Promise.all(colPromises)).flat();
      const seenCol = new Set<string>();

      for (const { c, t } of allCols) {
        const cl = c.name.toLowerCase();
        if (seenCol.has(cl)) continue;
        seenCol.add(cl);
        if (lowerPrefix && !cl.startsWith(lowerPrefix) && !cl.includes(lowerPrefix)) continue;
        const isPrefixMatch = lowerPrefix && cl.startsWith(lowerPrefix);
        completions.push({
          label: c.name,
          type: c.key === "PRI" ? "keyword" : "property",
          boost: c.key === "PRI" ? (isPrefixMatch ? 99 : 85) : (isPrefixMatch ? 95 : 80),
          detail: colDetail(c, t),
          info: c.comment || undefined,
        });
      }
    } else {
      // If no tables referenced yet (e.g. typing SELECT col before FROM), suggest columns from ALL prefetched tables
      if (prefetchedTables.length > 0) {
        const sampleTables = prefetchedTables.slice(0, 10);
        const colPromises = sampleTables.map(async (t) => {
          const cols = await loadTableCols(t.name);
          return cols.map((c) => ({ c, t: t.name }));
        });
        const allCols = (await Promise.all(colPromises)).flat();
        const seenCol = new Set<string>();
        for (const { c, t } of allCols) {
          const cl = c.name.toLowerCase();
          if (seenCol.has(cl)) continue;
          seenCol.add(cl);
          if (lowerPrefix && !cl.startsWith(lowerPrefix) && !cl.includes(lowerPrefix)) continue;
          completions.push({
            label: c.name,
            type: c.key === "PRI" ? "keyword" : "property",
            boost: c.key === "PRI" ? 75 : 70,
            detail: colDetail(c, t),
            info: c.comment || undefined,
          });
        }
      }
    }

    // B) Builtin Functions (boost: 10)
    if (lowerPrefix.length >= 1) {
      for (const fn of MYSQL_FUNCTIONS) {
        if (fn.label.toLowerCase().startsWith(lowerPrefix)) {
          completions.push({ ...fn, boost: 10 });
        }
      }
    }

    // C) SQL Snippets (boost: 5)
    if (lowerPrefix.length >= 1) {
      for (const snip of SQL_SNIPPETS) {
        if (snip.label.toLowerCase().startsWith(lowerPrefix)) {
          completions.push({ ...snip, boost: 5 });
        }
      }
    }

    // D) If no tables were extracted from current statement, fall back to suggesting all tables
    if (tablesMap.size === 0) {
      const tables = await getMatchingTables(lowerPrefix);
      for (const t of tables) {
        completions.push({
          label: t.name,
          type: t.is_view ? "interface" : "class",
          boost: 50,
          detail: t.is_view ? "view" : "table",
        });
      }
    }

    return { from, options: completions, validFor: /^[\w`]*$/ };
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
      autocompletion({
        activateOnTyping: true,
        maxRenderedOptions: 50,
        defaultKeymap: true,
        closeOnBlur: true,
      }),
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
      prefetchedTables = [];
      colLruCache.clear();
      fkCache.clear();
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
    getStatement() {
      const { from, to } = view.state.selection.main;
      const doc = view.state.doc.toString();
      const [s, e] = statementRange(doc, from, to);
      return doc.slice(s, e).trim();
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
