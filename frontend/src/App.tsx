import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  chatTurn,
  onChatDone,
  onChatError,
  onChatToken,
  onChatTool,
} from "./api";
import type {
  ChatMessage,
  ConnInput,
  ConnSummary,
  ForeignKeyInfo,
  QueryItem,
  QueryOutput,
  Schema,
  StatusInfo,
  TableStructure,
  TreeModel,
} from "./types";
import { createEditor, type EditorHandle } from "./editor";
import { Tree } from "./Tree";

interface ConnForm {
  open: boolean;
  editing: boolean;
  cfg: ConnInput;
}

/// Rows per page when browsing a table (kept in sync with the backend PAGE_LIMIT).
const PAGE_SIZE = 200;

interface BrowseCtx {
  connId: string;
  db: string;
  table: string;
  page: number;
  pageSize: number;
}

/// A query editor tab. Each tab keeps its own SQL text, last result, and
/// browse context so switching tabs never loses work.
interface QueryTab {
  id: string;
  name: string;
  sql: string;
  result: QueryOutput | null;
  browseCtx: BrowseCtx | null;
}

const genTabId = () => "t" + Math.random().toString(36).slice(2, 9);
const INITIAL_TAB = "t1";

const emptyForm = (): ConnInput => ({
  id: "",
  name: "",
  db_type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "",
  password: "",
  database: "",
  group_id: null,
});

/// Build an error "result" the UI already knows how to render (redis variant
/// just shows `note` as a message line).
const errOut = (msg: string): QueryOutput => ({
  kind: "redis",
  command: "",
  lines: [],
  note: msg,
  truncated: false,
});

