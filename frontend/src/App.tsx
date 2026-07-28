import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ErrorBoundary } from "./ErrorBoundary";
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
  LlmConfigDto,
  LlmConfigInput,
  QueryItem,
  QueryOutput,
  Schema,
  StatusInfo,
  TableStructure,
  TreeModel,
  VendorPreset,
} from "./types";
import { createEditor, type EditorHandle } from "./editor";
import { Tree } from "./Tree";

interface DropdownOption {
  value: string;
  label: string;
  tag?: string;
}
interface DropdownSelectProps {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}

function DropdownSelect({ label, value, options, onChange }: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <label>
      {label}
      <div className="vendor-select" ref={ref}>
        <button
          type="button"
          className="vendor-trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="vendor-value">
            {selected?.label || value || "—"}
            {selected?.tag && <span className="vendor-provider">{selected.tag}</span>}
          </span>
          <span className="vendor-caret">▾</span>
        </button>
        {open && (
          <ul className="vendor-options" role="listbox">
            {options.map((o) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? "active" : ""}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.tag && <span className="vendor-tag">{o.tag}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}

interface ConnForm {
  open: boolean;
  editing: boolean;
  cfg: ConnInput;
}

// ---------------------------------------------------------------------------
// Database-picker popup (Phase 27). Instead of a flat cached list, this shows
// the connection hierarchy (env → group → conn) and fetches a connection's
// databases on demand when the connection is expanded. All transient state
// lives inside the component and is destroyed when the popup closes.
// ---------------------------------------------------------------------------

type PickerNode =
  | { kind: "type"; key: string; name: string; children: PickerNode[] }
  | { kind: "env"; key: string; name: string; children: PickerNode[] }
  | { kind: "group"; key: string; name: string; children: PickerNode[] }
  | { kind: "conn"; key: string; conn: ConnSummary };

function buildPickerRoots(tree: TreeModel): PickerNode[] {
  const envs = [...tree.environments].sort((a, b) => a.order - b.order);
  const types = new Set<string>();
  for (const env of envs)
    for (const g of env.groups)
      for (const c of g.connections) types.add(c.db_type);
  const sortedTypes = [...types].sort();
  const labelOf = (t: string) => (t === "redis" ? "Redis" : "MySQL");

  const roots: PickerNode[] = [];
  for (const t of sortedTypes) {
    const envNodes: PickerNode[] = [];
    for (const env of envs) {
      const groups = [...env.groups]
        .sort((a, b) => a.order - b.order)
        .map((g): PickerNode | null => {
          const conns = g.connections.filter((c) => c.db_type === t);
          if (conns.length === 0) return null;
          return {
            kind: "group",
            key: `grp:${g.id}:${t}`,
            name: g.name,
            children: conns.map((c) => ({
              kind: "conn",
              key: `conn:${c.id}`,
              conn: c,
            })),
          };
        })
        .filter((x): x is PickerNode => x !== null);
      if (groups.length === 0) continue;
      envNodes.push({
        kind: "env",
        key: `env:${env.id}:${t}`,
        name: env.name,
        children: groups,
      });
    }
    if (envNodes.length === 0) continue;
    roots.push({ kind: "type", key: `type:${t}`, name: labelOf(t), children: envNodes });
  }
  return roots;
}

interface DbPickerProps {
  tree: TreeModel;
  activeConnId: string;
  activeDb: string | null;
  onSelect: (connId: string, db: string | null) => void;
  onClose: () => void;
}

function DbPicker({ tree, activeConnId, activeDb, onSelect, onClose }: DbPickerProps) {
  const roots = useMemo(() => buildPickerRoots(tree), [tree]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Auto-expand type and env nodes whenever the tree changes so the user
  // starts at the group level.
  useEffect(() => {
    if (roots.length === 0) return;
    setExpanded((prev) => {
      const next = { ...prev };
      for (const r of roots) {
        next[r.key] = true;
        if (r.kind === "type") {
          for (const e of r.children) next[e.key] = true;
        }
      }
      return next;
    });
  }, [roots]);
  const [dbs, setDbs] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const toggleConn = async (conn: ConnSummary) => {
    const key = `conn:${conn.id}`;
    const willExpand = !expanded[key];
    setExpanded((e) => ({ ...e, [key]: willExpand }));
    if (willExpand && !(key in dbs) && !loading[key]) {
      setLoading((l) => ({ ...l, [key]: true }));
      try {
        const list =
          conn.db_type === "redis"
            ? (await api.listRedisDbs(conn.id)).map(String)
            : await api.listDatabases(conn.id);
        setDbs((m) => ({ ...m, [key]: list }));
      } catch (e) {
        console.error("db picker load failed", key, e);
        setDbs((m) => ({ ...m, [key]: [] }));
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    }
  };

  const iconFor = (n: PickerNode) => {
    switch (n.kind) {
      case "type":
        return n.name === "Redis" ? "🔴" : "🐬";
      case "env":
        return "🌐";
      case "group":
        return "📁";
      case "conn":
        return n.conn.db_type === "redis" ? "🔴" : "🐬";
    }
  };

  const renderNode = (node: PickerNode, depth: number): JSX.Element => {
    const hasChildren = node.kind !== "conn";
    const isOpen = !!expanded[node.key];
    const kids = node.kind === "conn" ? [] : node.children;
    const pad = { paddingLeft: `${depth * 16 + 8}px` };

    const onCaretClick = (e: ReactMouseEvent) => {
      e.stopPropagation();
      if (node.kind === "conn") {
        toggleConn(node.conn);
      } else if (hasChildren) {
        setExpanded((ex) => ({ ...ex, [node.key]: !isOpen }));
      }
    };

    const onRowClick = () => {
      if (node.kind === "conn") {
        onSelect(node.conn.id, null);
      } else if (hasChildren) {
        setExpanded((ex) => ({ ...ex, [node.key]: !isOpen }));
      }
    };

    const isActive =
      node.kind === "conn" &&
      node.conn.id === activeConnId &&
      activeDb == null;

    return (
      <div key={node.key} className="tree-node">
        <div
          className={"tree-row" + (isActive ? " active" : "")}
          style={pad}
          onClick={onRowClick}
          title={node.kind === "conn" ? "点击选中连接默认库，点箭头展开数据库" : undefined}
        >
          <span
            className={"tw" + (node.kind === "conn" ? "" : hasChildren ? "" : " leaf")}
            onClick={onCaretClick}
          >
            {node.kind === "conn" ? (isOpen ? "▾" : "▸") : hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className="badge">{iconFor(node)}</span>
          <span className="tree-label">{node.kind === "conn" ? node.conn.name : node.name}</span>
          {node.kind === "conn" && loading[`conn:${node.conn.id}`] && (
            <span className="tree-loading">…</span>
          )}
        </div>
        {node.kind === "conn" && isOpen && (
          <div>
            <div
              className={
                "tree-row db-pick-item" +
                (node.conn.id === activeConnId && activeDb == null ? " active" : "")
              }
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
              onClick={() => onSelect(node.conn.id, null)}
            >
              <span className="tw leaf" />
              <span className="badge">🏠</span>
              <span className="tree-label">连接默认库</span>
            </div>
            {(dbs[`conn:${node.conn.id}`] ?? []).map((db) => (
              <div
                key={db}
                className={
                  "tree-row db-pick-item" +
                  (node.conn.id === activeConnId && activeDb === db ? " active" : "")
                }
                style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                onClick={() => onSelect(node.conn.id, db)}
              >
                <span className="tw leaf" />
                <span className="badge">🗄</span>
                <span className="tree-label">{db}</span>
              </div>
            ))}
          </div>
        )}
        {node.kind !== "conn" && isOpen &&
          kids.map((c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>)}
      </div>
    );
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal db-picker-modal" onClick={(e) => e.stopPropagation()}>
        <h3>切换数据库（当前查询）</h3>
        <div className="db-pick-tree">
          {roots.length === 0 && (
            <div className="tree-empty">暂无连接，请先在左侧添加连接</div>
          )}
          {roots.map((r) => (
            <div key={r.key}>{renderNode(r, 0)}</div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/// Rows per page when browsing a table (kept in sync with the backend PAGE_LIMIT).
const PAGE_SIZE = 200;
/// User-selectable page sizes for the result pager (must be <= backend MAX_PAGE_SIZE).
const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000];

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
  // Per-tab database context (Phase 26): each query keeps its own connection
  // and database so switching tabs never clobbers another query's context.
  connId: string;
  db: string | null;
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
  // Currently selected connection/database in the TREE. This is only the
  // "intended" context — new queries inherit it, but each query tab keeps its
  // own connection/db (Phase 26), so selecting a node in the tree never
  // switches an existing query's context.
  const [selDb, setSelDb] = useState<string | null>(null);
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
    {
      id: INITIAL_TAB,
      name: "查询 1",
      sql: "",
      result: null,
      browseCtx: null,
      connId: "",
      db: null,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_TAB);
  // Current page size for query results / table browse. Selectable 100..1000.
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  // Raw text of the "jump to page" input (kept as string for controlled input).
  const [jumpPage, setJumpPage] = useState<string>("");
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Phase 26: per-tab database picker. The active query tab's DB is changed
  // through this popup (not by clicking the tree) to avoid accidental context
  // switches between queries.
  const [dbPickerOpen, setDbPickerOpen] = useState(false);

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

  // --- Row multi-select + copy menu (Phase 20) -----------------------------
  // `selRows` holds result-row indices selected for copy (JSON / INSERT / UPDATE).
  const [selRows, setSelRows] = useState<Set<number>>(new Set());
  const [selCol, setSelCol] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rows: number[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const lastAnchorRef = useRef(0);

  // Drag-to-select (marquee) for the result grid: hold left mouse and move
  // across rows to select a continuous range. Sits alongside the click / Ctrl /
  // Shift selection handled in onRowClick below.
  const dragRef = useRef<{ anchor: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const up = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Defensive: Tauri webview sometimes shows its own context menu (Reload /
  // Inspect) even when React's onContextMenu tries to preventDefault. Stop it
  // at the document level for anything inside the result table so our custom
  // menu is the only one that can appear.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".result-table")) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

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
  const [running, setRunning] = useState(false);

  // --- Collapsible AI panel + theme (Phase 18) ----------------------------
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    const v = localStorage.getItem("cq_chat_open");
    return v === null ? true : v === "1";
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const v = localStorage.getItem("cq_theme");
    return v === "light" ? "light" : "dark";
  });

  // --- Inline AI completion (Tab-accept ghost text) ----------------------
  // User preference, default OFF (Phase 21): avoids surprise LLM latency/cost.
  // The backend enforces that a configured model is required.
  const [aiCompleteOn, setAiCompleteOn] = useState<boolean>(
    () => localStorage.getItem("cq_ai_complete") === "1"
  );

  // --- LLM vendor/key/model settings (Phase 19) --------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presets, setPresets] = useState<VendorPreset[]>([]);
  const [llmCfg, setLlmCfg] = useState<LlmConfigDto | null>(null);
  const [cfgForm, setCfgForm] = useState<LlmConfigInput>({
    vendor: "openai",
    base_url: "",
    model: "",
    api_key: "",
  });
  const [cfgMsg, setCfgMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Load vendor presets + current config when the settings dialog opens.
  const openSettings = useCallback(async () => {
    setCfgMsg(null);
    try {
      const [ps, cfg] = await Promise.all([
        api.getVendorPresets(),
        api.getLlmConfig(),
      ]);
      setPresets(ps);
      setLlmCfg(cfg);
      setCfgForm({
        vendor: cfg.vendor || "openai",
        base_url: cfg.base_url,
        model: cfg.model,
        api_key: "",
      });
    } catch (e) {
      setCfgMsg({ ok: false, text: String(e) });
    }
    setSettingsOpen(true);
  }, []);

  // Picking a vendor prefills base_url/model from its preset defaults.
  const onVendorChange = useCallback(
    (vendor: string) => {
      const p = presets.find((x) => x.id === vendor);
      setCfgForm((f) => ({
        ...f,
        vendor,
        base_url: p ? p.base_url : f.base_url,
        model: p ? p.model : f.model,
      }));
    },
    [presets]
  );

  const saveSettings = useCallback(async () => {
    setCfgMsg(null);
    try {
      await api.saveLlmConfig(cfgForm);
      setStatus(await api.getStatus());
      setCfgMsg({ ok: true, text: "已保存" });
      setTimeout(() => setSettingsOpen(false), 600);
    } catch (e) {
      setCfgMsg({ ok: false, text: String(e) });
    }
  }, [cfgForm]);

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
  const activeRef = useRef(active);
  activeRef.current = active;
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

  // --- Row multi-select + copy menu (Phase 20) -----------------------------
  // Drop the selection whenever the result or the active tab changes.
  useEffect(() => {
    setSelRows(new Set());
    setSelCol(null);
    setCtxMenu(null);
  }, [active?.id, result]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  };

  const onRowClick = (ri: number, e: ReactMouseEvent) => {
    if (e.shiftKey && selRows.size > 0) {
      const [a, b] = [lastAnchorRef.current, ri].sort((x, y) => x - y);
      const next = new Set<number>();
      for (let k = a; k <= b; k++) next.add(k);
      setSelRows(next);
    } else if (e.metaKey || e.ctrlKey) {
      setSelRows((prev) => {
        const n = new Set(prev);
        if (n.has(ri)) n.delete(ri);
        else n.add(ri);
        return n;
      });
      lastAnchorRef.current = ri;
    } else {
      setSelRows(new Set([ri]));
      lastAnchorRef.current = ri;
    }
  };

  // Begin a marquee drag from this row (left button only). Selection is NOT
  // changed here yet — a plain click still falls through to onRowClick, while
  // moving across rows (onRowMouseEnter) extends the range. Clicks inside an
  // editor input or the row delete button are ignored so editing isn't hijacked.
  const onRowMouseDown = (ri: number, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".cell-edit") || t.closest(".row-del-btn")) return;
    dragRef.current = { anchor: ri };
    setDragging(true);
  };

  // While dragging, every row the pointer enters extends the selection to the
  // range between the anchor and the hovered row.
  const onRowMouseEnter = (ri: number) => {
    if (!dragRef.current) return;
    const a = dragRef.current.anchor;
    const [lo, hi] = a <= ri ? [a, ri] : [ri, a];
    const next = new Set<number>();
    for (let k = lo; k <= hi; k++) next.add(k);
    setSelRows(next);
    lastAnchorRef.current = ri;
  };

  const onRowCtx = (ri: number, e: ReactMouseEvent) => {
    e.preventDefault();
    const eff = selRows.has(ri)
      ? Array.from(selRows).sort((a, b) => a - b)
      : [ri];
    setSelRows(new Set(eff));
    lastAnchorRef.current = ri;
    // Clamp to viewport so the menu never overflows off-screen.
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: eff });
  };

  const copyRowsAs = async (kind: "json" | "insert" | "update") => {
    if (!result || result.kind !== "table") return;
    const eff = ctxMenu?.rows ?? Array.from(selRows);
    const rows = eff
      .map((ri) => result.rows[ri])
      .filter(Boolean) as string[][];
    if (rows.length === 0) return;
    let text = "";
    if (kind === "json") text = rowsToJson(result.columns, rows);
    else if (kind === "insert" && browseCtx)
      text = rowsToInsert(browseCtx.table, result.columns, rows);
    else if (kind === "update" && browseCtx)
      text = rowsToUpdate(browseCtx.table, result.columns, result.primaryKeys ?? [], rows);
    await copyText(text);
    showToast(
      `已复制 ${rows.length} 行 · ${
        kind === "json" ? "JSON" : kind === "insert" ? "INSERT" : "UPDATE"
      }`
    );
    setCtxMenu(null);
  };

  // Right-click a field: pin the column (for "copy as JSON") and keep the row
  // selection behaviour identical to before — if the row isn't already in the
  // selection it becomes the sole selected row, so the row menu stays useful.
  const onCellCtx = (ri: number, ci: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelCol(ci);
    const eff = selRows.has(ri)
      ? Array.from(selRows).sort((a, b) => a - b)
      : [ri];
    setSelRows(new Set(eff));
    lastAnchorRef.current = ri;
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: eff });
  };

  // Right-click a column header: pin the column selection and surface the
  // column copy actions. Row selection is left untouched so the user can
  // still copy rows from the same menu if any are selected.
  const onColCtx = (ci: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelCol(ci);
    const rows =
      selRows.size > 0 ? Array.from(selRows).sort((a, b) => a - b) : [];
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows });
  };

  // Serialize a single column to a JSON array, applying the same NULL / bool /
  // number coercion used by rowsToJson so the output is clean, typed JSON.
  const copyColAsJson = async (ci: number) => {
    if (!result || result.kind !== "table" || ci < 0) return;
    const colName = result.columns[ci];
    const arr = result.rows.map((r) => {
      const v = r[ci] ?? "";
      const low = v.toLowerCase();
      if (v === "NULL") return null;
      if (low === "true") return true;
      if (low === "false") return false;
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
      return v;
    });
    await copyText(JSON.stringify(arr, null, 2));
    showToast(`已复制列 ${colName} · ${arr.length} 个值 (JSON)`);
    setCtxMenu(null);
  };

  // Ctrl/Cmd+A in the result grid selects every row (unless focus is in the
  // editor, where it should select editor text instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        result?.kind === "table" &&
        !editing
      ) {
        const ae = document.activeElement as HTMLElement | null;
        const inEditor =
          !!ae && (!!ae.closest(".editor-host") || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
        if (!inEditor) {
          e.preventDefault();
          setSelRows(new Set(result.rows.map((_, i) => i)));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, editing]);

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
    async (id: string, db?: string | null) => {
      const conn = findConn(id);
      if (!conn || conn.db_type !== "mysql") {
        editorRef.current?.setSchema({ tables: [] });
        return;
      }
      try {
        const schema: Schema = await api.getSchema(id, db);
        editorRef.current?.setSchema(schema);
      } catch (e) {
        console.error("load schema failed", e);
      }
    },
    [findConn]
  );

  // Keep the editor's autocomplete schema in sync with the ACTIVE TAB's
  // connection and database (Phase 26: per-tab context). Re-runs whenever the
  // active tab's connection or database changes.
  const loadSchemaRef = useRef(loadSchema);
  loadSchemaRef.current = loadSchema;
  useEffect(() => {
    if (active?.connId) loadSchemaRef.current(active.connId, active.db);
  }, [active?.connId, active?.db]);

  // Provider for inline AI completion: asks the LLM for the SQL suffix that
  // completes `prefix`. Returns null on any failure so the editor shows nothing.
  // Stable (reads live context via refs) — registered once on the editor.
  const aiProvider = useCallback(async (prefix: string): Promise<string | null> => {
    const t = activeRef.current;
    if (!t?.connId) return null;
    try {
      return await api.completeSql(t.connId, t.db, prefix);
    } catch {
      return null;
    }
  }, []);

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
      if (r.total != null && r.total > n) {
        return {
          kind: "ok",
          text: `✓ ${ms}ms · 第 ${(r.page ?? 0) + 1} 页 / 共 ${r.total} 行`,
        };
      }
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
    const t = active;
    if (!t?.connId) {
      setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = sel || editor.getDoc();
    if (!q.trim()) return;
    clearEditState();
    setResultTab("data");
    setRunInfo(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await api.executeQuery(t.connId, q, t.db, 0, pageSize);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, sql: q, result: r, browseCtx: null }));
      void api.logQuery(t.connId, t.db, q);
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({
        ...tab,
        result: errOut(String(e)),
        browseCtx: null,
      }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active, pageSize]);

  // Re-run the *currently displayed* SQL at a given page (pager navigation for
  // ad-hoc query results). Uses the tab's stored `sql` — i.e. the last executed
  // statement — not the editor buffer, so paging never picks up unsaved edits.
  // `size` lets the page-size selector pass an explicit size; otherwise the
  // current `pageSize` state is used.
  const runQueryAt = useCallback(async (page: number, size?: number) => {
    const t = active;
    if (!t?.connId) return;
    const q = t.sql;
    if (!q.trim()) return;
    const sz = size ?? pageSize;
    setRunning(true);
    setRunInfo(null);
    const t0 = performance.now();
    try {
      const r = await api.executeQuery(t.connId, q, t.db, page, sz);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, result: r, browseCtx: null }));
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, result: errOut(String(e)), browseCtx: null }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active, pageSize]);

  // Keep a live ref so the editor's run-key (registered once) always calls the
  // latest `runQuery` closure with the current selected connection.
  const runQueryRef = useRef<() => void>(() => {});
  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  const explainQuery = useCallback(async () => {
    const t = active;
    if (!t?.connId) {
      setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = sel || editor.getDoc();
    if (!q.trim()) return;
    clearEditState();
    setResultTab("data");
    setRunInfo(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await api.explainQuery(t.connId, q, t.db);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, result: r, browseCtx: null }));
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({
        ...tab,
        result: errOut(String(e)),
        browseCtx: null,
      }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active]);

  const selectConn = (id: string) => {
    setSelId(id);
    setSelDb(null);
  };

  // Selecting a database node in the tree only records the "intended" context
  // (selDb / selId). It is inherited by freshly created queries, but it never
  // switches an existing query tab's connection/db (Phase 26). The editor
  // schema is driven by the ACTIVE TAB, not by this global state.
  const onSelectDb = useCallback((connId: string, db: string) => {
    setSelDb(db);
    setSelId((prev) => (prev === connId ? prev : connId));
  }, []);

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
      setSelDb(db);
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

  // Page-size selector in the pager. For ad-hoc results we re-run the displayed
  // SQL at page 0 with the new size; for table browse we re-browse with it.
  // The size is passed explicitly so we don't read the not-yet-updated
  // `pageSize` state via a stale closure.
  const changePageSize = (v: number) => {
    setPageSize(v);
    if (browseCtx) {
      void browseTable(browseCtx.connId, browseCtx.db, browseCtx.table, 0, v);
    } else {
      void runQueryAt(0, v);
    }
  };

  // Pager navigation: table browse uses browseTable, ad-hoc query results use
  // runQueryAt (re-runs the displayed SQL at the requested page).
  const goPage = (p: number) => {
    if (!result || result.kind !== "table" || result.total == null) return;
    const ps = browseCtx?.pageSize ?? pageSize;
    const totalPages = Math.max(1, Math.ceil(result.total / ps));
    const np = Math.min(Math.max(0, p), totalPages - 1);
    if (browseCtx) {
      void browseTable(browseCtx.connId, browseCtx.db, browseCtx.table, np, ps);
    } else {
      void runQueryAt(np);
    }
  };

  const pager =
    result && result.kind === "table" && result.total != null ? (
      (() => {
        const ps = browseCtx?.pageSize ?? pageSize;
        const totalPages = Math.max(1, Math.ceil(result.total / ps));
        const cur = result.page ?? 0;
        const doJump = () => {
          const n = parseInt(jumpPage, 10);
          if (!Number.isNaN(n)) goPage(n - 1);
          setJumpPage("");
        };
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
            <span className="pager-sep" />
            <label className="pager-size">
              每页
              <select
                value={ps}
                onChange={(e) => changePageSize(Number(e.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              行
            </label>
            <span className="pager-jump">
              跳至
              <input
                type="number"
                min={1}
                max={totalPages}
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doJump();
                }}
                className="pager-jump-input"
              />
              页
              <button onClick={doJump}>跳转</button>
            </span>
            {ps > 200 && (
              <span className="pager-warn">
                ⚠ 每页 {ps} 行：结果集较大，内存与渲染开销升高
              </span>
            )}
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
    const fmt = (c: unknown) =>
      c == null ? "" : typeof c === "object" ? JSON.stringify(c) : String(c);
    if (running) return <div className="empty">执行中…</div>;
    if (!result) return <div className="empty">执行查询以查看结果</div>;
    if (result.kind === "redis") {
      return (
        <div className="redis-result">
          {result.lines.map((l, i) => (
            <div key={i} className="redis-line">
              {l}
            </div>
          ))}
          {result.note && (
            <div
              className={
                "redis-note" +
                (result.lines.length === 0 ? " redis-error" : "")
              }
            >
              {result.note}
            </div>
          )}
        </div>
      );
    }
    if (result.kind !== "table") {
      return (
        <div className="empty">未知结果类型：{String((result as any).kind)}</div>
      );
    }
    const cols = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const pkSet = new Set(
      Array.isArray(result.primaryKeys) ? result.primaryKeys : []
    );
    if (cols.length === 0)
      return <div className="empty">无结果集</div>;
    return (
      <table className={"result-table" + (dragging ? " selecting" : "")}>
        <thead>
          <tr>
            {editable && <th className="row-action-col" />}
            {cols.map((c, i) => (
              <th
                key={i}
                className={
                  (pkSet.has(c) ? "pk " : "") + (selCol === i ? "col-selected " : "")
                }
                onClick={() => {
                  setSelCol(i);
                  setSelRows(new Set());
                }}
                onContextMenu={(e) => onColCtx(i, e)}
                title="左键选中整列 · 右键复制列"
              >
                {c}
                {pkSet.has(c) ? " 🔑" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const isDeleted = deletes.has(ri);
            return (
              <tr
                key={ri}
                className={
                  (isDeleted ? "row-deleted " : "") +
                  (selRows.has(ri) ? "row-selected" : "")
                }
                onMouseDown={(e) => onRowMouseDown(ri, e)}
                onMouseEnter={() => onRowMouseEnter(ri)}
                onClick={(e) => onRowClick(ri, e)}
                onContextMenu={(e) => onRowCtx(ri, e)}
              >
                {editable && (
                  <td className="row-action-col">
                    <button
                      className="row-del-btn"
                      title={isDeleted ? "取消删除" : "标记删除"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDelete(ri);
                      }}
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
                        (editable && !isDeleted ? "editable " : "") +
                        (selCol === ci ? "col-selected " : "")
                      }
                      title={
                        editable && !isDeleted
                          ? "双击编辑 · 右键复制"
                          : "右键复制"
                      }
                      onContextMenu={(e) => onCellCtx(ri, ci, e)}
                      onDoubleClick={() => {
                        if (!editable || isDeleted) return;
                        setCtxMenu(null);
                        setEditing({ ri, ci });
                        setDraft(v);
                      }}
                    >
                      {isEditing ? (
                        <input
                          className="cell-edit"
                          autoFocus
                          value={draft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitCell}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCell();
                            else if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        fmt(ov ?? v)
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
              {cols.map((_, ci) => (
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

  // `newTab` accepts an explicit connection/database so a "new query" spawned
  // from a tree node binds to that exact context (Phase 26). Called with no
  // args it inherits the current tree selection (selId / selDb).
  const newTab = (connId?: string, db?: string | null) => {
    const id = genTabId();
    const n = tabs.length + 1;
    const cid = connId ?? selId;
    const cdb = db !== undefined ? db : selDb;
    setTabs((prev) => [
      ...prev,
      {
        id,
        name: "查询 " + n,
        sql: "",
        result: null,
        browseCtx: null,
        connId: cid,
        db: cdb,
      },
    ]);
    activeTabIdRef.current = id;
    setActiveTabId(id);
    clearEditState();
    editorRef.current?.replaceValue("");
    editorRef.current?.view.focus();
  };

  // "New query" spawned from a tree node: select that connection and open a
  // fresh tab bound to the node's connection + database.
  const onNewQuery = (connId: string, db: string | null) => {
    setSelId(connId);
    newTab(connId, db);
  };

  // Open the database-switch popup for the active tab. The popup shows the
  // connection hierarchy (env → group → conn) and fetches a connection's
  // database list only when the connection is expanded — nothing is cached
  // globally.
  const openDbPicker = () => {
    setDbPickerOpen(true);
  };
  const changeTabContext = (connId: string, db: string | null) => {
    setActiveTab((t) => ({ ...t, connId, db }));
    setDbPickerOpen(false);
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
    // Restore the connection + database the query was logged under, so the
    // user lands back in the same context they ran it from. If the connection
    // has been deleted, fall back to loading only the SQL into the current tab.
    const conn = item.conn_id ? findConn(item.conn_id) : undefined;
    if (conn) {
      setSelId(conn.id);
      setActiveTab((t) => ({
        ...t,
        sql: item.sql,
        connId: conn.id,
        db: item.db ?? "",
      }));
    } else {
      setActiveTab((t) => ({ ...t, sql: item.sql }));
    }
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
      () => runQueryRef.current(),
      aiProvider
    );
    editorRef.current = editor;
    const init = tabs.find((t) => t.id === activeTabId);
    if (init) editor.replaceValue(init.sql);
    return () => editor.view.destroy();
  }, []);

  // Push the AI-completion toggle to the editor whenever it flips.
  useEffect(() => {
    editorRef.current?.setAiComplete(aiCompleteOn, aiProvider);
  }, [aiCompleteOn, aiProvider]);

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
              title="LLM 模型设置"
              onClick={() => void openSettings()}
            >
              ⚙
            </button>
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
          selectedDb={selDb}
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
          onSelectDb={onSelectDb}
          onNewQuery={onNewQuery}
        />
        <div className="sidebar-actions">
          <button onClick={() => openEditFor(selId)} disabled={!selId}>
            编辑连接
          </button>
          <button onClick={() => delConnFor(selId)} disabled={!selId}>
            删除连接
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
            <button className="tab-new" title="新建查询" onClick={() => newTab()}>
              ＋
            </button>
          </div>
          <div className="pane-head">
            <span>
              查询编辑器
              <button
                className="ctx-db-btn"
                onClick={() => void openDbPicker()}
                title="点击切换连接 / 数据库（每个查询独立）"
              >
                · {active?.connId ? `库: ${active.db || "默认"}` : "未选择连接"}
              </button>
              <span className="hint"> (Ctrl/Cmd+Enter 执行)</span>
            </span>
            <div className="pane-actions">
              <button
                onClick={() => editorRef.current?.formatSql()}
                disabled={!active?.connId}
              >
                格式化
              </button>
              <button onClick={saveCurrentAsSnippet}>存为片段</button>
              <button onClick={openHistory}>历史</button>
              <button onClick={explainQuery} disabled={!active?.connId}>
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
              <span className="result-status">
                [{result?.kind ?? "null"} rows={result?.kind === "table" && Array.isArray(result.rows) ? result.rows.length : "-"}]
              </span>
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
                  {result && result.kind === "table" && Array.isArray(result.columns) && result.columns.length > 0 && (
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
          {runInfo && (
            <div className={"run-banner run-" + runInfo.kind}>{runInfo.text}</div>
          )}
          <ErrorBoundary>
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
          </ErrorBoundary>
          {resultTab === "data" && pager}
        </div>
        <div className={"status-bar" + (runInfo ? " " + runInfo.kind : "")}>
          <span className="status-dot" />
          <span className="status-text">{running ? "执行中…" : runInfo ? runInfo.text : "就绪"}</span>
          {active?.connId && findConn(active.connId) && (
            <span className="status-conn">● {findConn(active.connId)!.name}</span>
          )}
          {active?.connId && active?.db && (
            <span className="status-db">▦ {active.db}</span>
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
            <DropdownSelect
              label="类型"
              value={form.cfg.db_type}
              options={[
                { value: "mysql", label: "mysql" },
                { value: "redis", label: "redis" },
              ]}
              onChange={(v) => {
                const port = v === "redis" ? 6379 : 3306;
                setForm({ ...form, cfg: { ...form.cfg, db_type: v, port } });
              }}
            />
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
            <DropdownSelect
              label="分组"
              value={form.cfg.group_id ?? ""}
              options={[
                { value: "", label: "（不分组）" },
                ...tree.environments
                  .filter((e) => e.id !== "__ungrouped")
                  .flatMap((e) =>
                    e.groups.map((g) => ({
                      value: g.id,
                      label: `${e.name} / ${g.name || "(未命名)"}`,
                    }))
                  ),
              ]}
              onChange={(v) =>
                setForm({
                  ...form,
                  cfg: { ...form.cfg, group_id: v || null },
                })
              }
            />
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
                    {h.db ? <span className="history-db">▦ {h.db}</span> : null}
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

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>LLM 模型设置</h3>
            <DropdownSelect
              label="模型厂商"
              value={cfgForm.vendor}
              options={presets.map((p) => ({
                value: p.id,
                label: p.label,
                tag: p.provider === "anthropic" ? "Anthropic" : undefined,
              }))}
              onChange={onVendorChange}
            />
            <label>
              API Base URL
              <input
                value={cfgForm.base_url}
                placeholder="https://api.openai.com/v1"
                onChange={(e) =>
                  setCfgForm({ ...cfgForm, base_url: e.target.value })
                }
              />
            </label>
            <label>
              模型名称
              <input
                value={cfgForm.model}
                placeholder="gpt-4o-mini"
                onChange={(e) => setCfgForm({ ...cfgForm, model: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                value={cfgForm.api_key}
                placeholder={llmCfg?.enabled ? "已保存（留空保持不变）" : "输入密钥"}
                onChange={(e) =>
                  setCfgForm({ ...cfgForm, api_key: e.target.value })
                }
              />
            </label>
            <label className="cfg-check">
              <input
                type="checkbox"
                checked={aiCompleteOn}
                onChange={(e) => {
                  const v = e.target.checked;
                  setAiCompleteOn(v);
                  localStorage.setItem("cq_ai_complete", v ? "1" : "0");
                }}
              />
              <span>
                AI 内联补全（Tab 接受灰色建议）
                <small>
                  输入停顿后由 LLM 续写 SQL；需先配置模型。默认关闭，以免产生延迟与费用。
                </small>
              </span>
            </label>
            {cfgMsg && (
              <div className={"cfg-msg " + (cfgMsg.ok ? "ok" : "err")}>
                {cfgMsg.text}
              </div>
            )}
            <div className="modal-actions">
              <button onClick={() => setSettingsOpen(false)}>取消</button>
              <button className="primary" onClick={() => void saveSettings()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {selCol !== null && (
              <>
                <div className="ctx-title">
                  列：{result?.kind === "table" ? result.columns[selCol] : ""}
                </div>
                <button onClick={() => void copyColAsJson(selCol)}>
                  复制选中列为 JSON
                </button>
                <div className="ctx-sep" />
              </>
            )}
            {ctxMenu.rows.length > 0 ? (
              <>
            <div className="ctx-title">复制选中 {ctxMenu.rows.length} 行</div>
            <button onClick={() => void copyRowsAs("json")}>复制为 JSON</button>
            <button
              disabled={!browseCtx}
              onClick={() => void copyRowsAs("insert")}
              title={browseCtx ? undefined : "仅浏览表时可生成 INSERT 语句"}
            >
              复制为 INSERT 语句{browseCtx ? "" : "（仅浏览表）"}
            </button>
            <button
              disabled={
                !browseCtx ||
                (result?.kind === "table" && (result.primaryKeys?.length ?? 0) === 0)
              }
              onClick={() => void copyRowsAs("update")}
              title={
                !browseCtx
                  ? "仅浏览表时可生成 UPDATE 语句"
                  : result?.kind === "table" && (result.primaryKeys?.length ?? 0) === 0
                  ? "该结果无主键，无法生成 UPDATE"
                  : undefined
              }
            >
              复制为 UPDATE 语句
              {!browseCtx
                ? "（仅浏览表）"
                : result?.kind === "table" && (result.primaryKeys?.length ?? 0) === 0
                ? "（无主键）"
                : ""}
            </button>
              </>
            ) : null}
          </div>
        </>
      )}

      {dbPickerOpen && (
        <DbPicker
          tree={tree}
          activeConnId={active?.connId ?? ""}
          activeDb={active?.db ?? null}
          onSelect={changeTabContext}
          onClose={() => setDbPickerOpen(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
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

/// Serialize a value exactly as MySQL would inline it: NULL keyword, TRUE/FALSE,
/// raw numbers, otherwise a single-quoted + escaped string. The backend emits
/// SQL NULL as the literal string "NULL", so it round-trips correctly.
function sqlLit(v: string): string {
  if (v === "NULL") return "NULL";
  const low = v.toLowerCase();
  if (low === "true") return "TRUE";
  if (low === "false") return "FALSE";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return "'" + v.replace(/'/g, "''") + "'";
}

/// Selected rows -> pretty JSON array. Numbers/booleans/NULL are typed;
/// everything else stays a string (the grid has no column-type info).
function rowsToJson(columns: string[], rows: string[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = r[i] ?? "";
      const low = v.toLowerCase();
      if (v === "NULL") o[c] = null;
      else if (low === "true") o[c] = true;
      else if (low === "false") o[c] = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) o[c] = Number(v);
      else o[c] = v;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

function rowsToInsert(table: string, columns: string[], rows: string[][]): string {
  const escId = (c: string) => "`" + c.replace(/`/g, "``") + "`";
  const cols = columns.map(escId).join(", ");
  const tuples = rows
    .map((r) => "(" + r.map((v) => sqlLit(v ?? "")).join(", ") + ")")
    .join(",\n  ");
  return `INSERT INTO \`${table.replace(/`/g, "``")}\` (${cols}) VALUES\n  ${tuples};`;
}

function rowsToUpdate(
  table: string,
  columns: string[],
  pks: string[],
  rows: string[][]
): string {
  const escId = (c: string) => "`" + c.replace(/`/g, "``") + "`";
  const pkIdx = pks.map((p) => columns.indexOf(p)).filter((i) => i >= 0);
  const stmts = rows.map((r) => {
    const set = columns
      .map((c, i) =>
        pkIdx.includes(i) ? null : `${escId(c)}=${sqlLit(r[i] ?? "")}`
      )
      .filter(Boolean)
      .join(", ");
    const where = pkIdx
      .map((i) => `${escId(columns[i])}=${sqlLit(r[i] ?? "")}`)
      .join(" AND ");
    return `UPDATE \`${table.replace(/`/g, "``")}\` SET ${set} WHERE ${where};`;
  });
  return stmts.join("\n");
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta);
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
