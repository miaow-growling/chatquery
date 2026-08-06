import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  api,
  cancelTurn,
  chatTurn,
  onChatConfirm,
  onChatDone,
  onChatError,
  onChatPlan,
  onChatToken,
  onChatTool,
  onChatUsage,
  resolveConfirm,
} from "./api";
import type {
  AuditRow,
  ChatItem,
  ChatMessage,
  ConfirmRequest,
  ConnInput,
  ConnSummary,
  ExplainNode,
  ExplainVisual,
  ForeignKeyInfo,
  KbBindingDto,
  KbDocDto,
  KeyStatus,
  LlmConfigDto,
  LlmConfigInput,
  QueryItem,
  QueryOutput,
  StatusInfo,
  TableStructure,
  TokenUsage,
  TreeModel,
  VendorPreset,
} from "./types";
import { createEditor, type EditorHandle } from "./editor";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Tree } from "./Tree";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 复制图标（内联 SVG，避免引入图标库）。 */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/** 渲染 AI 消息内容为 Markdown：标题/加粗/列表/代码块/表格/链接等。
 *  用 react-markdown + remark-gfm，默认不 dangerouslySetInnerHTML，XSS 安全。 */
function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface DropdownOption {
  value: string;
  label: string;
  tag?: string;
}
interface DropdownSelectProps {
  label?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
}

/** 证书/密钥文件选择按钮：点开系统文件框，读取文本内容回填到对应字段。
 *  跟在文本框后面，免去手动粘贴 PEM 或敲路径。 */