export function App() {
  const [tree, setTree] = useState<TreeModel>({ environments: [] });
  const [selId, setSelId] = useState<string>("");
  const [status, setStatus] = useState<StatusInfo>({
    llm_enabled: false,
    mask_enabled: true,
  });
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [form, setForm] = useState<ConnForm>({
    open: false,
    editing: false,
    cfg: emptyForm(),
  });
  const [addOpen, setAddOpen] = useState(false);
  const addWrapRef = useRef<HTMLDivElement | null>(null);

  // --- Query tabs -----------------------------------------------------------
  const [tabs, setTabs] = useState<QueryTab[]>([
    { id: INITIAL_TAB, name: "查询 1", sql: "", result: null, browseCtx: null },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_TAB);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<QueryItem[]>([]);

  const editorRef = useRef<EditorHandle | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // --- Inline cell editing (ADR-018) + INSERT/DELETE (ADR-019) ------------
  // `edits` is an overlay keyed by row index -> column index -> new value.
  // The underlying `result.rows` always holds the DB snapshot, so locating a
  // row for writes uses the original primary-key values, never the edited ones.
  const [edits, setEdits] = useState<Record<number, Record<number, string>>>({});
  // Row indices marked for deletion. The row is still displayed (struck-through)
  // until "保存修改" commits the DELETE.
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  // Pending insert rows. Each entry is a column-index -> value map. Cells left
  // empty are omitted from the INSERT so DB defaults (AUTO_INCREMENT etc) apply.
  const [inserts, setInserts] = useState<Record<number, string>[]>([]);
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(null);
  const [draft, setDraft] = useState("");

  // --- Table structure view (ADR-020) --------------------------------------
  // When set, the result panel renders a structure view (columns, indexes,
  // DDL) instead of the data grid. Cleared on tab switch, new query, browse.
  const [structureView, setStructureView] =
    useState<{ connId: string; db: string; table: string; data: TableStructure } | null>(null);

  // --- Table relationship view (ER simplified, ADR-021) -------------------
  // When set, the result panel shows a list of foreign-key relationships for
  // the entire database (not just one table). Cleared alongside other views.
  const [relationshipView, setRelationshipView] =
    useState<{ connId: string; db: string; fks: ForeignKeyInfo[] } | null>(null);

  // --- Result sub-tabs (Phase 18) -----------------------------------------
  // Unifies the three result-panel views behind a Chat2DB-style tab strip:
  // "data" (grid) | "structure" (columns/indexes/DDL) | "relation" (FK map).
  // Structure/relation data live in the *_View states above; this just picks
  // which one the body renders.
  const [resultTab, setResultTab] = useState<"data" | "structure" | "relation">("data");

  // --- Bottom status bar / console (Phase 18) -----------------------------
  // Last operation feedback: timing, affected/returned rows, errors. Replaces
  // the old "run and hope" silence — DBeaver/TablePlus/DataGrip all have one.
  const [runInfo, setRunInfo] = useState<{ kind: "ok" | "err" | "warn" | "info"; text: string } | null>(null);

  // --- Collapsible AI panel + theme (Phase 18) ----------------------------
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    const v = localStorage.getItem("cq_chat_open");
    return v === null ? true : v === "1";
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const v = localStorage.getItem("cq_theme");
    return v === "light" ? "light" : "dark";
  });

  /// Clear all edit overlays (edits + deletes + inserts + active cell). Called
  /// on tab switch, re-query, page change, save, and undo.
  const clearEditState = useCallback(() => {
    setEdits({});
    setDeletes(new Set());
    setInserts([]);
    setEditing(null);
    setStructureView(null);
    setRelationshipView(null);
    setResultTab("data");
  }, []);

  // Apply the chosen theme to <html> (CSS variables) and the CodeMirror editor,
  // persisting it so a reload keeps the user's preference. Runs on mount too,
  // so the editor starts in the stored theme instead of flashing.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cq_theme", theme);
    editorRef.current?.setTheme(theme === "dark");
  }, [theme]);

  // Derived active-tab view of result + browse context (used by the pager and
  // the result renderer — keeps those unchanged).
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const result = active?.result ?? null;
  const browseCtx = active?.browseCtx ?? null;

  // Only a browse result over a table with a primary key is editable. Arbitrary
  // SQL output (no stable row identity) and Redis results are read-only.
  const editable =
    !!browseCtx &&
    result?.kind === "table" &&
    (result.primaryKeys?.length ?? 0) > 0;
  const hasEdits =
    Object.keys(edits).length > 0 || deletes.size > 0 || inserts.length > 0;

  // Flat lookup of connections across the tree model.
  const findConn = useCallback(
    (id: string): ConnSummary | undefined => {
      for (const env of tree.environments) {
        for (const g of env.groups) {
          const hit = g.connections.find((c) => c.id === id);
          if (hit) return hit;
        }
      }
      return undefined;
    },
    [tree]
  );

  const setActiveTab = (updater: (t: QueryTab) => QueryTab) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabIdRef.current ? updater(t) : t))
    );
  };

  const refresh = useCallback(async () => {
    const t = await api.listTree();
    setTree(t);
    if (!selId) {
      const first = t.environments[0]?.groups[0]?.connections[0];
      if (first) setSelId(first.id);
    }
  }, [selId]);

  const loadSchema = useCallback(
    async (id: string) => {
      const conn = findConn(id);
      if (!conn || conn.db_type !== "mysql") {
        editorRef.current?.setSchema({ tables: [] });
        return;
      }
      try {
        const schema: Schema = await api.getSchema(id);
        editorRef.current?.setSchema(schema);
      } catch (e) {
        console.error("load schema failed", e);
      }
    },
    [findConn]
  );

  // Build a status-bar entry from a finished query result + elapsed ms.
  // Errors arrive as a `redis` result with `note` set (errOut), so we detect
  // them by runtime shape, not by a separate type union.
  const runStatFor = (
    r: QueryOutput | null,
    ms: number
  ): { kind: "ok" | "err" | "warn" | "info"; text: string } => {
    if (!r) return { kind: "ok", text: `✓ ${ms}ms · 执行完成` };
    if ("rows" in r) {
      const n = r.rows.length;
      const trunc = "truncated" in r && r.truncated;
      return {
        kind: trunc ? "warn" : "ok",
        text: `✓ ${ms}ms · 返回 ${n} 行${trunc ? " (已截断, 请加 LIMIT)" : ""}`,
      };
    }
    if (r.kind === "redis") {
      if (r.note) return { kind: "err", text: `✗ ${ms}ms · ${r.note}` };
      return { kind: "ok", text: `✓ ${ms}ms · Redis 结果` };
    }
    return { kind: "ok", text: `✓ ${ms}ms · 执行完成` };
  };

  const runQuery = useCallback(async () => {
    if (!selId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = sel || editor.getDoc();
    if (!q.trim()) return;
    clearEditState();
    setResultTab("data");
    const t0 = performance.now();
    try {
      const r = await api.executeQuery(selId, q);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((t) => ({ ...t, result: r, browseCtx: null }));
      void api.logQuery(selId, null, q);
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    }
  }, [selId]);

  // Keep a live ref so the editor's run-key (registered once) always calls the
  // latest `runQuery` closure with the current selected connection.
  const runQueryRef = useRef<() => void>(() => {});
  runQueryRef.current = runQuery;

  const explainQuery = useCallback(async () => {
    if (!selId) return;
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = sel || editor.getDoc();
    if (!q.trim()) return;
    clearEditState();
    setResultTab("data");
    const t0 = performance.now();
    try {
      const r = await api.explainQuery(selId, q);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((t) => ({ ...t, result: r, browseCtx: null }));
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    }
  }, [selId]);

  const selectConn = (id: string) => {
    setSelId(id);
    void loadSchema(id);
  };

  const browseTable = useCallback(
    async (
      connId: string,
      db: string,
      table: string,
      page: number = 0,
      pageSize: number = PAGE_SIZE
    ) => {
      clearEditState();
      setResultTab("data");
      const t0 = performance.now();
      try {
        const r = await api.browseTable(connId, db, table, page, pageSize);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({
          ...t,
          result: r,
          browseCtx: { connId, db, table, page, pageSize },
        }));
        setRunInfo(runStatFor(r, ms));
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
        setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
      }
    },
    []
  );

  // Pager navigation for table browse results.
  const goPage = (p: number) => {
    if (!browseCtx || !result || result.kind !== "table" || result.total == null) return;
    const totalPages = Math.max(1, Math.ceil(result.total / browseCtx.pageSize));
    const np = Math.min(Math.max(0, p), totalPages - 1);
    void browseTable(browseCtx.connId, browseCtx.db, browseCtx.table, np, browseCtx.pageSize);
  };

  const pager =
    browseCtx && result && result.kind === "table" && result.total != null ? (
      (() => {
        const totalPages = Math.max(1, Math.ceil(result.total / browseCtx.pageSize));
        const cur = result.page ?? browseCtx.page;
        return (
          <div className="pager">
            <button disabled={cur <= 0} onClick={() => goPage(cur - 1)}>
              上一页
            </button>
            <span className="pager-info">
              第 {cur + 1} / {totalPages} 页 · 共 {result.total} 行
            </span>
            <button disabled={cur + 1 >= totalPages} onClick={() => goPage(cur + 1)}>
              下一页
            </button>
          </div>
        );
      })()
    ) : null;

  const browseRedisKey = useCallback(
    async (connId: string, db: number, key: string) => {
      clearEditState();
      setResultTab("data");
      const t0 = performance.now();
      try {
        const r = await api.browseRedisKey(connId, db, key);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: r, browseCtx: null }));
        setRunInfo(runStatFor(r, ms));
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
        setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
      }
    },
    []
  );

  // Fetch and display the full table structure (columns, indexes, DDL) in
  // the result panel. Replaces the data grid view until the user navigates
  // away (browse/query/tab switch all clear it via clearEditState).
  const showStructure = useCallback(
    async (connId: string, db: string, table: string) => {
      clearEditState();
      try {
        const data = await api.describeTable(connId, db, table);
        setStructureView({ connId, db, table, data });
        setResultTab("structure");
      } catch (e) {
        // Keep the data grid; surface the failure in the status bar instead of
        // blowing away the result panel.
        setRunInfo({ kind: "err", text: "加载表结构失败: " + String(e) });
      }
    },
    []
  );

  // Fetch and display all FK relationships in a database (ADR-021). Shows a
  // table of child→parent column mappings grouped by constraint name.
  const showRelationships = useCallback(
    async (connId: string, db: string) => {
      clearEditState();
      try {
        const fks = await api.listRelationships(connId, db);
        setRelationshipView({ connId, db, fks });
        setResultTab("relation");
      } catch (e) {
        setRunInfo({ kind: "err", text: "加载表关系失败: " + String(e) });
      }
    },
    []
  );

  // Result-sub-tab navigation: switch to a view, fetching its data lazily from
  // the currently browsed table when the cached view is absent.
  const gotoStructure = () => {
    if (structureView) {
      setResultTab("structure");
      return;
    }
    if (browseCtx) void showStructure(browseCtx.connId, browseCtx.db, browseCtx.table);
  };
  const gotoRelation = () => {
    if (relationshipView) {
      setResultTab("relation");
      return;
    }
    if (browseCtx) void showRelationships(browseCtx.connId, browseCtx.db);
  };

  // --- Inline edit handlers (ADR-018) --------------------------------------
  // Commit the in-progress cell edit into the `edits` overlay. The displayed
  // value falls back to the DB snapshot when no overlay entry exists, so the
  // WHERE clause always uses original primary-key values.
  const commitCell = () => {
    if (!editing) return;
    setEdits((prev) => {
      const row = { ...(prev[editing.ri] ?? {}) };
      row[editing.ci] = draft;
      return { ...prev, [editing.ri]: row };
    });
    setEditing(null);
  };

  // Persist all pending changes: UPDATEs (edits minus deleted rows), INSERTs
  // (new rows), then DELETEs (marked rows). Order matters: skip edits on rows
  // that are also marked for deletion — there's no point updating a row we're
  // about to delete. Any failure stops and keeps the overlays so the user can
  // fix and retry.
  const handleSaveEdit = async () => {
    if (!browseCtx || !result || result.kind !== "table" || !result.primaryKeys) return;
    const pkIdx = result.primaryKeys
      .map((pk) => result.columns.indexOf(pk))
      .filter((i) => i >= 0);
    try {
      // 1. UPDATEs — skip rows also marked for deletion.
      for (const riStr of Object.keys(edits)) {
        const ri = Number(riStr);
        if (deletes.has(ri)) continue;
        const row = result.rows[ri];
        if (!row) continue;
        const pk = pkIdx.map((ci) => ({ col: result.columns[ci], val: row[ci] }));
        const set = Object.entries(edits[ri]).map(([ciStr, v]) => ({
          col: result.columns[Number(ciStr)],
          val: v,
        }));
        if (set.length === 0) continue;
        await api.applyEdit({
          connId: browseCtx.connId,
          database: browseCtx.db,
          table: browseCtx.table,
          pk,
          set,
        });
      }
      // 2. INSERTs — omit empty cells so DB defaults apply.
      for (const insertRow of inserts) {
        const values = Object.entries(insertRow)
          .map(([ciStr, v]) => ({ col: result.columns[Number(ciStr)], val: v }))
          .filter((v) => v.val !== "");
        if (values.length === 0) continue;
        await api.insertRow(
          browseCtx.connId,
          browseCtx.db,
          browseCtx.table,
          values
        );
      }
      // 3. DELETEs — locate by original PK snapshot.
      for (const ri of deletes) {
        const row = result.rows[ri];
        if (!row) continue;
        const pk = pkIdx.map((ci) => ({ col: result.columns[ci], val: row[ci] }));
        await api.deleteRow(browseCtx.connId, browseCtx.db, browseCtx.table, pk);
      }
      clearEditState();
      await browseTable(
        browseCtx.connId,
        browseCtx.db,
        browseCtx.table,
        browseCtx.page,
        browseCtx.pageSize
      );
    } catch (e) {
      alert("保存失败: " + String(e));
    }
  };

  const handleUndoEdit = () => clearEditState();

  // Toggle a row's deletion mark. A row marked for deletion is struck-through
  // and excluded from UPDATEs at save time.
  const toggleDelete = (ri: number) => {
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
  };

  // Append a blank insert row. The user fills in cells; empty cells are omitted
  // from the eventual INSERT so DB defaults (AUTO_INCREMENT etc) apply.
  const addInsertRow = () => {
    setInserts((prev) => [...prev, {}]);
  };

  // Remove a pending insert row (before it's committed).
  const removeInsertRow = (ii: number) => {
    setInserts((prev) => prev.filter((_, i) => i !== ii));
  };

  // Update a cell in a pending insert row.
  const setInsertCell = (ii: number, ci: number, val: string) => {
    setInserts((prev) => {
      const next = [...prev];
      next[ii] = { ...(next[ii] ?? {}), [ci]: val };
      return next;
    });
  };

  // Render the result grid. When `editable`, cells become double-click-to-edit
  // with dirty highlighting; rows get a delete toggle; and a "new row" is
  // appended at the bottom for INSERT. Otherwise it's a plain read-only table
  // (or Redis lines). Primary-key columns are tagged with a key glyph.
  const renderData = () => {
    if (!result) return <div className="empty">执行查询以查看结果</div>;
    if (result.kind === "redis") {
      return (
        <div className="redis-result">
          {result.lines.map((l, i) => (
            <div key={i} className="redis-line">
              {l}
            </div>
          ))}
          {result.note && <div className="redis-note">{result.note}</div>}
        </div>
      );
    }
    if (result.columns.length === 0) return <div className="empty">无结果集</div>;
    const pkSet = new Set(result.primaryKeys ?? []);
    return (
      <table className="result-table">
        <thead>
          <tr>
            {editable && <th className="row-action-col" />}
            {result.columns.map((c, i) => (
              <th key={i} className={pkSet.has(c) ? "pk" : ""}>
                {c}
                {pkSet.has(c) ? " 🔑" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => {
            const isDeleted = deletes.has(ri);
            return (
              <tr key={ri} className={isDeleted ? "row-deleted" : ""}>
                {editable && (
                  <td className="row-action-col">
                    <button
                      className="row-del-btn"
                      title={isDeleted ? "取消删除" : "标记删除"}
                      onClick={() => toggleDelete(ri)}
                    >
                      {isDeleted ? "↩" : "×"}
                    </button>
                  </td>
                )}
                {row.map((v, ci) => {
                  const ov = edits[ri]?.[ci];
                  const isEditing =
                    editing?.ri === ri && editing?.ci === ci && !isDeleted;
                  return (
                    <td
                      key={ci}
                      className={
                        (ov !== undefined ? "dirty " : "") +
                        (editable && !isDeleted ? "editable" : "")
                      }
                      title={editable && !isDeleted ? "双击编辑单元格" : undefined}
                      onDoubleClick={() => {
                        if (!editable || isDeleted) return;
                        setEditing({ ri, ci });
                        setDraft(v);
                      }}
                    >
                      {isEditing ? (
                        <input
                          className="cell-edit"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitCell}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCell();
                            else if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        ov ?? v
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {inserts.map((ins, ii) => (
            <tr key={"ins-" + ii} className="row-insert">
              <td className="row-action-col">
                <button
                  className="row-del-btn"
                  title="移除新增行"
                  onClick={() => removeInsertRow(ii)}
                >
                  ×
                </button>
              </td>
              {result.columns.map((_, ci) => (
                <td key={ci} className="insert-cell">
                  <input
                    className="cell-edit"
                    placeholder="—"
                    value={ins[ci] ?? ""}
                    onChange={(e) => setInsertCell(ii, ci, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  // Render the table structure view (ADR-020): a columns table (like
  // DESCRIBE), an indexes table (grouped by index name), and the DDL in a
  // scrollable <pre>. Shown in place of the data grid when `structureView`
  // is set.
  const renderStructure = () => {
    if (!structureView) return null;
    const { data, db, table } = structureView;

    // Group index entries by index name — SHOW INDEX returns one row per
    // (index, column), so we aggregate columns and preserve uniqueness.
    const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
    for (const idx of data.indexes) {
      const e = idxMap.get(idx.name) ?? { columns: [], unique: idx.unique };
      e.columns.push(idx.column);
      idxMap.set(idx.name, e);
    }

    return (
      <div className="structure-view">
        <table className="result-table struct-table">
          <caption>{db}.{table} — 列结构</caption>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Null</th>
              <th>Key</th>
              <th>Default</th>
              <th>Extra</th>
            </tr>
          </thead>
          <tbody>
            {data.columns.map((c, i) => (
              <tr key={i}>
                <td className="col-name">{c.name}</td>
                <td className="col-type">{c.column_type}</td>
                <td>{c.nullable ? "YES" : "NO"}</td>
                <td>{c.key || "—"}</td>
                <td>{c.default ?? "—"}</td>
                <td>{c.extra || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {idxMap.size > 0 && (
          <table className="result-table struct-table">
            <caption>索引</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
              </tr>
            </thead>
            <tbody>
              {[...idxMap.entries()].map(([name, e]) => (
                <tr key={name}>
                  <td className="col-name">{name}</td>
                  <td>{e.columns.join(", ")}</td>
                  <td>{e.unique ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="ddl-section">
          <div className="ddl-head">DDL — SHOW CREATE TABLE</div>
          <pre className="ddl-block">{data.create_sql}</pre>
        </div>
      </div>
    );
  };

  // Render the ER / table-relationship view (ADR-021): a table of all FK
  // constraints in the database, showing child table.column → parent
  // table.column. Grouped by constraint name for readability.
  const renderRelationships = () => {
    if (!relationshipView) return null;
    const { db, fks } = relationshipView;
    if (fks.length === 0) {
      return (
        <div className="structure-view">
          <div className="empty">{db} 中没有外键关系</div>
        </div>
      );
    }
    // Group by constraint name to show composite FKs together.
    const grouped = new Map<string, ForeignKeyInfo[]>();
    for (const fk of fks) {
      const arr = grouped.get(fk.constraint_name) ?? [];
      arr.push(fk);
      grouped.set(fk.constraint_name, arr);
    }
    return (
      <div className="structure-view">
        <table className="result-table struct-table">
          <caption>{db} — 外键关系 ({fks.length} 条)</caption>
          <thead>
            <tr>
              <th>Constraint</th>
              <th>子表</th>
              <th>子列</th>
              <th>→</th>
              <th>父表</th>
              <th>父列</th>
            </tr>
          </thead>
          <tbody>
            {fks.map((fk, i) => (
              <tr key={i}>
                <td className="col-name">{fk.constraint_name}</td>
                <td>{fk.table_name}</td>
                <td>{fk.column_name}</td>
                <td className="fk-arrow">→</td>
                <td>{fk.referenced_table}</td>
                <td>{fk.referenced_column}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const insertColumn = useCallback((name: string) => {
    editorRef.current?.insert(name);
  }, []);

  const insertText = useCallback((text: string) => {
    editorRef.current?.insert(text);
  }, []);

  // --- Tab management -------------------------------------------------------
  const switchTab = (id: string) => {
    if (id === activeTabId) return;
    activeTabIdRef.current = id;
    setActiveTabId(id);
    clearEditState();
    const t = tabs.find((x) => x.id === id);
    if (t) editorRef.current?.replaceValue(t.sql);
  };

  const newTab = () => {
    const id = genTabId();
    const n = tabs.length + 1;
    setTabs((prev) => [
      ...prev,
      { id, name: "查询 " + n, sql: "", result: null, browseCtx: null },
    ]);
    activeTabIdRef.current = id;
    setActiveTabId(id);
    clearEditState();
    editorRef.current?.replaceValue("");
    editorRef.current?.view.focus();
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (id === activeTabId) {
      const next = tabs[idx === 0 ? 1 : idx - 1];
      activeTabIdRef.current = next.id;
      setActiveTabId(next.id);
      clearEditState();
      editorRef.current?.replaceValue(next.sql);
    }
  };

  // --- Query history / saved snippets --------------------------------------
  const openHistory = async () => {
    try {
      setHistory(await api.listQueries());
      setHistoryOpen(true);
    } catch (e) {
      alert("读取历史失败: " + String(e));
    }
  };

  const loadQuery = (item: QueryItem) => {
    setActiveTab((t) => ({ ...t, sql: item.sql }));
    editorRef.current?.replaceValue(item.sql);
    editorRef.current?.view.focus();
    setHistoryOpen(false);
  };

  const saveSnippetFromItem = async (item: QueryItem) => {
    const name = window.prompt("片段名称", item.name ?? "我的查询");
    if (!name || !name.trim()) return;
    try {
      await api.saveQuery(item.id, name.trim(), item.sql, item.conn_id, item.db);
      setHistory(await api.listQueries());
    } catch (e) {
      alert("保存失败: " + String(e));
    }
  };

  const saveCurrentAsSnippet = async () => {
    const sql = editorRef.current?.getDoc() ?? "";
    if (!sql.trim()) return;
    const name = window.prompt("片段名称", "我的查询");
    if (!name || !name.trim()) return;
    try {
      await api.saveQuery(null, name.trim(), sql, selId || null, null);
      alert("已保存为片段");
    } catch (e) {
      alert("保存失败: " + String(e));
    }
  };

  const deleteQueryItem = async (item: QueryItem) => {
    if (!confirm("删除该记录？")) return;
    try {
      await api.deleteQuery(item.id);
      setHistory(await api.listQueries());
    } catch (e) {
      alert("删除失败: " + String(e));
    }
  };

  const sendChat = async () => {
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    const text = input.value;
    if (!text.trim() || streaming) return;
    const next: ChatMessage[] = [...chat, { role: "user", content: text }];
    setChat(next);
    input.value = "";
    setStreaming(true);
    setChat((prev) => [...prev, { role: "assistant", content: "" }]);
    try {
      await chatTurn(selId, next);
    } catch (e) {
      setStreaming(false);
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + String(e) }]);
    }
  };

  // The "+" dropdown creates real empty containers (ADR-016) or opens the
  // connection form. 新建环境/新建组 persist a first-class container
  // immediately, so it shows in the tree even with no connections under it.
  const selectedEnvId = (): string | undefined => {
    const c = findConn(selId);
    if (!c || !c.group_id) return undefined;
    for (const env of tree.environments) {
      for (const g of env.groups) {
        if (g.id === c.group_id) return env.id;
      }
    }
    return undefined;
  };

  const newEnvironment = async () => {
    setAddOpen(false);
    const name = window.prompt("环境名称", "新环境");
    if (!name || !name.trim()) return;
    try {
      await api.createEnvironment(name.trim());
      await refresh();
    } catch (e) {
      alert("创建环境失败: " + String(e));
    }
  };

  const newGroup = async () => {
    setAddOpen(false);
    // Parent env: the selected connection's env if known, else the first
    // environment, else auto-create a default one.
    let envId = selectedEnvId();
    if (!envId) {
      const envs = tree.environments.filter((e) => e.id !== "__ungrouped");
      if (envs.length === 0) {
        try {
          envId = await api.createEnvironment("默认环境");
        } catch (e) {
          alert("创建环境失败: " + String(e));
          return;
        }
      } else {
        envId = envs[0].id;
      }
    }
    const name = window.prompt("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      alert("创建分组失败: " + String(e));
    }
  };

  // Create a group under an explicit environment (right-click "新建组" on an env).
  const newGroupUnder = async (envId: string) => {
    const name = window.prompt("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      alert("创建分组失败: " + String(e));
    }
  };

  const renameContainer = async (id: string, oldName: string) => {
    const name = window.prompt("重命名", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    try {
      await api.renameContainer(id, name.trim());
      await refresh();
    } catch (e) {
      alert("重命名失败: " + String(e));
    }
  };

  const removeContainer = async (id: string) => {
    if (!confirm("确认删除该容器？若其中还有分组或连接将无法删除。")) return;
    try {
      await api.deleteContainer(id);
      await refresh();
    } catch (e) {
      alert("删除失败: " + String(e));
    }
  };

  const openAddSeed = (seed: Partial<ConnInput>) => {
    setAddOpen(false);
    setForm({ open: true, editing: false, cfg: { ...emptyForm(), ...seed } });
  };

  const openEditFor = (id: string) => {
    const c = findConn(id);
    if (!c) return;
    setForm({ open: true, editing: true, cfg: { ...c, password: "" } });
  };
  const saveForm = async () => {
    try {
      if (form.editing) await api.updateConnection(form.cfg);
      else await api.addConnection(form.cfg);
      setForm({ ...form, open: false });
      await refresh();
      if (form.editing) await loadSchema(form.cfg.id);
    } catch (e) {
      alert("保存失败: " + String(e));
    }
  };
  const delConnFor = async (id: string) => {
    if (!id) return;
    if (!confirm("确认删除该连接？")) return;
    await api.deleteConnection(id);
    if (id === selId) setSelId("");
    await refresh();
  };
  const testForm = async () => {
    try {
      const ok = await api.testConnection(form.cfg);
      alert(ok ? "连接成功" : "连接失败");
    } catch (e) {
      alert("连接失败: " + String(e));
    }
  };

  // Close the "+" dropdown on outside click or Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // Initial load: connections + LLM/mask status.
  useEffect(() => {
    (async () => {
      await refresh();
      setStatus(await api.getStatus());
    })();
  }, [refresh]);

  // Mount the editor once. The change listener writes back to the active tab;
  // tab switches call `replaceValue`, which re-fires this listener (writing the
  // same text) — idempotent by design.
  useEffect(() => {
    const el = document.getElementById("editor");
    if (!el) return;
    const editor = createEditor(
      el,
      (doc) => {
        const id = activeTabIdRef.current;
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, sql: doc } : t)));
      },
      () => runQueryRef.current()
    );
    editorRef.current = editor;
    const init = tabs.find((t) => t.id === activeTabId);
    if (init) editor.replaceValue(init.sql);
    return () => editor.view.destroy();
  }, []);

  // Streaming chat event listeners.
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    onChatToken((t) => {
      setChat((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: last.content + t };
        } else {
          next.push({ role: "assistant", content: t });
        }
        return next;
      });
    }).then((u) => unsubs.push(u));
    onChatTool((t) => {
      setChat((prev) => [...prev, { role: "tool", content: t }]);
    }).then((u) => unsubs.push(u));
    onChatDone(() => setStreaming(false)).then((u) => unsubs.push(u));
    onChatError((t) => {
      setStreaming(false);
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + t }]);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  return (
    <div className={"app" + (chatOpen ? "" : " chat-collapsed")}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <span>连接</span>
          <div className="head-actions">
            <button
              className="icon-btn"
              title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "☀" : "🌙"}
            </button>
            <div className="add-wrap" ref={addWrapRef}>
            <button
              className="add-btn"
              title="新建"
              onClick={() => setAddOpen((v) => !v)}
            >
              ＋
            </button>
            {addOpen && (
              <div className="add-menu">
                <button className="add-item" onClick={() => openAddSeed({})}>
                  新建连接
                </button>
                <button className="add-item" onClick={() => void newGroup()}>
                  新建组
                </button>
                <button className="add-item" onClick={() => void newEnvironment()}>
                  新建环境
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
        <Tree
          tree={tree}
          selectedConnId={selId}
          onSelectConn={selectConn}
          onBrowseTable={browseTable}
          onBrowseRedisKey={browseRedisKey}
          onInsertColumn={insertColumn}
          onEditConn={openEditFor}
          onDeleteConn={delConnFor}
          onInsertText={insertText}
          onRefreshConns={refresh}
          onNewGroup={(envId) => void newGroupUnder(envId)}
          onRenameContainer={(id, name) => void renameContainer(id, name)}
          onDeleteContainer={(id) => void removeContainer(id)}
          onShowStructure={showStructure}
          onShowRelationships={showRelationships}
        />
        <div className="sidebar-actions">
          <button onClick={() => openEditFor(selId)} disabled={!selId}>
            编辑
          </button>
          <button onClick={() => delConnFor(selId)} disabled={!selId}>
            删除
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="editor-pane">
          <div className="tab-bar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={"tab" + (t.id === activeTabId ? " active" : "")}
                onClick={() => switchTab(t.id)}
                title={t.name}
              >
                <span className="tab-name">{t.name}</span>
                {tabs.length > 1 && (
                  <button
                    className="tab-close"
                    title="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button className="tab-new" title="新建查询" onClick={newTab}>
              ＋
            </button>
          </div>
          <div className="pane-head">
            <span>查询编辑器 (Ctrl/Cmd+Enter 执行)</span>
            <div className="pane-actions">
              <button onClick={() => editorRef.current?.formatSql()} disabled={!selId}>
                格式化
              </button>
              <button onClick={saveCurrentAsSnippet}>存为片段</button>
              <button onClick={openHistory}>历史</button>
              <button onClick={explainQuery} disabled={!selId}>
                执行计划
              </button>
              <button className="primary" onClick={runQuery}>
                执行
              </button>
            </div>
          </div>
          <div id="editor" className="editor" />
        </div>
        <div className="result-pane">
          <div className="pane-head">
            <div className="result-tabs">
              <button
                className={"rtab" + (resultTab === "data" ? " active" : "")}
                onClick={() => setResultTab("data")}
              >
                数据
              </button>
              <button
                className={"rtab" + (resultTab === "structure" ? " active" : "")}
                disabled={!structureView && !browseCtx}
                onClick={gotoStructure}
              >
                表结构
              </button>
              <button
                className={"rtab" + (resultTab === "relation" ? " active" : "")}
                disabled={!relationshipView && !browseCtx}
                onClick={gotoRelation}
              >
                表关系
              </button>
            </div>
            <div className="pane-actions">
              {resultTab === "data" ? (
                <>
                  {editable && hasEdits && (
                    <>
                      <button className="primary" onClick={handleSaveEdit}>
                        保存修改
                      </button>
                      <button onClick={handleUndoEdit}>撤销修改</button>
                    </>
                  )}
                  {editable && <button onClick={addInsertRow}>新增行</button>}
                  {editable && !hasEdits && (
                    <span className="hint">双击单元格可编辑</span>
                  )}
                  {result && result.kind === "table" && result.columns.length > 0 && (
                    <button onClick={() => exportCsv(result, browseCtx)}>导出 CSV</button>
                  )}
                  {result && "truncated" in result && result.truncated && (
                    <span className="warn">已截断，请加 LIMIT</span>
                  )}
                </>
              ) : (
                <button onClick={() => setResultTab("data")}>返回数据</button>
              )}
            </div>
          </div>
          <div className="result-body">
            {resultTab === "structure" ? (
              structureView ? (
                renderStructure()
              ) : (
                <div className="empty">加载表结构…</div>
              )
            ) : resultTab === "relation" ? (
              relationshipView ? (
                renderRelationships()
              ) : (
                <div className="empty">加载表关系…</div>
              )
            ) : (
              renderData()
            )}
          </div>
          {resultTab === "data" && pager}
        </div>
        <div className={"status-bar" + (runInfo ? " " + runInfo.kind : "")}>
          <span className="status-dot" />
          <span className="status-text">{runInfo ? runInfo.text : "就绪"}</span>
          {selId && findConn(selId) && (
            <span className="status-conn">● {findConn(selId)!.name}</span>
          )}
        </div>
      </main>

      {chatOpen ? (
        <section className="chat">
          <div className="pane-head">
            <span>Chat (LLM)</span>
            <span className="chat-status">
            {status.llm_enabled ? "LLM 已配置" : "LLM 未配置"} · 脱敏:
            {status.mask_enabled ? "开" : "关"}
          </span>
          <button
            className="icon-btn"
            title="收起 Chat"
            onClick={() => {
              setChatOpen(false);
              localStorage.setItem("cq_chat_open", "0");
            }}
          >
            ⟩
          </button>
        </div>
        <div className="chat-log">
          {chat.map((m, i) => (
            <div key={i} className={"msg " + m.role}>
              <div className="msg-role">{roleLabel(m.role)}</div>
              <div className="msg-body">{m.content || "…"}</div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <div className="chat-input">
          <textarea
            id="chat-input"
            placeholder="问点什么，例如：统计 users 表行数"
            disabled={streaming}
          />
          <button onClick={sendChat} disabled={streaming || !status.llm_enabled}>
            发送
          </button>
        </div>
        </section>
      ) : (
        <div className="chat-rail">
          <button
            className="rail-btn"
            title="展开 Chat"
            onClick={() => {
              setChatOpen(true);
              localStorage.setItem("cq_chat_open", "1");
            }}
          >
            💬
          </button>
        </div>
      )}

      {form.open && (
        <div className="modal-mask">
          <div className="modal">
            <h3>{form.editing ? "编辑连接" : "新增连接"}</h3>
            <label>
              名称
              <input
                value={form.cfg.name}
                onChange={(e) =>
                  setForm({ ...form, cfg: { ...form.cfg, name: e.target.value } })
                }
              />
            </label>
            <label>
              类型
              <select
                value={form.cfg.db_type}
                onChange={(e) => {
                  const db_type = e.target.value;
                  const port = db_type === "redis" ? 6379 : 3306;
                  setForm({ ...form, cfg: { ...form.cfg, db_type, port } });
                }}
              >
                <option value="mysql">mysql</option>
                <option value="redis">redis</option>
              </select>
            </label>
            <label>
              主机
              <input
                value={form.cfg.host}
                onChange={(e) =>
                  setForm({ ...form, cfg: { ...form.cfg, host: e.target.value } })
                }
              />
            </label>
            <label>
              端口
              <input
                type="number"
                value={form.cfg.port}
                onChange={(e) =>
                  setForm({
                    ...form,
                    cfg: { ...form.cfg, port: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label>
              用户
              <input
                value={form.cfg.user}
                onChange={(e) =>
                  setForm({ ...form, cfg: { ...form.cfg, user: e.target.value } })
                }
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={form.cfg.password}
                placeholder={form.editing ? "(留空保持不变)" : ""}
                onChange={(e) =>
                  setForm({ ...form, cfg: { ...form.cfg, password: e.target.value } })
                }
              />
            </label>
            <label>
              数据库
              <input
                value={form.cfg.database}
                onChange={(e) =>
                  setForm({
                    ...form,
                    cfg: { ...form.cfg, database: e.target.value },
                  })
                }
              />
            </label>
            <label>
              分组
              <select
                value={form.cfg.group_id ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    cfg: { ...form.cfg, group_id: e.target.value || null },
                  })
                }
              >
                <option value="">（不分组）</option>
                {tree.environments
                  .filter((e) => e.id !== "__ungrouped")
                  .flatMap((e) =>
                    e.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {e.name} / {g.name || "(未命名)"}
                      </option>
                    ))
                  )}
              </select>
            </label>
            <div className="modal-actions">
              <button onClick={testForm}>测试连接</button>
              <span className="spacer" />
              <button onClick={() => setForm({ ...form, open: false })}>取消</button>
              <button className="primary" onClick={saveForm}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>查询历史 / 片段</h3>
            <div className="history-list">
              {history.length === 0 && <div className="empty">暂无记录</div>}
              {history.map((h) => (
                <div key={h.id} className="history-item">
                  <div className="history-meta">
                    {h.name ? <span className="snippet-badge">片段</span> : null}
                    <span>{findConn(h.conn_id ?? "")?.name ?? "—"}</span>
                    <span className="history-time">{fmtTime(h.created)}</span>
                  </div>
                  <pre className="history-sql">{h.sql}</pre>
                  <div className="history-actions">
                    <button onClick={() => loadQuery(h)}>载入</button>
                    <button onClick={() => void saveSnippetFromItem(h)}>
                      {h.name ? "重命名" : "存为片段"}
                    </button>
                    <button onClick={() => void deleteQueryItem(h)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setHistoryOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/// Serialize a table result to CSV with proper RFC-4180 quoting.
function toCsv(columns: string[], rows: string[][]): string {
  const esc = (s: string) => {
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [columns.map(esc).join(",")];
  for (const row of rows) lines.push(row.map((c) => esc(c ?? "")).join(","));
  return lines.join("\r\n");
}

function exportCsv(r: Extract<QueryOutput, { kind: "table" }>, ctx: BrowseCtx | null) {
  const csv = toCsv(r.columns, r.rows);
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const base = ctx ? `${ctx.db}.${ctx.table}` : "result";
  a.href = url;
  a.download = `${base}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function roleLabel(r: string) {
  return r === "user" ? "你" : r === "assistant" ? "AI" : "工具";
}