function CertPickButton({
  onPick,
  accept,
  title,
}: {
  onPick: (text: string) => void;
  accept?: string;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一文件
    if (!f) return;
    const r = new FileReader();
    r.onload = () => onPick(String(r.result ?? ""));
    r.readAsText(f);
  };
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={handle}
      />
      <button
        type="button"
        className="field-file-btn"
        title={title ?? "从文件选择"}
        onClick={() => ref.current?.click()}
      >
        📁
      </button>
    </>
  );
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
                onMouseDown={(e) => {
                  // Close on mousedown (not click) so the trigger <button>'s
                  // focus/blur cycle can't re-toggle it open. preventDefault
                  // keeps focus on the trigger instead of the <li>.
                  e.preventDefault();
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
  // --- SSL / TLS (#4) ---
  ssl_mode: "",
  ssl_ca: "",
  client_cert: "",
  client_key: "",
  // --- SSH tunnel / bastion (#5) ---
  ssh_host: "",
  ssh_port: 22,
  ssh_user: "",
  ssh_auth_kind: "password",
  ssh_password: "",
  ssh_private_key: "",
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
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  /// Id of the in-flight turn — the handle for cancelling it. Kept in a ref
  /// (not state) because the event listeners are registered once on mount and
  /// would otherwise close over a stale value.
  const turnIdRef = useRef<string | null>(null);
  /// Pending write confirmations. A single ReAct round can emit several tool
  /// calls in parallel, so this is a queue: we show the head and answer them
  /// one at a time rather than stacking modals.
  const [confirmQueue, setConfirmQueue] = useState<ConfirmRequest[]>([]);
  /// Token cost (ADR-AI-4 决策3): last turn's usage plus a running session
  /// total. `null` means the provider never reported usage for this turn —
  /// deliberately distinct from a reported zero.
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [sessionTokens, setSessionTokens] = useState(0);
  /// Write-guardrail audit trail (ADR-AI-1 决策3), loaded on demand.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [form, setForm] = useState<ConnForm>({
    open: false,
    editing: false,
    cfg: emptyForm(),
  });
  const [formTab, setFormTab] = useState<"basic" | "ssl" | "ssh">("basic");
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
  const [historyTab, setHistoryTab] = useState<"history" | "snippet">("history");
  const [historySearch, setHistorySearch] = useState("");
  const [historyConn, setHistoryConn] = useState<string>("");

  const editorRef = useRef<EditorHandle | null>(null);
  // Editor right-click menu (Navicat-style): where to show it + whether text
  // is selected (drives cut/copy/delete/case/"run selection" enabled state).
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    hasSel: boolean;
  } | null>(null);
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
  // Single-cell selection (set by clicking a data cell; cleared on row/column
  // selection). Drives the .cell-selected highlight independently of rows/cols.
  const [selCell, setSelCell] = useState<{ ri: number; ci: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    rows: number[];
    cell?: { ri: number; ci: number };
    col?: number;
  } | null>(null);
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

  // Defensive: Tauri's WKWebView shows its own context menu (Reload / Inspect),
  // and on macOS a native "Paste" bubble pops up on right-click over editable
  // areas. `contextmenu` preventDefault suppresses the menu, but that "Paste"
  // bubble is triggered by the OS on the right-button *mousedown* — before the
  // contextmenu event our custom menu depends on — so we also swallow the
  // default there. Both run in the capture phase so they fire before any
  // native handling. This guarantees our custom menus are the only thing that
  // appear over the editor and the result table.
  useEffect(() => {
    const inScope = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest?.(".result-table") || !!el?.closest?.(".editor");
    };
    const onMouseDown = (e: MouseEvent) => {
      if ((e.button === 2 || e.ctrlKey) && inScope(e.target)) {
        e.preventDefault();
      }
    };
    const onCtx = (e: MouseEvent) => {
      if (inScope(e.target)) e.preventDefault();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("contextmenu", onCtx, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("contextmenu", onCtx, true);
    };
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
  const [resultTab, setResultTab] =
    useState<"data" | "structure" | "relation" | "explain">("data");
  // EXPLAIN execution-plan visualisation (#6), populated by `explainQuery`.
  const [explainView, setExplainView] = useState<ExplainVisual | null>(null);

  // --- Result grid filter / sort / search (#3) ---
  // All operate on the in-memory current page only (no server round-trip).
  const [gridSearch, setGridSearch] = useState("");
  const [gridCase, setGridCase] = useState(false);
  const [gridSort, setGridSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  // Per-column filter: op ∈ contains|equals|nequals|empty|notempty|range.
  const [colFilters, setColFilters] = useState<Record<number, { op: string; val: string; val2?: string }>>({});

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
  // Settings is a left-nav module switcher: each module opens its own config
  // page on the right. Keeping this as explicit buttons (not a <select>
  // dropdown) makes the module list scannable and easy to extend.
  const [settingsTab, setSettingsTab] = useState<
    "model" | "key" | "general" | "kb"
  >("model");
  const [presets, setPresets] = useState<VendorPreset[]>([]);
  const [llmCfg, setLlmCfg] = useState<LlmConfigDto | null>(null);
  const [cfgForm, setCfgForm] = useState<LlmConfigInput>({
    vendor: "openai",
    base_url: "",
    model: "",
    api_key: "",
  });
  const [cfgMsg, setCfgMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // --- Connection encryption key K (#0) ---
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ configured: false });
  const [keyField, setKeyField] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Configure or rotate the connection key K. An empty field resets K back to
  // the default KEK (behaves like a pre-#0 install).
  const saveKey = async () => {
    setKeyMsg(null);
    try {
      await api.setEncryptionKey(keyField);
      setKeyStatus(await api.getKeyStatus());
      setKeyField("");
      setKeyMsg({ ok: true, text: "密钥已保存，所有连接已重加密" });
    } catch (e) {
      setKeyMsg({ ok: false, text: String(e) });
    }
  };

  // Load vendor presets + current config when the settings dialog opens.
  const openSettings = useCallback(async () => {
    setCfgMsg(null);
    try {
      const [ps, cfg, ks] = await Promise.all([
        api.getVendorPresets(),
        api.getLlmConfig(),
        api.getKeyStatus(),
      ]);
      setPresets(ps);
      setLlmCfg(cfg);
      setKeyStatus(ks);
      setCfgForm({
        vendor: cfg.vendor || "openai",
        base_url: cfg.base_url,
        model: cfg.model,
        api_key: "",
      });
    } catch (e) {
      setCfgMsg({ ok: false, text: String(e) });
    }
    setSettingsTab("model");
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
    setSelCell(null);
    setCtxMenu(null);
  }, [active?.id, result]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  };

  // Tauri's webview does NOT implement window.prompt / confirm / alert, so those
  // calls silently no-op in the desktop build (the "新建环境/组 点了没反应" bug).
  // We provide promise-based replacements rendered as an in-app modal.
  type DialogState =
    | { kind: "prompt"; title: string; def: string; resolve: (v: string | null) => void }
    | { kind: "confirm"; title: string; message: string; resolve: (v: boolean) => void }
    | {
        kind: "envType";
        title: string;
        resolve: (v: { name: string; dbType: "mysql" | "redis" } | null) => void;
      }
    | null;
  const [dlg, setDlg] = useState<DialogState>(null);
  // Local state for the envType dialog (name + db_type picker).
  const [envDlgName, setEnvDlgName] = useState("");
  const [envDlgType, setEnvDlgType] = useState<"mysql" | "redis">("mysql");
  const promptAsync = (title: string, def = ""): Promise<string | null> =>
    new Promise((res) => setDlg({ kind: "prompt", title, def, resolve: res }));
  const confirmAsync = (message: string, title = "请确认"): Promise<boolean> =>
    new Promise((res) => setDlg({ kind: "confirm", title, message, resolve: res }));
  const promptEnvType = (
    title: string
  ): Promise<{ name: string; dbType: "mysql" | "redis" } | null> => {
    setEnvDlgName("");
    setEnvDlgType("mysql");
    return new Promise((res) => setDlg({ kind: "envType", title, resolve: res }));
  };

  // --- Knowledge base (ADR-AI-6) -----------------------------------------
  // Docs are plain text / Markdown bound to connections (whole connection) or to
  // a specific database. A doc can bind to many connections / databases (1:N:N).
  const [kbDocs, setKbDocs] = useState<KbDocDto[]>([]);
  const [kbEditing, setKbEditing] = useState<KbDocDto | null>(null);
  const [kbName, setKbName] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [kbBindings, setKbBindings] = useState<KbBindingDto[]>([]);
  const [kbMsg, setKbMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Distinguishes "list empty state" from "actively creating a new draft" — both
  // have kbEditing=null and empty name/content, so we need an explicit flag or
  // clicking 新建知识库 looks like a no-op (it resets to the same empty state).
  const [kbIsNew, setKbIsNew] = useState(false);
  // Caches DB lists per connection so the binding editor's database dropdown
  // is populated lazily (an 8000-DB instance should not freeze the UI).
  const [kbDbCache, setKbDbCache] = useState<Record<string, string[]>>({});
  const [kbLoadingDbs, setKbLoadingDbs] = useState<string | null>(null);
  // Controlled selects for the "add a binding" row.
  const [kbNewConn, setKbNewConn] = useState("");
  const [kbNewDb, setKbNewDb] = useState("");

  const loadKbDocs = useCallback(async () => {
    try {
      setKbDocs(await api.listKbDocs());
    } catch (e) {
      showToast("加载知识库失败: " + String(e));
    }
  }, []);

  const loadKbDbs = useCallback(
    async (connId: string) => {
      if (kbDbCache[connId] || kbLoadingDbs === connId) return;
      setKbLoadingDbs(connId);
      try {
        const dbs = await api.listDatabases(connId);
        setKbDbCache((c) => ({ ...c, [connId]: dbs }));
      } catch {
        setKbDbCache((c) => ({ ...c, [connId]: [] }));
      } finally {
        setKbLoadingDbs(null);
      }
    },
    [kbDbCache, kbLoadingDbs]
  );

  const refreshKbEditing = useCallback(async (id: string) => {
    const fresh = (await api.listKbDocs()).find((d) => d.id === id);
    if (fresh) {
      setKbEditing(fresh);
      setKbName(fresh.name);
      setKbContent(fresh.content);
      setKbBindings(fresh.bindings.map((b) => ({ ...b })));
    }
  }, []);

  const startNewKb = () => {
    setKbIsNew(true);
    setKbEditing(null);
    setKbName("");
    setKbContent("");
    setKbBindings([]);
    setKbMsg(null);
  };

  const editKb = (doc: KbDocDto) => {
    setKbIsNew(false);
    setKbEditing(doc);
    setKbName(doc.name);
    setKbContent(doc.content);
    setKbBindings(doc.bindings.map((b) => ({ ...b })));
    setKbMsg(null);
  };

  const saveKbDoc = async () => {
    setKbMsg(null);
    const name = kbName.trim();
    if (!name) {
      setKbMsg({ ok: false, text: "请填写知识库名称" });
      return;
    }
    try {
      if (kbEditing) {
        await api.updateKbDoc(kbEditing.id, name, kbContent);
        await api.setKbBindings(
          kbEditing.id,
          kbBindings.map((b) => ({ conn_id: b.conn_id, database: b.database }))
        );
        await refreshKbEditing(kbEditing.id);
      } else {
        const id = await api.addKbDoc(name, kbContent);
        if (kbBindings.length > 0) {
          try {
            await api.setKbBindings(
              id,
              kbBindings.map((b) => ({ conn_id: b.conn_id, database: b.database }))
            );
            setKbMsg({ ok: true, text: "已创建并绑定" });
          } catch (e) {
            setKbMsg({ ok: false, text: "文档已创建，但绑定失败：" + String(e) });
          }
        } else {
          setKbMsg({ ok: true, text: "已创建" });
        }
        await refreshKbEditing(id);
        setKbIsNew(false);
      }
      await loadKbDocs();
      setKbMsg({ ok: true, text: kbEditing ? "已保存" : "已创建" });
    } catch (e) {
      setKbMsg({ ok: false, text: String(e) });
    }
  };

  const deleteKb = async (doc: KbDocDto) => {
    if (
      !(await confirmAsync(
        `确定删除知识库「${doc.name}」？相关绑定关系也会一并删除，且不可恢复。`,
        "删除知识库"
      ))
    )
      return;
    try {
      await api.deleteKbDoc(doc.id);
      showToast("已删除知识库「" + doc.name + "」");
      if (kbEditing && kbEditing.id === doc.id) {
        setKbIsNew(false);
        setKbEditing(null);
        setKbName("");
        setKbContent("");
        setKbBindings([]);
        setKbMsg(null);
      }
      await loadKbDocs();
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  const addKbBinding = (connId: string, database: string | null) => {
    if (!connId) return;
    setKbBindings((bs) => {
      if (bs.some((b) => b.conn_id === connId && b.database === database)) {
        showToast("该连接 / 数据库绑定已存在");
        return bs;
      }
      return [...bs, { conn_id: connId, database }];
    });
  };
  const removeKbBinding = (idx: number) => {
    setKbBindings((bs) => bs.filter((_, i) => i !== idx));
  };

  // Load knowledge-base docs whenever the user switches to the KB tab.
  useEffect(() => {
    if (settingsTab === "kb") void loadKbDocs();
  }, [settingsTab]);

  // `val` may be a string (prompt), boolean (confirm), the envType payload
  // ({name, dbType}), or null — kept loosely typed because each dialog variant
  // only ever receives its own shape at runtime.
  const closeDlg = (val: any) => {
    setDlg((cur) => {
      if (cur) (cur.resolve as (v: any) => void)(val);
      return null;
    });
  };

  const onRowClick = (ri: number, e: ReactMouseEvent) => {
    setSelCell(null);
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
    // Table name: prefer browse context, then try to parse it from the SQL's
    // FROM clause. If neither yields one (JOIN/UNION/subquery), use a
    // placeholder so the user can still get a template to edit.
    const table =
      browseCtx?.table ??
      extractTableFromSql(active?.sql ?? "") ??
      "<table>";
    let pks = result.primaryKeys ?? [];
    let text = "";
    if (kind === "json") text = rowsToJson(result.columns, rows);
    else if (kind === "insert")
      text = rowsToInsert(table, result.columns, rows);
    else if (kind === "update") {
      // Ad-hoc queries don't carry result.primaryKeys (the server only
      // fills them on the browse path). Resolve a real PK from the DB so
      // an `id`-bearing row produces a proper `WHERE id=...` instead of a
      // noisy all-column template. Order of fallbacks:
      //   1. fetch real PKs via describeTable (most accurate)
      //   2. an `id`-like column present in the result (common convention)
      //   3. all columns (rowsToUpdate puts every column in SET + WHERE)
      if (
        pks.length === 0 &&
        table !== "<table>" &&
        active?.connId &&
        active.db
      ) {
        try {
          const struct = await api.describeTable(
            active.connId,
            active.db,
            table
          );
          const realPks = struct.indexes
            .filter((ix) => ix.name.toUpperCase() === "PRIMARY")
            .map((ix) => ix.column)
            .filter((c) => result.columns.includes(c));
          if (realPks.length > 0) pks = realPks;
          else {
            const idCol = result.columns.find(
              (c) => c.toLowerCase() === "id"
            );
            if (idCol) pks = [idCol];
          }
        } catch {
          // describeTable failed (table in another db, no perms, etc.) —
          // fall back to the id heuristic, then to all columns.
          const idCol = result.columns.find(
            (c) => c.toLowerCase() === "id"
          );
          if (idCol) pks = [idCol];
        }
      } else if (pks.length === 0) {
        // No table context at all: try the id heuristic before all-column.
        const idCol = result.columns.find((c) => c.toLowerCase() === "id");
        if (idCol) pks = [idCol];
      }
      text = rowsToUpdate(table, result.columns, pks, rows);
    }
    await copyText(text);
    showToast(
      `已复制 ${rows.length} 行 · ${
        kind === "json" ? "JSON" : kind === "insert" ? "INSERT" : "UPDATE"
      }`
    );
    setCtxMenu(null);
  };

  // Copy a single cell's exact displayed value to the clipboard. Reads the
  // edit overlay first (so an in-progress edit is copied), then the DB snapshot.
  const copyCell = async (ri: number, ci: number) => {
    if (!result || result.kind !== "table") return;
    const row = result.rows[ri];
    if (!row) return;
    const raw = (edits[ri]?.[ci] ?? row[ci]) ?? "";
    const text = fmtCell(raw);
    await copyText(text);
    const colName = result.columns[ci] ?? `#${ci + 1}`;
    showToast(`已复制单元格 · ${colName}`);
    setCtxMenu(null);
  };

  // Single left-click on a data cell: select ONLY that cell. Row/column
  // selections are cleared so the highlight is unambiguous.
  const onCellClick = (ri: number, ci: number) => {
    setSelRows(new Set());
    setSelCol(null);
    setSelCell({ ri, ci });
  };

  // Right-click a field: pin the column (for "copy as JSON") and keep the row
  // selection behaviour identical to before — if the row isn't already in the
  // selection it becomes the sole selected row, so the row menu stays useful.
  const onCellCtx = (ri: number, ci: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelCell({ ri, ci });
    const eff = selRows.has(ri)
      ? Array.from(selRows).sort((a, b) => a - b)
      : [ri];
    setSelRows(new Set(eff));
    lastAnchorRef.current = ri;
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: eff, cell: { ri, ci } });
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
    setCtxMenu({ x, y, rows, col: ci });
  };

  // --- Column filter actions (#3) -----------------------------------------
  const opLabel = (op: string) =>
    ({
      contains: "包含",
      equals: "等于",
      nequals: "不等于",
      empty: "为空",
      notempty: "非空",
      range: "数值范围",
    } as Record<string, string>)[op] ?? op;

  // Open a prompt (or two for a range) and store the filter for column `ci`.
  const filterColByPrompt = async (ci: number, op: string) => {
    setCtxMenu(null);
    if (op === "empty" || op === "notempty") {
      setColFilters((f) => ({ ...f, [ci]: { op, val: "" } }));
      return;
    }
    if (op === "range") {
      const min = await promptAsync("数值范围 - 最小值（留空表示不限）");
      if (min === null) return;
      const max = await promptAsync("数值范围 - 最大值（留空表示不限）");
      if (max === null) return;
      if (min.trim() === "" && max.trim() === "") return;
      setColFilters((f) => ({ ...f, [ci]: { op, val: min.trim(), val2: max.trim() } }));
      return;
    }
    const val = await promptAsync(`筛选（${opLabel(op)}）输入匹配值`);
    if (val === null) return;
    setColFilters((f) => ({ ...f, [ci]: { op, val } }));
  };

  const clearColFilter = (ci: number) => {
    setColFilters((f) => {
      const n = { ...f };
      delete n[ci];
      return n;
    });
  };

  // Whether a single cell value matches a column filter.
  const matchesColFilter = (
    op: string,
    val: string,
    cell: string,
    val2?: string
  ): boolean => {
    const c = gridCase ? cell : cell.toLowerCase();
    const v = gridCase ? val : val.toLowerCase();
    switch (op) {
      case "contains":
        return c.includes(v);
      case "equals":
        return c === v;
      case "nequals":
        return c !== v;
      case "empty":
        return cell === "" || cell === "NULL";
      case "notempty":
        return !(cell === "" || cell === "NULL");
      case "range": {
        const n = Number(cell);
        if (Number.isNaN(n)) return false;
        const lo = val === "" ? -Infinity : Number(val);
        const hi = val2 === "" || val2 === undefined ? Infinity : Number(val2);
        return n >= lo && n <= hi;
      }
      default:
        return true;
    }
  };

  // Whether a row passes ALL active column filters + the global search.
  const rowMatches = (row: string[]): boolean => {
    for (const [ci, f] of Object.entries(colFilters)) {
      const ciN = Number(ci);
      if (ciN >= row.length) continue;
      if (!matchesColFilter(f.op, f.val ?? "", row[ciN], f.val2)) return false;
    }
    const q = gridSearch.trim();
    if (q) {
      const needle = gridCase ? q : q.toLowerCase();
      const hit = row.some((cell) => {
        const c = gridCase ? cell : cell.toLowerCase();
        return c.includes(needle);
      });
      if (!hit) return false;
    }
    return true;
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

  // Flat connection list (for the history/snippet connection filter).
  const allConns = useMemo(() => {
    const out: ConnSummary[] = [];
    for (const env of tree.environments)
      for (const g of env.groups) out.push(...g.connections);
    return out;
  }, [tree]);

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
        editorRef.current?.setSchemaContext(null, null);
        return;
      }
      // No eager full-schema fetch. Completion is fetched lazily by name
      // prefix (bounded) as the user types — see editor.ts schemaCompleter.
      // This is what stopped an 8000-table database from freezing the UI the
      // moment it was selected.
      editorRef.current?.setSchemaContext(id, db ?? null);
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

  const runQuery = useCallback(async (forceFull = false) => {
    const t = active;
    if (!t?.connId) {
      setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = forceFull ? editor.getDoc() : sel || editor.getDoc();
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
  const runQueryRef = useRef<(forceFull?: boolean) => void>(() => {});
  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  /// Build the SQL-editor right-click menu (Navicat-style). `hasSel` reflects
  /// whether text is selected and gates the selection-only commands.
  const buildEditorMenu = (hasSel: boolean): MenuItem[] => {
    const ed = editorRef.current;
    return [
      { type: "item", label: "撤销", onClick: () => ed?.undo() },
      { type: "item", label: "重做", onClick: () => ed?.redo() },
      { type: "sep" },
      { type: "item", label: "剪切", disabled: !hasSel, onClick: () => ed?.cut() },
      { type: "item", label: "复制", disabled: !hasSel, onClick: () => ed?.copy() },
      { type: "item", label: "粘贴", onClick: () => void ed?.paste() },
      { type: "item", label: "删除", disabled: !hasSel, onClick: () => ed?.deleteSelection() },
      { type: "sep" },
      { type: "item", label: "全选", onClick: () => ed?.selectAll() },
      { type: "sep" },
      { type: "item", label: "格式化 SQL", onClick: () => ed?.formatSql() },
      { type: "item", label: "注释 / 取消注释", onClick: () => ed?.toggleComment() },
      { type: "item", label: "转换为大写", disabled: !hasSel, onClick: () => ed?.changeCase(true) },
      { type: "item", label: "转换为小写", disabled: !hasSel, onClick: () => ed?.changeCase(false) },
      { type: "sep" },
      { type: "item", label: "运行已选择", disabled: !hasSel, onClick: () => runQueryRef.current() },
      { type: "item", label: "运行全部", onClick: () => runQueryRef.current(true) },
    ];
  };

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
    setExplainView(null);
    setResultTab("explain");
    setRunInfo(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      const v = await api.explainVisual(t.connId, q, t.db);
      const ms = Math.round(performance.now() - t0);
      setExplainView(v);
      // Keep the raw plan also available as the textual result for reference.
      if (v.format === "legacy") {
        setActiveTab((tab) => ({
          ...tab,
          result: { kind: "redis", command: "EXPLAIN", lines: (v.raw ?? "").split("\n"), note: "EXPLAIN（legacy 文本）", truncated: false },
          browseCtx: null,
        }));
      }
      setRunInfo({ kind: "ok", text: `✓ ${ms}ms · 执行计划已生成（${v.format}）` });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setExplainView(null);
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
      showToast("保存失败: " + String(e));
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
    const fmt = fmtCell;
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

    // --- #3: filter / search / sort on the in-memory page only ----------
    // `viewRows` carries the ORIGINAL row index so edits/deletes still map to
    // the real row even after sorting/filtering.
    let viewRows: { origRi: number; row: string[] }[] = rows.map((row, ri) => ({
      origRi: ri,
      row,
    }));
    if (Object.keys(colFilters).length > 0 || gridSearch.trim()) {
      viewRows = viewRows.filter(({ row }) => rowMatches(row));
    }
    if (gridSort) {
      const ci = gridSort.col;
      const dir = gridSort.dir === "asc" ? 1 : -1;
      viewRows = [...viewRows].sort((a, b) => {
        const av = a.row[ci] ?? "";
        const bv = b.row[ci] ?? "";
        const an = Number(av);
        const bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== "" && bv !== "") {
          return (an - bn) * dir;
        }
        const ad = Date.parse(av);
        const bd = Date.parse(bv);
        if (!Number.isNaN(ad) && !Number.isNaN(bd) && av !== "" && bv !== "") {
          return (ad - bd) * dir;
        }
        return av.localeCompare(bv) * dir;
      });
    }
    return (
      <>
      <table className={"result-table" + (dragging ? " selecting" : "")}>
        <thead>
          <tr>
            <th className="row-num" title="行号 · 点击行号选中整行">#</th>
            {editable && <th className="row-action-col" />}
            {cols.map((c, i) => (
              <th
                key={i}
                className={
                  (pkSet.has(c) ? "pk " : "") +
                  (selCol === i ? "col-selected " : "") +
                  (gridSort?.col === i ? "col-sorted " : "") +
                  (colFilters[i] ? "col-filtered " : "")
                }
                onClick={() => {
                  setSelCol(i);
                  setSelRows(new Set());
                  setSelCell(null);
                  // Cycle: none → asc → desc → none (#3 sort).
                  setGridSort((s) =>
                    s?.col === i
                      ? s.dir === "asc"
                        ? { col: i, dir: "desc" }
                        : null
                      : { col: i, dir: "asc" }
                  );
                }}
                onContextMenu={(e) => onColCtx(i, e)}
                title="左键点击排序(升/降/取消) · 右键列筛选/复制"
              >
                {c}
                {pkSet.has(c) ? " 🔑" : ""}
                {gridSort?.col === i ? (gridSort.dir === "asc" ? " ▲" : " ▼") : ""}
                {colFilters[i] ? <span className="filter-dot" title="已筛选">⚲</span> : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {viewRows.map(({ origRi: ri, row }) => {
            const isDeleted = deletes.has(ri);
            return (
              <tr
                key={ri}
                className={
                  (isDeleted ? "row-deleted " : "") +
                  (selRows.has(ri) ? "row-selected" : "")
                }
              >
                <td
                  className="row-num"
                  onMouseDown={(e) => onRowMouseDown(ri, e)}
                  onMouseEnter={() => onRowMouseEnter(ri)}
                  onClick={(e) => onRowClick(ri, e)}
                  onContextMenu={(e) => onRowCtx(ri, e)}
                  title="点击选中整行 · 右键复制行"
                >
                  {ri + 1}
                </td>
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
                  const isCellSel =
                    selCell?.ri === ri && selCell?.ci === ci;
                  return (
                    <td
                      key={ci}
                      className={
                        (ov !== undefined ? "dirty " : "") +
                        (editable && !isDeleted ? "editable " : "") +
                        (selCol === ci ? "col-selected " : "") +
                        (isCellSel ? "cell-selected " : "")
                      }
                      title={
                        editable && !isDeleted
                          ? "单击选中单元格 · 双击编辑 · 右键复制"
                          : "单击选中单元格 · 右键复制"
                      }
                      onClick={() => onCellClick(ri, ci)}
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
                      ) : (() => {
                        const text = fmt(ov ?? v);
                        const cls =
                          text === "NULL"
                            ? "cell--null"
                            : /^-?\d+(\.\d+)?$/.test(text)
                            ? "cell--num"
                            : undefined;
                        return cls ? <span className={cls}>{text}</span> : text;
                      })()}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {inserts.map((ins, ii) => (
            <tr key={"ins-" + ii} className="row-insert">
              <td className="row-num" title="新增行">·</td>
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
      <div className="grid-status">
        显示 {viewRows.length} / 共 {rows.length} 行
        {Object.keys(colFilters).length > 0 && " · 已按列筛选"}
        {gridSort && " · 已排序"}
      </div>
      </>
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

  // Render the EXPLAIN execution-plan tree (#6): a nested tree of table accesses
  // coloured by scan type, plus a flame-style horizontal bar per node by cost.
  const renderExplain = (v: ExplainVisual) => {
    // Colour a node by its access type (ALL / index / range / ref / const ...).
    const scanClass = (t: string) => {
      switch (t) {
        case "ALL":
          return "scan-all";
        case "index":
          return "scan-index";
        case "range":
        case "index_merge":
          return "scan-range";
        case "ref":
        case "ref_or_null":
        case "unique_subquery":
        case "index_subquery":
          return "scan-ref";
        case "eq_ref":
          return "scan-eqref";
        case "const":
        case "system":
          return "scan-const";
        default:
          return "scan-other";
      }
    };
    // Maximum cost across the whole tree, to scale the flame bars.
    const maxCost = (() => {
      let m = 0;
      const walk = (ns: ExplainNode[]) => {
        for (const n of ns) {
          if (n.cost > m) m = n.cost;
          walk(n.children);
        }
      };
      walk(v.nodes);
      return m || 1;
    })();
    const renderNode = (n: ExplainNode, depth: number): JSX.Element => (
      <div key={n.name + depth + (n.key || "")} className="explain-node">
        <div className="explain-row">
          <span className={"explain-scan " + scanClass(n.access_type)}>
            {n.access_type || "—"}
          </span>
          <span className="explain-name">{n.name}</span>
          {n.key && <span className="explain-key">key={n.key}</span>}
          <span className="explain-meta">rows={n.rows}</span>
          <span className="explain-meta">cost={Number(n.cost).toFixed(2)}</span>
          {n.extra && <span className="explain-extra">{n.extra}</span>}
          {/* Flame bar: width proportional to this node's cost. */}
          <span className="explain-flame">
            <span
              className={"explain-flame-bar " + scanClass(n.access_type)}
              style={{ width: `${Math.max(2, (n.cost / maxCost) * 100)}%` }}
            />
          </span>
        </div>
        {n.children.length > 0 && (
          <div className="explain-children">
            {n.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
    return (
      <div className="explain-view">
        {v.nodes.length === 0 && (
          <div className="empty">解析到的执行计划为空（可能是非 SELECT 语句）</div>
        )}
        {v.nodes.map((n) => renderNode(n, 0))}
        {v.format === "legacy" && v.raw && (
          <pre className="explain-raw">{v.raw}</pre>
        )}
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
      showToast("读取历史失败: " + String(e));
    }
  };

  const loadQuery = (item: QueryItem) => {
    // Restore the connection + database the query was logged under, so the
    // user lands back in the same context they ran it from. If the connection
    // has been deleted, fall back to loading only the SQL into the current tab.
    const conn = item.conn_id ? findConn(item.conn_id) : undefined;
    if (conn) setSelId(conn.id);
    setActiveTab((t) => ({
      ...t,
      sql: item.sql,
      connId: conn ? conn.id : t.connId,
      db: conn ? (item.db ?? "") : t.db,
      // Carry a snippet's name onto the tab so the title stays meaningful.
      ...(item.name ? { name: item.name } : {}),
    }));
    editorRef.current?.replaceValue(item.sql);
    editorRef.current?.view.focus();
    setHistoryOpen(false);
  };

  const saveSnippetFromItem = async (item: QueryItem) => {
    const name = await promptAsync("片段名称", item.name ?? "我的查询");
    if (!name || !name.trim()) return;
    try {
      await api.saveQuery(item.id, name.trim(), item.sql, item.conn_id, item.db);
      setHistory(await api.listQueries());
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };

  const saveCurrentAsSnippet = async () => {
    const sql = editorRef.current?.getDoc() ?? "";
    if (!sql.trim()) return;
    const name = await promptAsync("片段名称", "我的查询");
    if (!name || !name.trim()) return;
    try {
      await api.saveQuery(null, name.trim(), sql, active.connId || selId || null, active.db);
      showToast("已保存为片段");
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };

  const deleteQueryItem = async (item: QueryItem) => {
    if (!await confirmAsync("删除该记录？")) return;
    try {
      await api.deleteQuery(item.id);
      setHistory(await api.listQueries());
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  /// Open the write-guardrail audit trail. Loaded on demand rather than kept
  /// in state: it's a rarely-opened forensic view, and the table only grows.
  const openAudit = async () => {
    setAuditOpen(true);
    try {
      setAuditRows(await api.listAuditLogs(200));
    } catch (e) {
      setAuditRows([]);
      showToast("读取审计日志失败: " + String(e));
    }
  };

  const sendChat = async () => {
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    const text = input.value;
    if (!text.trim() || streaming) return;
    const next: ChatItem[] = [...chat, { role: "user", content: text }];
    setChat(next);
    input.value = "";
    setStreaming(true);
    setLastUsage(null);
    setChat((prev) => [...prev, { role: "assistant", content: "" }]);
    try {
      // The chat log is a human transcript, not the model's context. Plan
      // cards and tool breadcrumbs are display-only: `plan` has no Rust
      // `ChatRole`, and a `tool` message without its originating
      // `tool_call_id` makes the OpenAI API reject the whole request. The
      // model already saw the real tool results inside its own turn, so only
      // user/assistant text is replayed. Empty assistant placeholders (the
      // streaming bubble) are dropped too.
      const history = next.filter(
        (m): m is ChatMessage =>
          m.role === "user" ||
          (m.role === "assistant" && m.content.trim() !== ""),
      );
      turnIdRef.current = await chatTurn(selId, history);
    } catch (e) {
      setStreaming(false);
      turnIdRef.current = null;
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + String(e) }]);
    }
  };

  /// Stop the running turn. Best-effort: the backend flips a flag, the agent
  /// abandons its stream at the next chunk, and `chat-done` still arrives —
  /// so we don't clear `streaming` here.
  const stopChat = async () => {
    const id = turnIdRef.current;
    if (!id) return;
    try {
      await cancelTurn(id);
    } catch {
      // Already finished — nothing to stop.
    }
  };

  /// Answer the head of the confirmation queue.
  const answerConfirm = async (approved: boolean) => {
    const req = confirmQueue[0];
    if (!req) return;
    setConfirmQueue((prev) => prev.slice(1));
    try {
      await resolveConfirm(req.turn_id, req.id, approved);
    } catch (e) {
      setChat((prev) => [
        ...prev,
        { role: "tool", content: "确认失败: " + String(e) },
      ]);
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
    const r = await promptEnvType("新建环境");
    if (!r || !r.name.trim()) return;
    try {
      await api.createEnvironment(r.name.trim(), r.dbType);
      await refresh();
    } catch (e) {
      showToast("创建环境失败: " + String(e));
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
          showToast("创建环境失败: " + String(e));
          return;
        }
      } else {
        envId = envs[0].id;
      }
    }
    const name = await promptAsync("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      showToast("创建分组失败: " + String(e));
    }
  };

  // Create a group under an explicit environment (right-click "新建组" on an env).
  const newGroupUnder = async (envId: string) => {
    const name = await promptAsync("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      showToast("创建分组失败: " + String(e));
    }
  };

  const renameContainer = async (id: string, oldName: string) => {
    const name = await promptAsync("重命名", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    try {
      await api.renameContainer(id, name.trim());
      await refresh();
    } catch (e) {
      showToast("重命名失败: " + String(e));
    }
  };

  const removeContainer = async (id: string) => {
    if (!await confirmAsync("确认删除该容器？若其中还有分组或连接将无法删除。")) return;
    try {
      await api.deleteContainer(id);
      await refresh();
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  const openAddSeed = (seed: Partial<ConnInput>) => {
    setAddOpen(false);
    setFormTab("basic");
    setForm({ open: true, editing: false, cfg: { ...emptyForm(), ...seed } });
  };

  const openEditFor = (id: string) => {
    const c = findConn(id);
    if (!c) return;
    setFormTab("basic");
    setForm({ open: true, editing: true, cfg: { ...emptyForm(), ...c, password: "" } });
  };
  const saveForm = async () => {
    try {
      if (form.editing) await api.updateConnection(form.cfg);
      else await api.addConnection(form.cfg);
      setForm({ ...form, open: false });
      await refresh();
      if (form.editing) await loadSchema(form.cfg.id);
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };
  const delConnFor = async (id: string) => {
    if (!id) return;
    if (!await confirmAsync("确认删除该连接？")) return;
    await api.deleteConnection(id);
    if (id === selId) setSelId("");
    await refresh();
  };
  const testForm = async () => {
    try {
      const ok = await api.testConnection(form.cfg);
      showToast(ok ? "连接成功" : "连接失败");
    } catch (e) {
      showToast("连接失败: " + String(e));
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
    // The plan arrives as its own card, then a fresh assistant bubble takes
    // over so the worker output doesn't get appended onto the plan.
    onChatPlan((steps) => {
      setChat((prev) => [
        ...prev,
        { role: "plan", content: "", steps },
        { role: "assistant", content: "" },
      ]);
    }).then((u) => unsubs.push(u));
    onChatConfirm((req) => {
      setConfirmQueue((prev) => [...prev, req]);
    }).then((u) => unsubs.push(u));
    // Cost lands just before `chat-done`. Providers that stay silent leave
    // `lastUsage` at null, so the footer shows nothing rather than a fake 0.
    onChatUsage((u) => {
      setLastUsage(u);
      setSessionTokens((prev) => prev + (u.total_tokens || 0));
    }).then((u) => unsubs.push(u));
    onChatDone(() => {
      setStreaming(false);
      turnIdRef.current = null;
      setConfirmQueue([]);
    }).then((u) => unsubs.push(u));
    onChatError((t) => {
      setStreaming(false);
      turnIdRef.current = null;
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + t }]);
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  return (
    <div className="root">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-title">ChatQuery</span>
      </div>
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
          onNewConnection={(groupId) => openAddSeed({ group_id: groupId })}
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
              <button className="primary" onClick={() => void runQuery()}>
                执行
              </button>
            </div>
          </div>
          <div
            id="editor"
            className="editor"
            onContextMenu={(e) => {
              e.preventDefault();
              const sel = editorRef.current?.getSelection().trim() ?? "";
              setEditorMenu({
                x: e.clientX,
                y: e.clientY,
                hasSel: sel.length > 0,
              });
            }}
          />
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
              <button
                className={"rtab" + (resultTab === "explain" ? " active" : "")}
                disabled={!explainView}
                onClick={() => setResultTab("explain")}
              >
                执行计划
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
                  {/* #3: grid search + per-column filters */}
                  <span className="grid-search">
                    <input
                      placeholder="搜索当前页…"
                      value={gridSearch}
                      onChange={(e) => setGridSearch(e.target.value)}
                    />
                    <label className="case-toggle" title="区分大小写">
                      <input
                        type="checkbox"
                        checked={gridCase}
                        onChange={(e) => setGridCase(e.target.checked)}
                      />
                      Aa
                    </label>
                    {(Object.keys(colFilters).length > 0 || gridSearch.trim()) && (
                      <button
                        className="clear-filter"
                        onClick={() => {
                          setColFilters({});
                          setGridSearch("");
                          setGridSort(null);
                        }}
                        title="清除全部筛选/排序/搜索"
                      >
                        清除
                      </button>
                    )}
                  </span>
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
            ) : resultTab === "explain" ? (
              explainView ? (
                renderExplain(explainView)
              ) : (
                <div className="empty">点击「执行计划」按钮生成可视化</div>
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
            title="写操作审计日志"
            onClick={() => void openAudit()}
          >
            🛡
          </button>
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
          {chat.map((m, i) =>
            m.role === "plan" ? (
              <div key={i} className="chat-plan">
                <div className="chat-plan-head">执行计划</div>
                <ol className="chat-plan-steps">
                  {m.steps.map((s, j) => (
                    <li key={j}>{s}</li>
                  ))}
                </ol>
              </div>
            ) : (
              <div key={i} className={"msg " + m.role}>
                <div className="msg-actions">
                  <button
                    type="button"
                    className={"msg-copy" + (copiedIdx === i ? " copied" : "")}
                    title="复制消息"
                    onClick={async () => {
                      const ok = await copyText(m.content || "");
                      if (ok) {
                        setCopiedIdx(i);
                        setTimeout(() => setCopiedIdx((p) => (p === i ? null : p)), 1500);
                      }
                    }}
                  >
                    {copiedIdx === i ? "✓" : <CopyIcon />}
                  </button>
                </div>
                {m.role === "user" ? (
                  <div className="msg-body">{m.content || "…"}</div>
                ) : (
                  <div className="msg-bubble">
                    <div className="msg-role">{roleLabel(m.role)}</div>
                    <div className="msg-body">
                      <MarkdownMessage content={m.content || "…"} />
                    </div>
                  </div>
                )}
              </div>
            ),
          )}
          <div ref={chatEndRef} />
        </div>
        {(lastUsage || sessionTokens > 0) && (
          <div className="chat-usage" title="LLM token 用量（ADR-AI-4）">
            {lastUsage ? (
              <>
                <span>⚡ 本轮 {fmtNum(lastUsage.total_tokens)} tokens</span>
                <span className="dim">
                  （入 {fmtNum(lastUsage.prompt_tokens)} / 出{" "}
                  {fmtNum(lastUsage.completion_tokens)}）
                </span>
              </>
            ) : (
              <span className="dim">⚡ 本轮用量未上报</span>
            )}
            <span className="dim">· 会话累计 {fmtNum(sessionTokens)}</span>
          </div>
        )}
        <div className="chat-input">
          <textarea
            id="chat-input"
            placeholder="问点什么，例如：统计 users 表行数"
            disabled={streaming}
          />
          {streaming ? (
            <button className="danger" onClick={stopChat} title="停止本轮">
              停止
            </button>
          ) : (
            <button onClick={sendChat} disabled={!status.llm_enabled}>
              发送
            </button>
          )}
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
          <div className="modal conn-modal">
            <h3>{form.editing ? "编辑连接" : "新增连接"}</h3>

            {/* Tab navigation: 基础 / SSL / SSH (#4, #5) */}
            <div className="conn-tabs">
              <button
                type="button"
                className={"conn-tab" + (formTab === "basic" ? " active" : "")}
                onClick={() => setFormTab("basic")}
              >
                🔌 基础
              </button>
              <button
                type="button"
                className={"conn-tab" + (formTab === "ssl" ? " active" : "")}
                onClick={() => setFormTab("ssl")}
              >
                🔒 SSL / TLS
              </button>
              <button
                type="button"
                className={"conn-tab" + (formTab === "ssh" ? " active" : "")}
                onClick={() => setFormTab("ssh")}
              >
                🖥 SSH 隧道
              </button>
            </div>

            <div className="conn-tab-body">
              {formTab === "basic" && (
                <>
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
                  <div className="form-row">
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
                  </div>
                  <div className="form-row">
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
                  </div>
                  <div className="form-row">
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
                  </div>
                </>
              )}

              {formTab === "ssl" && (
                <div className="form-section in-tab">
                  <div className="form-section-title">SSL / TLS 加密</div>
                  <DropdownSelect
                    label="模式"
                    value={form.cfg.ssl_mode}
                    options={[
                      { value: "", label: "（不使用）" },
                      { value: "preferred", label: "preferred" },
                      { value: "required", label: "required" },
                      { value: "verify_ca", label: "verify_ca" },
                      { value: "verify_identity", label: "verify_identity" },
                    ]}
                    onChange={(v) =>
                      setForm({ ...form, cfg: { ...form.cfg, ssl_mode: v } })
                    }
                  />
                  <div className="form-row">
                    <label>
                      CA 证书
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.ssl_ca}
                          placeholder="PEM 文本或路径，可选"
                          onChange={(e) =>
                            setForm({ ...form, cfg: { ...form.cfg, ssl_ca: e.target.value } })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.crt,.cer,.ca,.key,.txt"
                          onPick={(t) =>
                            setForm({ ...form, cfg: { ...form.cfg, ssl_ca: t } })
                          }
                        />
                      </div>
                    </label>
                    <label>
                      客户端证书
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.client_cert}
                          placeholder="PEM 文本或路径，可选"
                          onChange={(e) =>
                            setForm({ ...form, cfg: { ...form.cfg, client_cert: e.target.value } })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.crt,.cer,.ca,.key,.txt"
                          onPick={(t) =>
                            setForm({ ...form, cfg: { ...form.cfg, client_cert: t } })
                          }
                        />
                      </div>
                    </label>
                  </div>
                  <label>
                    客户端私钥
                    <div className="input-with-btn">
                      <input
                        value={form.cfg.client_key}
                        placeholder="PEM 文本或路径，可选"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, client_key: e.target.value } })
                        }
                      />
                      <CertPickButton
                        accept=".pem,.key,.txt"
                        onPick={(t) =>
                          setForm({ ...form, cfg: { ...form.cfg, client_key: t } })
                        }
                      />
                    </div>
                  </label>
                </div>
              )}

              {formTab === "ssh" && (
                <div className="form-section in-tab">
                  <div className="form-section-title">SSH 隧道（跳板机，可选）</div>
                  <div className="form-row">
                    <label>
                      跳板机主机
                      <input
                        value={form.cfg.ssh_host}
                        placeholder="留空表示直连"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, ssh_host: e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      跳板机端口
                      <input
                        type="number"
                        value={form.cfg.ssh_port}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cfg: { ...form.cfg, ssh_port: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    跳板机用户
                    <input
                      value={form.cfg.ssh_user}
                      onChange={(e) =>
                        setForm({ ...form, cfg: { ...form.cfg, ssh_user: e.target.value } })
                      }
                    />
                  </label>
                  <DropdownSelect
                    label="认证方式"
                    value={form.cfg.ssh_auth_kind}
                    options={[
                      { value: "password", label: "密码" },
                      { value: "private_key", label: "私钥" },
                    ]}
                    onChange={(v) =>
                      setForm({ ...form, cfg: { ...form.cfg, ssh_auth_kind: v } })
                    }
                  />
                  {form.cfg.ssh_auth_kind === "password" ? (
                    <label>
                      跳板机密码
                      <input
                        type="password"
                        value={form.cfg.ssh_password}
                        placeholder="可选"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, ssh_password: e.target.value } })
                        }
                      />
                    </label>
                  ) : (
                    <label>
                      私钥（PEM 文本或文件路径）
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.ssh_private_key}
                          placeholder="可选"
                          onChange={(e) =>
                            setForm({
                              ...form,
                              cfg: { ...form.cfg, ssh_private_key: e.target.value },
                            })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.key,.txt,id_rsa,id_ed25519"
                          onPick={(t) =>
                            setForm({
                              ...form,
                              cfg: { ...form.cfg, ssh_private_key: t },
                            })
                          }
                        />
                      </div>
                    </label>
                  )}
                </div>
              )}
            </div>

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

      {historyOpen && (() => {
        const kw = historySearch.trim().toLowerCase();
        const visible = history.filter((h) => {
          const isSnippet = !!h.name;
          if (historyTab === "snippet" ? !isSnippet : isSnippet) return false;
          if (historyConn && h.conn_id !== historyConn) return false;
          if (
            kw &&
            !h.sql.toLowerCase().includes(kw) &&
            !(h.db ?? "").toLowerCase().includes(kw) &&
            !(h.name ?? "").toLowerCase().includes(kw)
          )
            return false;
          return true;
        });
        return (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>查询历史 / 片段</h3>
            <div className="seg">
              <button
                className={historyTab === "history" ? "seg-on" : ""}
                onClick={() => setHistoryTab("history")}
              >
                历史
              </button>
              <button
                className={historyTab === "snippet" ? "seg-on" : ""}
                onClick={() => setHistoryTab("snippet")}
              >
                片段
              </button>
            </div>
            <div className="history-toolbar">
              <input
                className="history-search"
                placeholder="搜索 SQL 或库名…"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              <div className="history-conn">
                <DropdownSelect
                  value={historyConn}
                  options={[
                    { value: "", label: "全部连接" },
                    ...allConns.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  onChange={(v) => setHistoryConn(v)}
                />
              </div>
            </div>
            <div className="history-list">
              {visible.length === 0 && <div className="empty">暂无记录</div>}
              {visible.map((h) => (
                <div key={h.id} className="history-item">
                  {h.name && <div className="history-title">{h.name}</div>}
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
        );
      })()}

      {auditOpen && (
        <div className="modal-mask" onClick={() => setAuditOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>写操作审计日志</h3>
            <p className="hint">
              AI 每次触碰写语句都会留痕：批准、拒绝、超时、直接阻断（DDL /
              破坏性语句）。只读查询不记录。最近 200 条，新的在前。
            </p>
            <div className="audit-list">
              {auditRows.length === 0 && <div className="empty">暂无记录</div>}
              {auditRows.map(([conn, db, sql, decision, ts], i) => (
                <div key={i} className="audit-item">
                  <div className="audit-meta">
                    <span className={"audit-tag audit-" + decision}>
                      {auditLabel(decision)}
                    </span>
                    <span>{conn}</span>
                    {db ? <span className="history-db">▦ {db}</span> : null}
                    <span className="history-time">{fmtTime(ts)}</span>
                  </div>
                  <pre className="history-sql">{sql}</pre>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setAuditOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div
            className={
              "modal settings-modal" + (settingsTab === "kb" ? " kb-wide" : "")
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-nav">
              <div className="settings-nav-title">设置</div>
              <button
                className={"nav-item" + (settingsTab === "model" ? " active" : "")}
                onClick={() => setSettingsTab("model")}
              >
                模型设置
              </button>
              <button
                className={"nav-item" + (settingsTab === "key" ? " active" : "")}
                onClick={() => setSettingsTab("key")}
              >
                连接加密
              </button>
              <button
                className={"nav-item" + (settingsTab === "general" ? " active" : "")}
                onClick={() => setSettingsTab("general")}
              >
                通用
              </button>
              <button
                className={"nav-item" + (settingsTab === "kb" ? " active" : "")}
                onClick={() => setSettingsTab("kb")}
              >
                知识库
              </button>
            </div>

            <div className="settings-content">
              {/* --- 模块一：模型设置（LLM） --- */}
              {settingsTab === "model" && (
                <div className="settings-page">
                  <h3>模型设置</h3>
                  <div className="settings-group">
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
                      onChange={(e) =>
                        setCfgForm({ ...cfgForm, model: e.target.value })
                      }
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
                  {cfgMsg && (
                    <div className={"cfg-msg " + (cfgMsg.ok ? "ok" : "err")}>
                      {cfgMsg.text}
                    </div>
                  )}
                  </div>
                  <div className="modal-actions">
                    <button className="primary" onClick={() => void saveSettings()}>
                      保存
                    </button>
                  </div>
                </div>
              )}

              {/* --- 模块二：连接加密密钥 (#0) --- */}
              {settingsTab === "key" && (
                <div className="settings-page">
                  <h3>连接加密密钥</h3>
                  <div className="settings-group">
                  <div className={"key-status " + (keyStatus.configured ? "on" : "off")}>
                    当前状态：{keyStatus.configured ? "已配置自定义密钥" : "使用默认密钥（换机器/换人无法解密导出文件）"}
                  </div>
                  {!keyStatus.configured && (
                    <div className="key-warn">
                      ⚠️ 尚未配置自定义密钥。导入/导出用的 system-key 加密将退化为默认密钥，
                      换机器后无法解密。建议在此设置一个自定义密钥（导出与导入两端使用相同密钥即可互通）。
                    </div>
                  )}
                  <label>
                    密钥口令（用于派生 AES 密钥；留空则重置回默认）
                    <input
                      type="password"
                      value={keyField}
                      placeholder="设置一个易记的口令"
                      onChange={(e) => setKeyField(e.target.value)}
                    />
                  </label>
                  </div>
                  <div className="modal-actions">
                    <button className="primary" onClick={() => void saveKey()}>
                      保存密钥并重加密
                    </button>
                  </div>
                  {keyMsg && (
                    <div className={"cfg-msg " + (keyMsg.ok ? "ok" : "err")}>
                      {keyMsg.text}
                    </div>
                  )}
                </div>
              )}

              {/* --- 模块三：通用偏好 --- */}
              {settingsTab === "general" && (
                <div className="settings-page">
                  <h3>通用</h3>
                  <div className="settings-group">
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
                  </div>
                </div>
              )}

              {/* --- 模块四：知识库 (ADR-AI-6) --- */}
              {settingsTab === "kb" && (
                <div className="settings-page kb-page">
                  <div className="kb-layout">
                    {/* 左：文档列表 */}
                    <div className="kb-list">
                      <div className="kb-list-header">
                        <span>知识库文档</span>
                        <button className="kb-new" onClick={startNewKb}>
                          ＋ 新建
                        </button>
                      </div>
                      <div className="kb-list-scroll">
                        {kbDocs.length === 0 && (
                          <div className="kb-empty">暂无文档，点击上方新建</div>
                        )}
                        {kbDocs.map((d) => (
                          <div
                            key={d.id}
                            className={
                              "kb-list-item" +
                              (kbEditing && kbEditing.id === d.id ? " active" : "")
                            }
                            onClick={() => editKb(d)}
                          >
                            <div className="kb-list-name">{d.name}</div>
                            <div className="kb-list-meta">
                              {d.bindings.length} 个绑定 · {d.content.length} 字
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 右：编辑器 */}
                    <div className="kb-editor">
                      {!kbIsNew && !kbEditing ? (
                        <div className="kb-empty-large">
                          选择左侧文档编辑，或点击「新建」开始。
                        </div>
                      ) : (
                        <div className="kb-editor-card">
                          <label>
                            名称
                            <input
                              value={kbName}
                              placeholder="例如：订单库业务说明"
                              onChange={(e) => setKbName(e.target.value)}
                            />
                          </label>

                          <label className="kb-content-label">
                            内容（纯文本 / Markdown）
                            <div className="kb-content-row">
                              <textarea
                                className="kb-textarea"
                                value={kbContent}
                                placeholder="粘贴或撰写知识内容，例如表含义、字段口径、统计口径、常见查询示例…"
                                onChange={(e) => setKbContent(e.target.value)}
                              />
                              <CertPickButton
                                accept=".txt,.md,.markdown,.text,text/plain,text/markdown"
                                title="从文件导入（.txt / .md）"
                                onPick={(t) => setKbContent(t)}
                              />
                            </div>
                            <span className="kb-count">{kbContent.length} 字</span>
                          </label>

                          <div className="kb-bindings">
                            <div className="kb-bindings-head">
                              <span>绑定到连接 / 数据库</span>
                              <span className="kb-bindings-sub">
                                绑定后 AI 会在对应连接 / 库下引用本文档
                              </span>
                            </div>
                            {kbBindings.length === 0 && (
                              <div className="kb-empty">尚未绑定任何连接</div>
                            )}
                            {kbBindings.map((b, i) => {
                              const c = allConns.find((x) => x.id === b.conn_id);
                              return (
                                <div className="kb-binding-row" key={i}>
                                  <span className="kb-binding-conn">
                                    {c ? c.name : b.conn_id}
                                  </span>
                                  <span className="kb-binding-db">
                                    {b.database ?? "整条连接"}
                                  </span>
                                  <button
                                    className="kb-binding-del"
                                    title="移除该绑定"
                                    onClick={() => removeKbBinding(i)}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                            <div className="kb-binding-add">
                              <select
                                value={kbNewConn}
                                onChange={(e) => {
                                  setKbNewConn(e.target.value);
                                  setKbNewDb("");
                                  if (e.target.value) void loadKbDbs(e.target.value);
                                }}
                              >
                                <option value="">选择连接…</option>
                                {allConns.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={kbNewDb}
                                disabled={!kbNewConn}
                                onChange={(e) => setKbNewDb(e.target.value)}
                              >
                                <option value="">整条连接</option>
                                {(kbDbCache[kbNewConn] ?? []).map((db) => (
                                  <option key={db} value={db}>
                                    {db}
                                  </option>
                                ))}
                                {kbLoadingDbs === kbNewConn && (
                                  <option value="">加载中…</option>
                                )}
                              </select>
                              <button
                                className="primary"
                                disabled={!kbNewConn}
                                onClick={() => {
                                  addKbBinding(
                                    kbNewConn,
                                    kbNewDb === "" ? null : kbNewDb
                                  );
                                  setKbNewDb("");
                                }}
                              >
                                添加
                              </button>
                            </div>
                          </div>

                          <div className="modal-actions">
                            <button
                              className="primary"
                              onClick={() => void saveKbDoc()}
                            >
                              {kbEditing ? "保存文档" : "创建文档"}
                            </button>
                            {kbEditing && (
                              <button
                                className="primary danger"
                                onClick={() => void deleteKb(kbEditing)}
                              >
                                删除
                              </button>
                            )}
                          </div>
                          {kbMsg && (
                            <div className={"cfg-msg " + (kbMsg.ok ? "ok" : "err")}>
                              {kbMsg.text}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              className="settings-close"
              onClick={() => setSettingsOpen(false)}
              title="关闭"
            >
              ×
            </button>
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
            {ctxMenu.cell && result?.kind === "table" && (
              <>
                <div className="ctx-title">
                  单元格：
                  {result.columns[ctxMenu.cell.ci] ?? `#${ctxMenu.cell.ci + 1}`}
                </div>
                <button
                  onClick={() =>
                    void copyCell(ctxMenu.cell!.ri, ctxMenu.cell!.ci)
                  }
                >
                  复制单元格
                </button>
                <div className="ctx-sep" />
              </>
            )}
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
            {ctxMenu.col != null && (
              <>
                <div className="ctx-title">
                  列筛选：
                  {result?.kind === "table" ? result.columns[ctxMenu.col] : ""}
                </div>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "contains")}>
                  包含…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "equals")}>
                  等于…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "nequals")}>
                  不等于…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "range")}>
                  数值范围…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "empty")}>
                  为空
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "notempty")}>
                  非空
                </button>
                {colFilters[ctxMenu.col] && (
                  <button onClick={() => clearColFilter(ctxMenu.col!)}>
                    清除该列筛选
                  </button>
                )}
                <div className="ctx-sep" />
              </>
            )}
            {ctxMenu.rows.length > 0 ? (
              <>
            <div className="ctx-title">复制选中 {ctxMenu.rows.length} 行</div>
            <button onClick={() => void copyRowsAs("json")}>复制为 JSON</button>
            <button
              onClick={() => void copyRowsAs("insert")}
            >
              复制为 INSERT 语句
            </button>
            <button
              onClick={() => void copyRowsAs("update")}
            >
              复制为 UPDATE 语句
              {result?.kind === "table" &&
              (result.primaryKeys?.length ?? 0) === 0
                ? result.columns.some((c) => c.toLowerCase() === "id")
                  ? "（按 ID 定位）"
                  : "（全列定位）"
                : ""}
            </button>
              </>
            ) : null}
          </div>
        </>
      )}

      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          onClose={() => setEditorMenu(null)}
          items={buildEditorMenu(editorMenu.hasSel)}
        />
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

      {dlg && (
        <div
          className="modal-mask"
          onMouseDown={() => closeDlg(dlg.kind === "confirm" ? false : null)}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{dlg.title}</h3>
            {dlg.kind === "prompt" ? (
              <input
                id="dlg-input"
                defaultValue={dlg.def}
                autoFocus
                onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  if (e.key === "Enter") closeDlg(v);
                  if (e.key === "Escape") closeDlg(null);
                }}
              />
            ) : dlg.kind === "envType" ? (
              <>
                <input
                  id="env-name-input"
                  value={envDlgName}
                  autoFocus
                  placeholder="环境名称"
                  onChange={(e) => setEnvDlgName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      closeDlg({ name: envDlgName.trim(), dbType: envDlgType });
                    if (e.key === "Escape") closeDlg(null);
                  }}
                />
                <div className="seg">
                  <button
                    className={envDlgType === "mysql" ? "seg-on" : ""}
                    onClick={() => setEnvDlgType("mysql")}
                  >
                    MySQL
                  </button>
                  <button
                    className={envDlgType === "redis" ? "seg-on" : ""}
                    onClick={() => setEnvDlgType("redis")}
                  >
                    Redis
                  </button>
                </div>
              </>
            ) : (
              <p className="modal-msg">{dlg.message}</p>
            )}
            <div className="modal-actions">
              <button
                onClick={() => closeDlg(dlg.kind === "confirm" ? false : null)}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  if (dlg.kind === "prompt") {
                    const el = document.getElementById("dlg-input") as HTMLInputElement | null;
                    closeDlg(el ? el.value : dlg.def);
                  } else if (dlg.kind === "envType") {
                    closeDlg({ name: envDlgName.trim(), dbType: envDlgType });
                  } else {
                    closeDlg(true);
                  }
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI write confirmation (ADR-AI-1 / ADR-AI-4). The turn is blocked on
          this answer, so there is no mask-click / Escape dismissal — an
          accidental click must not silently reject a pending write. */}
      {confirmQueue.length > 0 && (
        <div className="modal-mask">
          <div className="modal ai-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <h3>AI 请求执行写操作</h3>
            <p className="modal-msg">{confirmQueue[0].reason}</p>
            <div className="ai-confirm-meta">
              连接：<b>{confirmQueue[0].connection}</b>
              {confirmQueue.length > 1 && (
                <span className="ai-confirm-more">
                  还有 {confirmQueue.length - 1} 条待确认
                </span>
              )}
            </div>
            <pre className="ai-confirm-sql">{confirmQueue[0].sql}</pre>
            <p className="ai-confirm-warn">
              执行后无法自动撤销，请确认语句的 WHERE 条件与影响范围。
            </p>
            <div className="modal-actions">
              <button onClick={() => answerConfirm(false)}>拒绝</button>
              <button className="primary danger" onClick={() => answerConfirm(true)}>
                执行
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
    </div>
  );
}

/// Serialize a table result to CSV with proper RFC-4180 quoting.
function fmtCell(c: unknown): string {
  return c == null ? "" : typeof c === "object" ? JSON.stringify(c) : String(c);
}

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

/// Best-effort extraction of a single table name from a SQL statement's
/// FROM clause. Handles `FROM \`table\``, `FROM table`, and
/// `FROM db.table`. Returns null for JOINs, subqueries, and UNIONs (more
/// than one table in the FROM), so the caller can fall back to a placeholder.
function extractTableFromSql(sql: string): string | null {
  // Remove newlines for easier matching, keep original for fallback.
  const flat = sql.replace(/\n/g, " ");
  // Match FROM clause: capture the table identifier. Stop at the first
  // JOIN/ON/WHERE/GROUP/ORDER/LIMIT/HAVING/semicolon to avoid grabbing
  // multiple tables.
  const m = flat.match(
    /\bFROM\s+`?(\w+)`?(?:\s*`?\s*\.?\s*`?(\w+)`?)?\s*(?:\s+(?:JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|;|$))/i
  );
  if (!m) return null;
  // db.table form — take just the table part (last capture group).
  return m[2] || m[1];
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
  const tname = table.replace(/`/g, "``");
  // No primary keys: fall back to using every column in both SET and WHERE.
  // This produces a template the user edits — change SET values to the new
  // data, WHERE stays as-is to locate the row. It's verbose but correct.
  if (pks.length === 0) {
    const stmts = rows.map((r) => {
      const set = columns
        .map((c, i) => `${escId(c)}=${sqlLit(r[i] ?? "")}`)
        .join(", ");
      const where = columns
        .map((c, i) => `${escId(c)}=${sqlLit(r[i] ?? "")}`)
        .join(" AND ");
      return `UPDATE \`${tname}\` SET ${set} WHERE ${where};`;
    });
    return stmts.join("\n");
  }
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
    return `UPDATE \`${tname}\` SET ${set} WHERE ${where};`;
  });
  return stmts.join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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

/// Thousands separator for token counts — five-digit numbers are common and
/// unreadable unsegmented.
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/// Human label for a guardrail verdict stored in the audit trail.
function auditLabel(d: string): string {
  switch (d) {
    case "write-approved":
      return "已批准";
    case "write-rejected":
      return "已拒绝";
    case "write-expired":
      return "已超时";
    case "deny":
      return "已阻断";
    default:
      return d;
  }
}
