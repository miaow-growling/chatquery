import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { ColumnInfo, ConnSummary, TreeModel } from "./types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ScrollArea } from "./ScrollArea";
import { Icon, type IconName } from "./components/ui";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

/// Rows fetched per page when browsing a table.
const PAGE_SIZE = 200;
/// Max table nodes rendered at once in the tree. Above this we window (filter
/// input + "show more") so an 8000-table database never mounts tens of
/// thousands of DOM nodes at once.
const TREE_PAGE = 200;

// ---------------------------------------------------------------------------
// Tree node model. Environment/group/connection nodes have static children
// (built from `tree`); everything below a connection is loaded lazily on
// expand and cached by node key. Environments and groups are first-class
// entities (ADR-016), so empty ones render naturally with no connections.
// ---------------------------------------------------------------------------

type Node =
  | { kind: "dbtype"; key: string; name: string; children: Node[]; count?: number }
  | { kind: "env"; key: string; id: string; name: string; children: Node[]; count?: number }
  | { kind: "group"; key: string; id: string; name: string; children: Node[]; count?: number }
  | { kind: "conn"; key: string; conn: ConnSummary; count?: number }
  | { kind: "db"; key: string; connId: string; db: string; count?: number }
  | {
      kind: "folder";
      key: string;
      label: string;
      connId: string;
      db: string;
      folder: "tables" | "views";
      count?: number;
    }
  | {
      kind: "table";
      key: string;
      connId: string;
      db: string;
      name: string;
      isView: boolean;
      comment?: string;
      count?: number;
    }
  | {
      kind: "column";
      key: string;
      connId: string;
      db: string;
      table: string;
      col: ColumnInfo;
    }
  | { kind: "redisdb"; key: string; connId: string; db: number; count?: number };

const LAZY = new Set(["conn", "db", "folder", "table"]);
const isLazy = (n: Node) => LAZY.has(n.kind);

function connNode(c: ConnSummary): Node {
  return { kind: "conn", key: `conn:${c.id}`, conn: c };
}

function buildRoots(tree: TreeModel): Node[] {
  const labelOf = (t: string) => {
    if (t === "redis") return "Redis";
    if (t === "mysql") return "MySQL";
    return t;
  };

  // Collect all connection types actually present. Even if an environment's
  // declared db_type is mysql, if it contains redis connections we want a
  // Redis root with that environment under it (and vice versa). Empty envs
  // still follow their declared db_type so they don't disappear.
  const presentTypes = new Set<string>();
  for (const env of tree.environments) {
    presentTypes.add(env.db_type || "mysql");
    for (const g of env.groups) {
      for (const c of g.connections) presentTypes.add(c.db_type);
    }
  }
  const sortedTypes = [...presentTypes].sort((a, b) => {
    if (a === b) return 0;
    if (a === "mysql") return -1;
    if (b === "mysql") return 1;
    if (a === "redis") return -1;
    if (b === "redis") return 1;
    return a.localeCompare(b);
  });

  const roots: Node[] = [];
  for (const t of sortedTypes) {
    const envNodes: Node[] = [];
    for (const env of tree.environments) {
      // Keep groups that hold type-t connections. Empty groups are first-class
      // entities (ADR-016): they stay visible and follow their environment.
      const typedGroups = env.groups
        .map((g) => ({
          ...g,
          connections: g.connections.filter((c) => c.db_type === t),
          origEmpty: g.connections.length === 0,
        }))
        .filter((g) => g.connections.length > 0 || g.origEmpty);

      const hasTypedConn = typedGroups.some((g) => g.connections.length > 0);
      const envHasAnyConn = env.groups.some((g) => g.connections.length > 0);
      const declared = (env.db_type || "mysql") === t;

      // Show this env under type t only when it actually contains type-t
      // connections, or when it is a completely empty env declaring type t
      // (so empty envs don't disappear). A mysql env that only holds redis
      // connections must NOT leave a ghost empty node under the MySQL root.
      if (!hasTypedConn && (envHasAnyConn || !declared)) continue;

      envNodes.push({
        kind: "env",
        key: `env:${env.id}:${t}`,
        id: env.id,
        name: env.name,
        children: typedGroups
          .sort((a, b) => a.order - b.order)
          .map((g) => ({
            kind: "group" as const,
            key: `grp:${env.id}:${g.id}:${t}`,
            id: g.id,
            name: g.name,
            children: g.connections.map(connNode),
          })),
      });
    }
    if (envNodes.length === 0) continue;
    roots.push({
      kind: "dbtype",
      key: `type:${t}`,
      name: labelOf(t),
      children: envNodes,
    });
  }

  return roots;
}

type LoadResult = {
  nodes: Node[];
  count?: number;
  cache?: Record<string, Node[]>;
};

async function loader(node: Node): Promise<LoadResult | null> {
  switch (node.kind) {
    case "conn": {
      if (node.conn.db_type === "redis") {
        const dbs = await api.listRedisDbs(node.conn.id);
        return {
          nodes: dbs.map((item) => ({
            kind: "redisdb",
            key: `rdb:${node.conn.id}:${item.db}`,
            connId: node.conn.id,
            db: item.db,
            count: item.keys,
          })),
          count: dbs.length,
        };
      }
      const dbs = await api.listDatabases(node.conn.id);
      return {
        nodes: dbs.map((db) => ({
          kind: "db",
          key: `db:${node.conn.id}:${db}`,
          connId: node.conn.id,
          db,
        })),
        count: dbs.length,
      };
    }
    case "db": {
      // Eagerly fetch tables/views so we can show counts on the database node
      // and pre-cache the folder children (avoids a second round-trip when the
      // user expands the "表" / "视图" folders).
      const tables = await api.listTables(node.connId, node.db);
      const tableNodes = tables
        .filter((t) => !t.is_view)
        .map((t) => ({
          kind: "table" as const,
          key: `tbl:${node.connId}:${node.db}:${t.name}`,
          connId: node.connId,
          db: node.db,
          name: t.name,
          isView: false,
          comment: t.comment,
        }));
      const viewNodes = tables
        .filter((t) => t.is_view)
        .map((t) => ({
          kind: "table" as const,
          key: `tbl:${node.connId}:${node.db}:${t.name}`,
          connId: node.connId,
          db: node.db,
          name: t.name,
          isView: true,
          comment: t.comment,
        }));

      const folders: Node[] = [
        {
          kind: "folder",
          key: `tbls:${node.connId}:${node.db}`,
          label: "表",
          connId: node.connId,
          db: node.db,
          folder: "tables",
          count: tableNodes.length,
        },
      ];
      const cacheMap: Record<string, Node[]> = {
        [`tbls:${node.connId}:${node.db}`]: tableNodes,
      };

      // 仅在真实存在视图时才渲染“视图”文件夹，避免空视图文件夹制造视觉噪音
      if (viewNodes.length > 0) {
        folders.push({
          kind: "folder",
          key: `views:${node.connId}:${node.db}`,
          label: "视图",
          connId: node.connId,
          db: node.db,
          folder: "views",
          count: viewNodes.length,
        });
        cacheMap[`views:${node.connId}:${node.db}`] = viewNodes;
      }

      return {
        nodes: folders,
        count: tables.length,
        cache: cacheMap,
      };
    }
    case "folder": {
      const tables = await api.listTables(node.connId, node.db);
      const filtered = tables.filter((t) =>
        node.folder === "tables" ? !t.is_view : t.is_view
      );
      return {
        nodes: filtered.map((t) => ({
          kind: "table",
          key: `tbl:${node.connId}:${node.db}:${t.name}`,
          connId: node.connId,
          db: node.db,
          name: t.name,
          isView: t.is_view,
          comment: t.comment,
        })),
        count: filtered.length,
      };
    }
    case "table": {
      const cols = await api.listColumns(node.connId, node.db, node.name);
      return {
        nodes: cols.map((col) => ({
          kind: "column",
          key: `col:${node.connId}:${node.db}:${node.name}:${col.name}`,
          connId: node.connId,
          db: node.db,
          table: node.name,
          col,
        })),
        count: cols.length,
      };
    }
    default:
      return null;
  }
}

// Tree node badge: returns IconName + brand color class. We deliberately
// don't try to match each icon shape to its old emoji meaning — color
// (mysql-500 / redis-500 / text-secondary) is the primary visual cue, the
// shape is just a category marker.
function badge(n: Node): { icon: IconName; cls: string } {
  switch (n.kind) {
    case "dbtype":
      return n.name === "Redis"
        ? { icon: "circle", cls: "b-redis" }
        : { icon: "cylinder", cls: "b-mysql" };
    case "env":
      return { icon: "globe", cls: "b-env" };
    case "group":
      return { icon: "folder", cls: "b-group" };
    case "conn":
      return n.conn.db_type === "redis"
        ? { icon: "circle", cls: "b-redis" }
        : { icon: "cylinder", cls: "b-mysql" };
    case "db":
      return { icon: "database", cls: "b-db" };
    case "folder":
      return { icon: n.folder === "views" ? "eye" : "folder", cls: "b-folder" };
    case "table":
      return { icon: n.isView ? "eye" : "table", cls: n.isView ? "b-view" : "b-table" };
    case "column":
      // Column gets a small dot rendered via ::before — no icon needed
      return { icon: "circle", cls: "b-col" };
    case "redisdb":
      return { icon: "database", cls: "b-db" };
  }
}

/// A filter box + windowed child list, shared by the "表"/"视图" folders AND
/// by a connection's database list (one connection can hold thousands of
/// databases). We never mount the full child list — only the
/// filtered+windowed slice is rendered, so the sidebar stays responsive.
function ListView(props: {
  kids: Node[];
  depth: number;
  filter: string;
  shown: number;
  onFilter: (v: string) => void;
  onMore: () => void;
  renderChild: (c: Node) => JSX.Element;
  /// Does this child match the (already lowercased) query?
  match: (c: Node, q: string) => boolean;
  placeholder: string;
  emptyText: string;
  hideFilter?: boolean;
}) {
  const { kids, depth, filter, shown, onFilter, onMore, renderChild, match, placeholder, emptyText, hideFilter } = props;
  const q = filter.toLowerCase();
  const filtered = filter ? kids.filter((c) => match(c, q)) : kids;
  const visible = filtered.slice(0, shown);
  // Align the filter/empty/more rows with the child rows below them.
  const indent = (depth + 1) * 10 + 4;
  // 默认显示搜索过滤框；只有显式指定 hideFilter 或子项为 0 时才隐藏
  const showFilterBox = !hideFilter && (kids.length > 0 || filter.length > 0);

  return (
    <>
      {showFilterBox && (
        <div
          className="tree-filter"
          style={{ paddingLeft: `${indent}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="tree-filter-icon" aria-hidden="true">
            <Icon name="search" size={11} />
          </span>
          <input
            className="tree-filter-input"
            placeholder={placeholder}
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            onContextMenu={(e) => e.preventDefault()}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {filter && (
            <button
              type="button"
              className="tree-filter-clear"
              onClick={() => onFilter("")}
              title="清除过滤"
            >
              ×
            </button>
          )}
        </div>
      )}
      {visible.length > 0 ? (
        visible.map(renderChild)
      ) : (
        <div className="tree-empty-child" style={{ paddingLeft: `${indent}px` }}>
          {emptyText}
        </div>
      )}
      {filtered.length > shown && (
        <div
          className="tree-more"
          style={{ paddingLeft: `${indent}px` }}
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
        >
          显示更多（已显示 {shown} / 共 {filtered.length}）
        </div>
      )}
    </>
  );
}

/// Child matchers for ListView, keyed by the parent node kind.
const MATCHERS = {
  table: (c: Node, q: string) =>
    c.kind === "table" && c.name.toLowerCase().includes(q),
  db: (c: Node, q: string) =>
    (c.kind === "db" && c.db.toLowerCase().includes(q)) ||
    (c.kind === "redisdb" && `db${c.db}`.toLowerCase().includes(q)),
} as const;

/// Connections with at least this many databases get the filter box.
/// Below it the plain list is quicker to scan than a filter field.
const DB_FILTER_THRESHOLD = 10;

export interface PinnedItem {
  id: string;
  kind: "db" | "table";
  connId: string;
  connName?: string;
  db: string;
  table?: string;
  comment?: string;
  isView?: boolean;
}

interface TreeProps {
  tree: TreeModel;
  selectedConnId: string;
  selectedDb?: string | null;
  onSelectConn: (id: string) => void;
  // Selecting a database node makes it the context for ad-hoc SQL.
  onSelectDb?: (connId: string, db: string) => void;
  // "New query" from a tree node: open a fresh tab bound to this connection +
  // database (Phase 26 — per-tab context, no accidental global switch).
  onNewQuery?: (connId: string, db: string | null) => void;
  onBrowseTable: (
    connId: string,
    db: string,
    table: string,
    page?: number,
    pageSize?: number
  ) => void;
  onBrowseRedisKey: (connId: string, db: number, key: string) => void;
  onInsertColumn: (name: string) => void;
  onEditConn: (id: string) => void;
  onDeleteConn: (id: string) => void;
  onInsertText: (text: string) => void;
  onRefreshConns: () => void;
  onNewGroup: (envId: string) => void;
  onNewConnection?: (groupId: string) => void;
  onRenameContainer: (id: string, name: string) => void;
  onDeleteContainer: (id: string) => void;
  onShowStructure: (connId: string, db: string, table: string) => void;
  onShowRelationships: (connId: string, db: string) => void;
  onOpenQuickOpen?: () => void;
  onManageScripts?: (connId: string) => void;
  recentTables?: { connId: string; db: string; table: string }[];
  onRemoveRecentTable?: (connId: string, db: string, table: string) => void;
  onClearRecentTables?: () => void;
  targetFocus?: { connId: string; db: string; table?: string } | null;
}

function findConnName(tree: TreeModel, connId: string): string {
  for (const env of tree.environments) {
    for (const grp of env.groups) {
      for (const c of grp.connections) {
        if (c.id === connId) return c.name;
      }
    }
  }
  return connId;
}

function findConnSummary(tree: TreeModel, connId: string): ConnSummary | null {
  for (const env of tree.environments) {
    for (const grp of env.groups) {
      for (const c of grp.connections) {
        if (c.id === connId) return c;
      }
    }
  }
  return null;
}

function findAncestorKeysInRoots(roots: Node[], targetMatcher: (n: Node) => boolean): string[] {
  const path: string[] = [];

  function dfs(nodes: Node[]): boolean {
    for (const node of nodes) {
      path.push(node.key);
      if (targetMatcher(node)) {
        return true;
      }
      let children: Node[] = [];
      if ("children" in node && Array.isArray(node.children)) {
        children = node.children;
      }
      if (children.length > 0 && dfs(children)) {
        return true;
      }
      path.pop();
    }
    return false;
  }

  dfs(roots);
  return path;
}

function nodeMatchesQuery(node: Node, q: string): boolean {
  switch (node.kind) {
    case "dbtype":
    case "env":
    case "group":
      return node.name.toLowerCase().includes(q);
    case "conn":
      return (
        node.conn.name.toLowerCase().includes(q) ||
        (node.conn.host ? node.conn.host.toLowerCase().includes(q) : false)
      );
    case "db":
      return node.db.toLowerCase().includes(q);
    case "redisdb":
      return `db${node.db}`.toLowerCase().includes(q);
    case "folder":
      return node.label.toLowerCase().includes(q);
    case "table":
      return (
        node.name.toLowerCase().includes(q) ||
        (node.comment ? node.comment.toLowerCase().includes(q) : false)
      );
    case "column":
      return (
        node.col.name.toLowerCase().includes(q) ||
        (node.col.comment ? node.col.comment.toLowerCase().includes(q) : false) ||
        (node.col.data_type ? node.col.data_type.toLowerCase().includes(q) : false)
      );
    default:
      return false;
  }
}

function renderHighlightedText(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const idx = lowerText.indexOf(lowerQ);
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <span className="tree-match-highlight">{match}</span>
      {renderHighlightedText(after, q)}
    </>
  );
}

export function Tree(props: TreeProps) {
  const { tree, selectedConnId, selectedDb } = props;
  const roots = useMemo(() => buildRoots(tree), [tree]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("cq_tree_expanded");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>(() => {
    try {
      const raw = localStorage.getItem("cq_pinned_items");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const [pinnedOpen, setPinnedOpen] = useState(() => {
    try {
      const v = localStorage.getItem("cq_tree_pinned_open_v2");
      return v !== null ? v === "1" : false;
    } catch {
      return false;
    }
  });

  const [recentOpen, setRecentOpen] = useState(() => {
    try {
      const v = localStorage.getItem("cq_tree_recent_open_v2");
      return v !== null ? v === "1" : false;
    } catch {
      return false;
    }
  });

  const [pinnedGroupExpanded, setPinnedGroupExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("cq_tree_pinned_group_expanded");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null);

  interface PinnedGroup {
    groupKey: string;
    connId: string;
    connName: string;
    db: string;
    dbPinnedItem?: PinnedItem;
    tables: PinnedItem[];
  }

  // Group pinned items hierarchically by connection and database
  const pinnedGroups = useMemo<PinnedGroup[]>(() => {
    const map = new Map<string, PinnedGroup>();
    pinnedItems.forEach((item) => {
      const connName = item.connName || findConnName(props.tree, item.connId);
      const key = `${item.connId}:::${item.db}`;
      let grp = map.get(key);
      if (!grp) {
        grp = {
          groupKey: key,
          connId: item.connId,
          connName,
          db: item.db,
          tables: [],
        };
        map.set(key, grp);
      }
      if (item.kind === "db") {
        grp.dbPinnedItem = item;
      } else if (item.kind === "table") {
        grp.tables.push({ ...item, connName });
      }
    });
    return Array.from(map.values());
  }, [pinnedItems, props.tree]);

  // Persist expanded state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem("cq_tree_expanded", JSON.stringify(expanded));
    } catch {}
  }, [expanded]);

  useEffect(() => {
    try {
      localStorage.setItem("cq_tree_pinned_open_v2", pinnedOpen ? "1" : "0");
    } catch {}
  }, [pinnedOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("cq_tree_recent_open_v2", recentOpen ? "1" : "0");
    } catch {}
  }, [recentOpen]);

  useEffect(() => {
    try {
      localStorage.setItem("cq_tree_pinned_group_expanded", JSON.stringify(pinnedGroupExpanded));
    } catch {}
  }, [pinnedGroupExpanded]);

  const togglePin = useCallback((item: PinnedItem) => {
    setPinnedItems((prev) => {
      const exists = prev.some((p) => p.id === item.id);
      const next = exists ? prev.filter((p) => p.id !== item.id) : [...prev, item];
      try {
        localStorage.setItem("cq_pinned_items", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const [searchToggled, setSearchToggled] = useState<Record<string, boolean>>({});
  const [searchShownLimit, setSearchShownLimit] = useState<Record<string, number>>({});

  const [cache, setCache] = useState<Record<string, Node[]>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // Per-folder filter text + how many children are currently revealed (windowing).
  const [folderFilter, setFolderFilter] = useState<Record<string, string>>({});
  const [folderShown, setFolderShown] = useState<Record<string, number>>({});
  // 全局树搜索关键词
  const [searchQuery, setSearchQuery] = useState("");

  // 当搜索关键词变化时，重置搜索下的手动展开/收起覆盖状态
  useEffect(() => {
    setSearchToggled({});
    setSearchShownLimit({});
  }, [searchQuery]);
  const [deepSearchResults, setDeepSearchResults] = useState<{
    id: string;
    kind: "table" | "db";
    title: string;
    connName: string;
    connId: string;
    db: string;
    table?: string;
    comment?: string;
  }[]>([]);
  const [deepSearching, setDeepSearching] = useState(false);

  // Cross-connection deep search across unexpanded instances
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || q.length < 1) {
      setDeepSearchResults([]);
      setDeepSearching(false);
      return;
    }

    let isCancelled = false;
    const timer = setTimeout(async () => {
      setDeepSearching(true);
      const items: {
        id: string;
        kind: "table" | "db";
        title: string;
        connName: string;
        connId: string;
        db: string;
        table?: string;
        comment?: string;
      }[] = [];

      const conns: { id: string; name: string }[] = [];
      tree.environments.forEach((env) => {
        env.groups.forEach((grp) => {
          grp.connections.forEach((c) => {
            if (c.db_type !== "redis" && !conns.some((x) => x.id === c.id)) {
              conns.push({ id: c.id, name: c.name });
            }
          });
        });
      });

      try {
        const searchTasks = conns.map(async (conn) => {
          try {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 1800)
            );
            const res = await Promise.race([
              api.searchCatalog(conn.id, q, 30),
              timeoutPromise,
            ]);
            return { conn, res };
          } catch {
            return { conn, res: [] };
          }
        });

        const settled = await Promise.allSettled(searchTasks);
        for (const r of settled) {
          if (r.status === "fulfilled" && r.value) {
            const { conn, res } = r.value;
            res.forEach((item) => {
              if (item.table) {
                items.push({
                  id: `tbl:${conn.id}:${item.db}:${item.table}`,
                  kind: "table",
                  title: item.table,
                  connName: conn.name,
                  connId: conn.id,
                  db: item.db,
                  table: item.table,
                  comment: item.comment || undefined,
                });
              } else {
                items.push({
                  id: `db:${conn.id}:${item.db}`,
                  kind: "db",
                  title: item.db,
                  connName: conn.name,
                  connId: conn.id,
                  db: item.db,
                });
              }
            });
          }
        }
      } catch (err) {
        console.warn("[Tree] searchCatalog error:", err);
      } finally {
        if (!isCancelled) {
          setDeepSearchResults(items);
          setDeepSearching(false);
        }
      }
    }, 120);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
      setDeepSearching(false);
    };
  }, [searchQuery, tree]);

  // --- Connection import / export / template (#1, #2) ----------------------
  const fileRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [treeMsg, setTreeMsg] = useState<string>("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [importInputText, setImportInputText] = useState("");

  // Close the export dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as HTMLElement)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [exportMenuOpen]);

  // Trigger a browser download of `text` as `filename`.
  // Tauri 2: 用官方 dialog plugin 弹系统保存对话框 + fs plugin 写文件。
  // 旧实现靠 <a download> 在 webview 里被静默拦截，用户感觉"点完没反应"。
  const download = async (filename: string, text: string) => {
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "YAML", extensions: ["yaml", "yml"] }],
    });
    if (!path) return; // 用户取消
    await writeTextFile(path, text);
  };

  // Export all connections with chosen cipher mode (system-key or none).
  const handleExportWith = useCallback(async (mode: "system-key" | "none") => {
    setExportMenuOpen(false);
    setTreeMsg("导出中…");
    try {
      const yaml = await api.exportConnections(mode);
      const stamp = new Date().toISOString().slice(0, 10);
      download(`chatquery-connections-${stamp}.yaml`, yaml);
      setTreeMsg(mode === "none" ? "已导出（明文，含密码！）" : "已导出（已加密）");
    } catch (e) {
      setTreeMsg("导出失败: " + String(e));
    }
  }, []);

  // Import connections from text (YAML/JSON, Navicat .ncx/JSON, DataGrip XML, or JDBC/URI)
  const doImportText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTreeMsg("导入中…");
      try {
        const res = await api.importConnections(trimmed);
        const parts: string[] = [];
        if (res.connections_added > 0) {
          parts.push(`新增 ${res.connections_added} 个连接`);
        }
        if (res.connections_updated && res.connections_updated > 0) {
          parts.push(`更新/去重 ${res.connections_updated} 个连接`);
        }
        if (parts.length === 0) {
          parts.push(`连接无变更（已全部去重）`);
        }
        if (res.containers_added > 0) {
          parts.push(`新增 ${res.containers_added} 个容器`);
        }
        let msg = `导入完成：${parts.join("、")}`;
        if (res.passwords_needed.length)
          msg += `；需补密码：${res.passwords_needed.join(", ")}`;
        if (res.skipped.length) msg += `；跳过 ${res.skipped.length} 个`;
        setTreeMsg(msg);
        props.onRefreshConns();
        setShowImportModal(false);
        setImportInputText("");
      } catch (err) {
        setTreeMsg("导入失败: " + String(err));
      }
    },
    [props]
  );

  // Import connections from a user-picked file. After a successful import
  // we refresh the tree so the new nodes appear.
  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      try {
        const text = await f.text();
        await doImportText(text);
      } catch (err) {
        setTreeMsg("读取文件失败: " + String(err));
      }
    },
    [doImportText]
  );

  // Download a blank, ready-to-edit template (plaintext cipher).
  const handleTemplate = useCallback(async () => {
    try {
      const yaml = await api.exportTemplate();
      download("chatquery-template.yaml", yaml);
      setTreeMsg("模板已下载");
    } catch (e) {
      setTreeMsg("下载模板失败: " + String(e));
    }
  }, []);

  // 顶层类型节点（MySQL、Redis）默认展开：仅对从未被用户记录过的节点（undefined）做初次自动展开；
  // 用户若曾显式折叠过（false），则绝对尊重其折叠偏好，不再强行重新展开。
  useEffect(() => {
    if (roots.length === 0) return;
    setExpanded((e) => {
      const next = { ...e };
      let changed = false;
      for (const r of roots) {
        if (next[r.key] === undefined) {
          next[r.key] = true;
          changed = true;
        }
      }
      return changed ? next : e;
    });
  }, [roots]);

  const load = useCallback(async (node: Node) => {
    setLoading((l) => ({ ...l, [node.key]: true }));
    try {
      const res = await loader(node);
      if (res) {
        setCache((c) => ({ ...c, [node.key]: res.nodes, ...(res.cache ?? {}) }));
        if (res.count !== undefined) {
          setCounts((c) => ({ ...c, [node.key]: res.count! }));
        }
      } else {
        setCache((c) => ({ ...c, [node.key]: [] }));
      }
    } catch (e) {
      console.error("tree load failed", node.key, e);
      setCache((c) => ({ ...c, [node.key]: [] }));
    } finally {
      setLoading((l) => ({ ...l, [node.key]: false }));
    }
  }, []);

  // 核心：持久化展开状态自愈与深度按需恢复机制。
  // 应用重新打开时，对于此前保存在 expanded 中的懒加载节点（实例、数据库、表视图文件夹、表），
  // 会循着当前可见的展开路径自动递归触发实际数据加载，确保用户关闭时展开到哪一层，再次打开依然完整呈现哪一层！
  useEffect(() => {
    if (searchQuery.trim().length > 0) return;

    const nodesToLoad: Node[] = [];

    function findUnloaded(node: Node) {
      const isOpen = !!expanded[node.key];
      if (!isOpen) return;

      if (node.kind === "dbtype" || node.kind === "env" || node.kind === "group") {
        for (const child of node.children) {
          findUnloaded(child);
        }
      } else if (isLazy(node)) {
        const cached = cache[node.key];
        if (cached === undefined) {
          if (!loading[node.key]) {
            nodesToLoad.push(node);
          }
        } else {
          for (const child of cached) {
            findUnloaded(child);
          }
        }
      }
    }

    for (const r of roots) {
      findUnloaded(r);
    }

    for (const node of nodesToLoad) {
      void load(node);
    }
  }, [roots, expanded, cache, loading, load, searchQuery]);

  // 全局树搜索：搜索当前树上已加载节点 + 跨连接穿透检索结果（自然整合进菜单树）
  const { filteredRoots, searchExpandedKeys, searchMatchCount, filteredCache, parentMap } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return {
        filteredRoots: roots,
        searchExpandedKeys: null,
        searchMatchCount: 0,
        filteredCache: null,
        parentMap: new Map<string, string>(),
      };
    }

    const autoKeys = new Set<string>();
    const fCache: Record<string, Node[]> = {};
    const nodeParentMap = new Map<string, string>();
    let totalCount = 0;

    // 索引 deepSearchResults，按 connId 和 db 进行归类
    const deepDbsByConn = new Map<string, Set<string>>();
    const deepTablesByDb = new Map<string, Node[]>();

    deepSearchResults.forEach((item) => {
      let dbs = deepDbsByConn.get(item.connId);
      if (!dbs) {
        dbs = new Set();
        deepDbsByConn.set(item.connId, dbs);
      }
      dbs.add(item.db);

      if (item.kind === "table" && item.table) {
        const dbKey = `db:${item.connId}:${item.db}`;
        let tbls = deepTablesByDb.get(dbKey);
        if (!tbls) {
          tbls = [];
          deepTablesByDb.set(dbKey, tbls);
        }
        tbls.push({
          kind: "table",
          key: `tbl:${item.connId}:${item.db}:${item.table}`,
          connId: item.connId,
          db: item.db,
          name: item.table,
          isView: false,
          comment: item.comment,
        });
      }
    });

    function filterRecursive(node: Node): Node | null {
      const selfMatch = nodeMatchesQuery(node, q);

      let rawChildren: Node[] = [];
      if (node.kind === "dbtype" || node.kind === "env" || node.kind === "group") {
        rawChildren = node.children;
      } else if (node.kind === "conn") {
        const localDbs = cache[node.key] || [];
        const extraDbs: Node[] = [];
        const matchedDbs = deepDbsByConn.get(node.conn.id);
        if (matchedDbs) {
          matchedDbs.forEach((dbName) => {
            const dbKey = `db:${node.conn.id}:${dbName}`;
            if (!localDbs.some((x) => x.key === dbKey)) {
              extraDbs.push({
                kind: "db",
                key: dbKey,
                connId: node.conn.id,
                db: dbName,
              });
            }
          });
        }
        rawChildren = [...localDbs, ...extraDbs];
      } else if (node.kind === "db") {
        const localKids = cache[node.key] || [];
        const extraTbls = deepTablesByDb.get(node.key) || [];
        rawChildren = [...localKids, ...extraTbls];
      } else if (cache[node.key]) {
        rawChildren = cache[node.key];
      }

      const keptChildren: Node[] = [];
      for (const ch of rawChildren) {
        nodeParentMap.set(ch.key, node.key);
        const keptChild = filterRecursive(ch);
        if (keptChild) {
          keptChildren.push(keptChild);
        }
      }

      if (selfMatch || keptChildren.length > 0) {
        if (selfMatch) totalCount++;
        autoKeys.add(node.key);
        if (node.kind === "dbtype" || node.kind === "env" || node.kind === "group") {
          return { ...node, children: keptChildren };
        } else {
          fCache[node.key] = keptChildren;
          return { ...node };
        }
      }
      return null;
    }

    const resRoots: Node[] = [];
    for (const r of roots) {
      const res = filterRecursive(r);
      if (res) resRoots.push(res);
    }

    return {
      filteredRoots: resRoots,
      searchExpandedKeys: autoKeys,
      searchMatchCount: totalCount,
      filteredCache: fCache,
      parentMap: nodeParentMap,
    };
  }, [roots, cache, searchQuery, deepSearchResults]);

  // 展开 / 折叠切换逻辑：支持普通模式与搜索模式下的手动收缩/展开覆盖
  const onToggle = useCallback(
    (node: Node) => {
      if (searchQuery.trim().length > 0) {
        const isSearchExpanded = searchExpandedKeys ? searchExpandedKeys.has(node.key) : false;
        const currentOpen =
          searchToggled[node.key] !== undefined ? searchToggled[node.key] : isSearchExpanded;
        setSearchToggled((prev) => ({ ...prev, [node.key]: !currentOpen }));
      } else {
        const willExpand = !expanded[node.key];
        setExpanded((e) => ({ ...e, [node.key]: willExpand }));
        if (willExpand && isLazy(node) && !cache[node.key] && !loading[node.key]) {
          void load(node);
        }
      }
    },
    [searchQuery, searchToggled, searchExpandedKeys, expanded, cache, loading, load]
  );

  // 顶部全部折叠：普通模式清空 expanded，搜索模式一键收拢所有匹配节点
  const collapseAll = useCallback(() => {
    if (searchQuery.trim().length > 0) {
      const collapsed: Record<string, boolean> = {};
      if (searchExpandedKeys) {
        searchExpandedKeys.forEach((k) => {
          collapsed[k] = false;
        });
      }
      setSearchToggled(collapsed);
    } else {
      setExpanded({});
      try {
        localStorage.removeItem("cq_tree_expanded");
      } catch {}
    }
  }, [searchQuery, searchExpandedKeys]);

  // 顶部全部展开：搜索模式下一键展开所有匹配项
  const expandAll = useCallback(() => {
    if (searchQuery.trim().length > 0) {
      const allOpen: Record<string, boolean> = {};
      if (searchExpandedKeys) {
        searchExpandedKeys.forEach((k) => {
          allOpen[k] = true;
        });
      }
      setSearchToggled(allOpen);
    } else {
      const next: Record<string, boolean> = {};
      const recurse = (nodes: Node[]) => {
        nodes.forEach((n) => {
          next[n.key] = true;
          if ("children" in n && n.children) recurse(n.children);
          if (cache[n.key]) recurse(cache[n.key]);
        });
      };
      recurse(roots);
      setExpanded(next);
    }
  }, [searchQuery, searchExpandedKeys, roots, cache]);

  const [revealKey, setRevealKey] = useState<string | null>(null);

  // 核心定位机制：展开目标节点链路，并平滑滚动到菜单树中对应项
  const focusAndRevealBranch = useCallback(
    (connId: string, db: string, table?: string, collapseOthers: boolean = false) => {
      const staticAncestors = findAncestorKeysInRoots(
        roots,
        (n) => n.kind === "conn" && n.conn.id === connId
      );

      // 1. 设置展开路径：将目标路径全部展开
      setExpanded((prev) => {
        const next: Record<string, boolean> = collapseOthers ? {} : { ...prev };
        staticAncestors.forEach((k) => {
          next[k] = true;
        });
        next[`conn:${connId}`] = true;
        if (table) {
          // 仅在定位具体数据表时，展开数据库与表文件夹（确保该表在树中可见）
          next[`db:${connId}:${db}`] = true;
          next[`tbls:${connId}:${db}`] = true;
          next[`folder:${connId}:${db}:tables`] = true;
          // 表节点本身在树中高亮选中即可，无需自动展开内部字段
          next[`tbl:${connId}:${db}:${table}`] = false;
        } else {
          // 仅定位数据库本身时，定位并选中数据库即可，不展开库下的表
          next[`db:${connId}:${db}`] = false;
        }
        try {
          localStorage.setItem("cq_tree_expanded", JSON.stringify(next));
        } catch {}
        return next;
      });

      // 2. 触发必要数据的异步真实加载：确保连接下的全部数据库加载完毕
      const connSummary = findConnSummary(props.tree, connId);
      const connKey = `conn:${connId}`;
      if (connSummary) {
        if (!cache[connKey] || cache[connKey].length <= 1) {
          void load({ kind: "conn", key: connKey, conn: connSummary });
        }
      }

      // 仅在定位具体数据表时，才需要预加载数据库下的表和视图
      if (table) {
        const dbKey = `db:${connId}:${db}`;
        if (!cache[dbKey] || cache[dbKey].length <= 1) {
          void load({ kind: "db", key: dbKey, connId, db });
        }
      }

      // 3. 默认选中目标项并切换库
      if (table) {
        setSelectedTableKey(`tbl:${connId}:${db}:${table}`);
      } else {
        setSelectedTableKey(null);
      }
      props.onSelectDb?.(connId, db);

      // 4. 清空搜索框内容（如果当前处于搜索中）
      if (searchQuery.trim()) {
        setSearchQuery("");
      }

      // 5. 设定目标节点 Key，触发滚动与高亮
      const targetKey = table ? `tbl:${connId}:${db}:${table}` : `db:${connId}:${db}`;
      setRevealKey(targetKey);
    },
    [roots, props.tree, cache, load, props.onSelectDb, searchQuery]
  );

  // 自动跟踪并平滑居中滚动到目标高亮节点（当底层网络异步加载完成节点进入DOM时立即滚动）
  useEffect(() => {
    if (!revealKey) return;

    let attempts = 0;
    const maxAttempts = 30; // 持续侦测最多 3 秒
    const interval = setInterval(() => {
      attempts++;
      const el = document.querySelector(`[data-tree-key="${revealKey}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        clearInterval(interval);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 80);

    const timer = setTimeout(() => {
      setRevealKey(null);
    }, 2400);

    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [revealKey, cache]);

  // 穿透定位到菜单树上并清空搜索框
  const revealAndClearSearch = useCallback(
    (targetKey: string, targetNode?: Node) => {
      if (targetNode) {
        if (targetNode.kind === "table") {
          focusAndRevealBranch(targetNode.connId, targetNode.db, targetNode.name);
          return;
        } else if (targetNode.kind === "db") {
          focusAndRevealBranch(targetNode.connId, targetNode.db);
          return;
        }
      }

      const ancestors: string[] = [];
      let cur = parentMap.get(targetKey);
      while (cur) {
        ancestors.push(cur);
        cur = parentMap.get(cur);
      }

      // 单分支聚焦：收起其他无关菜单
      setExpanded(() => {
        const next: Record<string, boolean> = {};
        ancestors.forEach((k) => {
          next[k] = true;
        });
        if (!targetKey.startsWith("tbl:") && !targetKey.startsWith("db:")) {
          next[targetKey] = true;
        } else {
          next[targetKey] = false;
        }
        try {
          localStorage.setItem("cq_tree_expanded", JSON.stringify(next));
        } catch {}
        return next;
      });

      setSearchQuery("");
      setRevealKey(targetKey);
      setTimeout(() => {
        const el = document.querySelector(`[data-tree-key="${targetKey}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 80);

      setTimeout(() => {
        setRevealKey(null);
      }, 2400);
    },
    [parentMap, focusAndRevealBranch]
  );

  useEffect(() => {
    if (props.targetFocus) {
      focusAndRevealBranch(
        props.targetFocus.connId,
        props.targetFocus.db,
        props.targetFocus.table
      );
    }
  }, [props.targetFocus, focusAndRevealBranch]);

  // --- right-click context menu -------------------------------------------
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  // Drop a node's cached children and re-fetch (the "刷新" menu item).
  const refreshNode = useCallback(
    (node: Node) => {
      setCache((c) => {
        const next = { ...c };
        delete next[node.key];
        return next;
      });
      setExpanded((e) => ({ ...e, [node.key]: true }));
      if (isLazy(node) && !loading[node.key]) void load(node);
    },
    [load, loading]
  );

  // Synthetic containers (id starts with "__") are client-only; they have no
  // backing record, so rename/delete would fail — offer only a refresh.
  const isSynthetic = (id: string) => id.startsWith("__");

  // Context actions are scoped to capabilities that already exist: browse,
  // connection management, copy, generate-SELECT, and container CRUD
  // (rename/delete on first-class env/group; 新建组 on an env). We
  // deliberately do NOT add write-back actions (truncate/delete table) — the
  // tool is read-only.
  const menuItemsFor = (node: Node): MenuItem[] => {
    switch (node.kind) {
      case "conn": {
        const id = node.conn.id;
        return [
          {
            type: "item",
            label: "新建查询",
            onClick: () => props.onNewQuery?.(id, null),
          },
          { type: "item", label: "编辑连接", onClick: () => props.onEditConn(id) },
          {
            type: "item",
            label: "⚡ 自动化脚本与续期...",
            onClick: () => props.onManageScripts?.(id),
          },
          { type: "sep" },
          { type: "item", label: "删除连接", danger: true, onClick: () => props.onDeleteConn(id) },
        ];
      }
      case "db": {
        const { connId, db } = node;
        const connName = findConnName(props.tree, connId);
        const isPinned = pinnedItems.some((p) => p.kind === "db" && p.connId === connId && p.db === db);
        return [
          {
            type: "item",
            label: isPinned ? "★ 取消常用" : "⭐ 固定到常用 (置顶)",
            onClick: () => togglePin({ kind: "db", connId, connName, db, id: `db:${connId}:${db}` }),
          },
          { type: "sep" },
          {
            type: "item",
            label: `新建查询 (USE \`${db}\`)`,
            onClick: () => props.onNewQuery?.(connId, db),
          },
          { type: "item", label: "表关系", onClick: () => void props.onShowRelationships(connId, db) },
          { type: "item", label: "刷新", onClick: () => refreshNode(node) },
        ];
      }
      case "folder":
        return [{ type: "item", label: "刷新", onClick: () => refreshNode(node) }];
      case "table": {
        const { connId, db, name, isView, comment } = node;
        const connName = findConnName(props.tree, connId);
        const isPinned = pinnedItems.some(
          (p) => p.kind === "table" && p.connId === connId && p.db === db && p.table === name
        );
        return [
          {
            type: "item",
            label: isView ? "打开视图" : "打开表",
            onClick: () => void props.onBrowseTable(connId, db, name, 0, PAGE_SIZE),
          },
          {
            type: "item",
            label: isPinned ? "★ 取消常用" : "⭐ 固定到常用 (置顶)",
            onClick: () =>
              togglePin({
                kind: "table",
                connId,
                connName,
                db,
                table: name,
                comment,
                isView,
                id: `tbl:${connId}:${db}:${name}`,
              }),
          },
          { type: "sep" },
          { type: "item", label: "表结构", onClick: () => void props.onShowStructure(connId, db, name) },
          { type: "item", label: "复制名称", onClick: () => copy(name) },
          {
            type: "item",
            label: "生成 SELECT",
            onClick: () => {
              props.onSelectDb?.(connId, db);
              props.onInsertText(`SELECT * FROM \`${db}\`.\`${name}\` LIMIT 100;\n`);
            },
          },
        ];
      }
      case "column":
        return [
          { type: "item", label: "插入列名", onClick: () => props.onInsertColumn(node.col.name) },
          { type: "item", label: "复制列名", onClick: () => copy(node.col.name) },
        ];
      case "redisdb":
        return [
          { type: "item", label: "打开查询", onClick: () => props.onNewQuery?.(node.connId, String(node.db)) },
          { type: "item", label: "刷新", onClick: () => refreshNode(node) },
        ];
      case "env": {
        if (isSynthetic(node.id))
          return [{ type: "item", label: "刷新连接列表", onClick: () => props.onRefreshConns() }];
        return [
          { type: "item", label: `新建组（在“${node.name}”下）`, onClick: () => props.onNewGroup(node.id) },
          { type: "item", label: "重命名环境", onClick: () => props.onRenameContainer(node.id, node.name) },
          { type: "sep" },
          { type: "item", label: "删除环境", danger: true, onClick: () => props.onDeleteContainer(node.id) },
        ];
      }
      case "group": {
        if (isSynthetic(node.id))
          return [{ type: "item", label: "刷新连接列表", onClick: () => props.onRefreshConns() }];
        return [
          { type: "item", label: "新建链接", onClick: () => props.onNewConnection?.(node.id) },
          { type: "item", label: "重命名分组", onClick: () => props.onRenameContainer(node.id, node.name) },
          { type: "sep" },
          { type: "item", label: "删除分组", danger: true, onClick: () => props.onDeleteContainer(node.id) },
        ];
      }
      default:
        return [];
    }
  };

  const openMenu = (e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    e.stopPropagation();
    const items = menuItemsFor(node);
    if (items.length === 0) return;
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 30 - 12);
    setMenu({ x, y, items });
  };

  const nodeLabel = (node: Node): string => {
    switch (node.kind) {
      case "dbtype":
      case "env":
      case "group":
        return node.name;
      case "conn":
        return node.conn.name;
      case "db":
        return node.db;
      case "redisdb":
        return node.count !== undefined ? `db${node.db} (${node.count})` : `db${node.db}`;
      case "folder":
        return node.label;
      case "table":
        return node.name;
      case "column":
        return node.col.name;
    }
  };

  const isSelected = (node: Node): boolean => {
    switch (node.kind) {
      case "conn":
        return node.conn.id === selectedConnId;
      case "db":
        return node.connId === selectedConnId && node.db === (selectedDb ?? "");
      case "redisdb":
        return node.connId === selectedConnId && String(node.db) === (selectedDb ?? "");
      case "table":
        return node.key === selectedTableKey;
      default:
        return false;
    }
  };

  const renderNode = (node: Node, depth: number): JSX.Element => {
    const b = badge(node);
    const hasChildren =
      node.kind === "dbtype" ||
      node.kind === "env" ||
      node.kind === "group" ||
      isLazy(node);
    const isSearching = searchQuery.trim().length > 0;
    const isSearchExpanded = searchExpandedKeys ? searchExpandedKeys.has(node.key) : false;
    const isOpen = isSearching
      ? (searchToggled[node.key] !== undefined ? searchToggled[node.key] : isSearchExpanded)
      : !!expanded[node.key];
    const kids: Node[] = isSearching
      ? (node.kind === "dbtype" || node.kind === "env" || node.kind === "group"
          ? node.children
          : (filteredCache?.[node.key] ?? []))
      : (node.kind === "dbtype" || node.kind === "env" || node.kind === "group"
          ? node.children
          : (cache[node.key] ?? []));
    const pad = { paddingLeft: `${depth * 10 + 4}px` };
    const cnt = counts[node.key];

    // 单击环境、文件夹(分组)、表视图文件夹或类型时展开/收缩；单击实例和数据库时同时选中并展开
    const onRowClick = () => {
      if (
        node.kind === "env" ||
        node.kind === "group" ||
        node.kind === "folder" ||
        node.kind === "dbtype"
      ) {
        if (hasChildren) onToggle(node);
      } else if (node.kind === "conn") {
        props.onSelectConn(node.conn.id);
        if (hasChildren) onToggle(node);
      } else if (node.kind === "db") {
        props.onSelectDb?.(node.connId, node.db);
        if (hasChildren) onToggle(node);
      } else if (node.kind === "redisdb") {
        props.onSelectDb?.(node.connId, String(node.db));
      } else if (node.kind === "table") {
        setSelectedTableKey(node.key);
      }
    };

    const onLabelClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      onRowClick();
    };

    const onCaretClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasChildren) onToggle(node);
    };

    const title =
      node.kind === "column"
        ? node.col.comment
          ? `${node.col.name} (${node.col.comment}) · 双击插入到编辑器`
          : "双击插入到编辑器"
        : node.kind === "table"
        ? node.comment
          ? `${node.name} (${node.comment}) · 双击浏览数据（点 ▸ 展开字段）`
          : "双击浏览数据（点 ▸ 可展开字段，右键更多操作）"
        : node.kind === "redisdb"
        ? "单击选中，双击打开查询"
        : node.kind === "env" || node.kind === "group"
        ? "单击展开/收缩，右键更多操作"
        : node.kind === "conn"
        ? "单击选中该实例"
        : node.kind === "db"
        ? "单击选中该数据库"
        : undefined;

    return (
      <div key={node.key} className="tree-node">
        <div
          data-tree-key={node.key}
          className={
            "tree-row" +
            (isSelected(node) ? " active" : "") +
            (node.key === revealKey ? " tree-row-revealed" : "")
          }
          style={pad}
          onClick={(e) => {
            if (isSearching) {
              if (node.kind === "table" || node.kind === "column" || node.kind === "redisdb") {
                revealAndClearSearch(node.key, node);
              }
            }
            onLabelClick(e);
          }}
          onContextMenu={(e) => openMenu(e, node)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (isSearching) {
              revealAndClearSearch(node.key, node);
            }
            if (node.kind === "table") {
              setSelectedTableKey(node.key);
              props.onBrowseTable(node.connId, node.db, node.name, 0, PAGE_SIZE);
            } else if (node.kind === "column") {
              props.onInsertColumn(node.col.name);
            } else if (node.kind === "redisdb") {
              props.onNewQuery?.(node.connId, String(node.db));
            }
          }}
          title={title}
        >
          <span
            className={"tw" + (hasChildren ? "" : " leaf") + (isOpen ? " open" : "")}
            onClick={onCaretClick}
          >
            {hasChildren ? "▸" : ""}
          </span>
          <span className={"badge " + b.cls}>
            <Icon name={b.icon} size={b.cls === "b-col" ? 6 : 14} />
          </span>
          <span className="tree-label">
            {renderHighlightedText(nodeLabel(node), searchQuery.trim())}
            {node.kind === "table" && node.comment && (
              <span className="tree-comment" title={node.comment}>
                {" "}{renderHighlightedText(node.comment, searchQuery.trim())}
              </span>
            )}
            {node.kind === "column" && node.col.key === "PRI" && (
              <span className="pk">PK</span>
            )}
            {node.kind === "column" && node.col.data_type && (
              <span className="col-type">{node.col.data_type}</span>
            )}
            {node.kind === "column" && node.col.comment && (
              <span className="tree-comment" title={node.col.comment}>
                {" "}{renderHighlightedText(node.col.comment, searchQuery.trim())}
              </span>
            )}
          </span>
          {cnt !== undefined && <span className="tree-count">{cnt}</span>}
          {loading[node.key] && <span className="tree-loading">…</span>}
        </div>
        {isOpen &&
          (isSearching ? (
            kids.length > 0 ? (
              (() => {
                const limit = searchShownLimit[node.key] ?? 35;
                const visibleKids = kids.length > 35 ? kids.slice(0, limit) : kids;
                const hasMore = kids.length > visibleKids.length;

                return (
                  <>
                    {visibleKids.map((c) => (
                      <div key={c.key}>{renderNode(c, depth + 1)}</div>
                    ))}
                    {kids.length > 35 && (
                      <div
                        className="tree-more"
                        style={{ paddingLeft: `${(depth + 1) * 10 + 24}px` }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasMore) {
                            setSearchShownLimit((prev) => ({
                              ...prev,
                              [node.key]: (prev[node.key] ?? 35) + 50,
                            }));
                          } else {
                            setSearchShownLimit((prev) => ({
                              ...prev,
                              [node.key]: 35,
                            }));
                          }
                        }}
                      >
                        {hasMore ? (
                          <span>▶ 展开更多匹配项 (已显示 {visibleKids.length} / 共 {kids.length} 项)…</span>
                        ) : (
                          <span style={{ color: "var(--brand)" }}>▲ 收起过多项 (仅保留前 35 项)</span>
                        )}
                      </div>
                    )}
                  </>
                );
              })()
            ) : null
          ) : node.kind === "folder" ? (
            <ListView
              kids={kids}
              depth={depth}
              filter={folderFilter[node.key] ?? ""}
              shown={folderShown[node.key] ?? TREE_PAGE}
              onFilter={(v) => {
                setFolderFilter((s) => ({ ...s, [node.key]: v }));
                setFolderShown((s) => ({ ...s, [node.key]: TREE_PAGE }));
              }}
              onMore={() =>
                setFolderShown((s) => ({
                  ...s,
                  [node.key]: (s[node.key] ?? TREE_PAGE) + TREE_PAGE,
                }))
              }
              renderChild={(c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>}
              match={node.folder === "views" ? (c, q) => c.kind === "table" && c.name.toLowerCase().includes(q) : MATCHERS.table}
              placeholder={node.folder === "views" ? "过滤视图名…" : "过滤表名…"}
              emptyText={node.folder === "views" ? "（无视图）" : "（无数据表）"}
              hideFilter={node.folder === "views"}
            />
          ) : node.kind === "conn" && kids.length >= DB_FILTER_THRESHOLD ? (
            <ListView
              kids={kids}
              depth={depth}
              filter={folderFilter[node.key] ?? ""}
              shown={folderShown[node.key] ?? TREE_PAGE}
              onFilter={(v) => {
                setFolderFilter((s) => ({ ...s, [node.key]: v }));
                setFolderShown((s) => ({ ...s, [node.key]: TREE_PAGE }));
              }}
              onMore={() =>
                setFolderShown((s) => ({
                  ...s,
                  [node.key]: (s[node.key] ?? TREE_PAGE) + TREE_PAGE,
                }))
              }
              renderChild={(c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>}
              match={MATCHERS.db}
              placeholder="过滤数据库…"
              emptyText="无匹配数据库"
            />
          ) : kids.length > 0 ? (
            kids.map((c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>)
          ) : (
            <div
              className="tree-empty-child"
              style={{ paddingLeft: `${(depth + 1) * 10 + 24}px` }}
            >
              {loading[node.key] ? (
                <span>正在加载…</span>
              ) : node.kind === "db" ? (
                "（无数据表）"
              ) : node.kind === "conn" ? (
                "（无数据库）"
              ) : node.kind === "group" || node.kind === "env" ? (
                "（无连接实例）"
              ) : (
                "（暂无数据）"
              )}
            </div>
          ))}
      </div>
    );
  };

  return (
    <div
      className="db-tree"
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest(".tree-row")) setMenu(null);
      }}
    >
      {/* Connection import / export / template — 极简单行纯平面工具栏 */}
      <div className="tree-toolbar">
        {/* 导出组合操作 (集成加密方式切换，单行不折行) */}
        {/* 导出操作组：点击直接弹出下拉菜单选择 加密导出 或 明文导出 */}
        <div className="tb-group" ref={exportMenuRef}>
          <button
            type="button"
            className={"tb-ghost-btn" + (exportMenuOpen ? " active" : "")}
            onClick={() => setExportMenuOpen((v) => !v)}
            title="选择加密或明文导出所有连接"
          >
            <span className="tb-btn-icon">⬇</span>
            <span>导出</span>
            <span style={{ fontSize: "9px", color: "var(--text-tertiary)", marginLeft: 2 }}>▾</span>
          </button>
          {exportMenuOpen && (
            <div className="tb-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="tb-option"
                onClick={() => void handleExportWith("system-key")}
              >
                <span className="tb-opt-main">🔒 加密导出</span>
                <span className="tb-opt-sub">使用系统主密钥加密密码（推荐）</span>
              </button>
              <button
                type="button"
                className="tb-option"
                onClick={() => void handleExportWith("none")}
              >
                <span className="tb-opt-main" style={{ color: "var(--danger-500)" }}>⚠️ 明文导出</span>
                <span className="tb-opt-sub">密码明文写入文件（高风险）</span>
              </button>
            </div>
          )}
        </div>

        <span className="tb-sep" />

        <button
          type="button"
          className="tb-ghost-btn"
          onClick={() => setShowImportModal(true)}
          title="导入连接（支持 ChatQuery YAML/JSON、Navicat、DataGrip 等）"
        >
          <span className="tb-btn-icon">⬆</span>
          <span>导入</span>
        </button>

        <button
          type="button"
          className="tb-ghost-btn"
          onClick={() => void handleTemplate()}
          title="下载空白模板"
        >
          <span className="tb-btn-icon">📄</span>
          <span>模板</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml,.json,.ncx,.xml,.txt"
          style={{ display: "none" }}
          onChange={(e) => void handleImportFile(e)}
        />
      </div>

      {/* 侧边栏搜索栏：可搜索当前展开/加载过的连接、环境、数据库、表等 */}
      <div className="tree-search-bar">
        <div className="tree-search-box">
          <span className="tree-search-icon">
            <Icon name="search" size={11} />
          </span>
          <input
            className="tree-search-input"
            placeholder="搜索节点，或按 ⌘P 穿透搜库搜表..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          {searchQuery ? (
            <>
              <span className="tree-search-count" title={`共找到 ${searchMatchCount} 项`}>
                {searchMatchCount}
              </span>
              <button
                type="button"
                className="tree-search-clear"
                onClick={() => setSearchQuery("")}
                title="清空搜索"
              >
                ×
              </button>
            </>
          ) : (
            props.onOpenQuickOpen && (
              <button
                type="button"
                className="tree-search-quick-btn"
                onClick={props.onOpenQuickOpen}
                title="全局快速搜库搜表直达 (⌘P / Ctrl+P)"
              >
                ⌘P
              </button>
            )
          )}
        </div>
        <div className="tree-actions-toolbar">
          <button
            type="button"
            className="tree-btn-icon"
            onClick={collapseAll}
            title="全部折叠 (Collapse All)"
          >
            ⊟
          </button>
          <button
            type="button"
            className="tree-btn-icon"
            onClick={expandAll}
            title="全部展开 (Expand All)"
          >
            ⊞
          </button>
        </div>
      </div>

      {/* Scrollable tree content */}
      <ScrollArea>
        {/* 顶部常用收藏 (Pinned) - 层次化分层展示 */}
        {!searchQuery.trim() && pinnedItems.length > 0 && (
          <div className="pinned-section">
            <div className="pinned-header" onClick={() => setPinnedOpen((v) => !v)}>
              <span className={"pinned-arrow" + (pinnedOpen ? " open" : "")}>▶</span>
              <span className="pinned-title">⭐ 常用收藏 ({pinnedItems.length})</span>
            </div>
            {pinnedOpen && (
              <div className="pinned-list">
                {pinnedGroups.map((grp) => {
                  const isGrpOpen = pinnedGroupExpanded[grp.groupKey] !== false;
                  const hasSubTables = grp.tables.length > 0;

                  return (
                    <div key={grp.groupKey} className="pinned-group-card">
                      {/* 数据库节点 (一级) */}
                      <div
                        className="pinned-group-head"
                        onClick={() => {
                          if (grp.dbPinnedItem) {
                            focusAndRevealBranch(grp.connId, grp.db);
                            props.onSelectDb?.(grp.connId, grp.db);
                            props.onNewQuery?.(grp.connId, grp.db);
                          } else if (hasSubTables) {
                            setPinnedGroupExpanded((prev) => ({
                              ...prev,
                              [grp.groupKey]: prev[grp.groupKey] === false,
                            }));
                          }
                        }}
                        title={`数据库: ${grp.db} (连接: ${grp.connName}) · 点击新建查询`}
                      >
                        {hasSubTables ? (
                          <span
                            className={"pinned-group-arrow" + (isGrpOpen ? " open" : "")}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPinnedGroupExpanded((prev) => ({
                                ...prev,
                                [grp.groupKey]: prev[grp.groupKey] === false,
                              }));
                            }}
                          >
                            ▶
                          </span>
                        ) : (
                          <span className="pinned-group-arrow-spacer" />
                        )}
                        <span className="pinned-group-icon">🐬</span>
                        <span className="pinned-group-name">{grp.db}</span>
                        <span className="pinned-conn-badge" title={`所属连接: ${grp.connName}`}>
                          {grp.connName}
                        </span>

                        {grp.dbPinnedItem && (
                          <span
                            className="pinned-item-del"
                            title="取消收藏该数据库"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePin(grp.dbPinnedItem!);
                            }}
                          >
                            &times;
                          </span>
                        )}
                      </div>

                      {/* 库下的数据表节点 (二级缩进展示) */}
                      {hasSubTables && isGrpOpen && (
                        <div className="pinned-sub-tables">
                          {grp.tables.map((t) => (
                            <div
                              key={t.id}
                              className="pinned-sub-table-item"
                              onClick={() => {
                                focusAndRevealBranch(t.connId, t.db, t.table);
                                props.onBrowseTable(t.connId, t.db, t.table!);
                              }}
                              title={`打开表: ${t.db}.${t.table}${t.comment ? ` (${t.comment})` : ""}`}
                            >
                              <span className="pinned-tree-branch">└</span>
                              <span className="pinned-sub-table-icon">▤</span>
                              <span className="pinned-sub-table-name">{t.table}</span>
                              {t.comment && (
                                <span className="pinned-sub-table-comment">
                                  {t.comment}
                                </span>
                              )}
                              <span
                                className="pinned-item-del"
                                title="取消收藏该表"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePin(t);
                                }}
                              >
                                &times;
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 顶部最近访问 (Recent) */}
        {!searchQuery.trim() && props.recentTables && props.recentTables.length > 0 && (() => {
          const recentList = props.recentTables.slice(0, 5);
          if (recentList.length === 0) return null;
          return (
            <div className="recent-section">
              <div className="recent-header" onClick={() => setRecentOpen((v) => !v)}>
                <span className={"pinned-arrow" + (recentOpen ? " open" : "")}>▶</span>
                <span className="recent-title">🕒 最近打开 ({recentList.length})</span>
                {props.onClearRecentTables && (
                  <span
                    className="pinned-item-del"
                    style={{ marginLeft: "auto", fontSize: "11px", opacity: 0.65 }}
                    title="清空最近打开记录"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onClearRecentTables?.();
                    }}
                  >
                    清空
                  </span>
                )}
              </div>
              {recentOpen && (
                <div className="pinned-list">
                  {recentList.map((r) => (
                    <div
                      key={`rec:${r.connId}:${r.db}:${r.table}`}
                      className="pinned-item"
                      onClick={() => {
                        focusAndRevealBranch(r.connId, r.db, r.table);
                        props.onBrowseTable(r.connId, r.db, r.table);
                      }}
                      title={`打开表: ${r.db}.${r.table}`}
                    >
                      <span className="pinned-item-icon">▤</span>
                      <span className="pinned-item-name">{r.table}</span>
                      <span className="pinned-item-db">{r.db}</span>
                      {props.onRemoveRecentTable && (
                        <span
                          className="pinned-item-del"
                          title="从最近打开中移除"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onRemoveRecentTable?.(r.connId, r.db, r.table);
                          }}
                        >
                          &times;
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {filteredRoots.length === 0 && (
          <div className="tree-empty">
            {searchQuery.trim()
              ? (deepSearching ? "正在全库穿透检索中…" : "未找到匹配的环境、实例、库或表")
              : "暂无连接，点右上角 ＋ 添加"}
          </div>
        )}
        {treeMsg && <div className="tree-msg">{treeMsg}</div>}

        {filteredRoots.map((r) => (
          <div key={r.key}>{renderNode(r, 0)}</div>
        ))}
      </ScrollArea>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {showImportModal &&
        createPortal(
          <div className="modal-mask" onClick={() => setShowImportModal(false)}>
            <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
              <h3>导入数据库连接</h3>
              <p className="modal-msg">
                支持 <strong>ChatQuery (YAML/JSON)</strong>、<strong>Navicat (.ncx/XML/JSON)</strong>、<strong>DataGrip (dataSources.xml 或剪贴板数据源)</strong> 以及 <strong>MySQL/Redis 连接串</strong>。
              </p>

              <div style={{ display: "flex", gap: "8px", alignItems: "center", margin: "4px 0" }}>
                <button
                  type="button"
                  style={{
                    padding: "6px 14px",
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--border)",
                    background: "var(--bg-subtle)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    fontWeight: 500,
                  }}
                  onClick={() => fileRef.current?.click()}
                >
                  <span>📂</span> 选择文件导入…
                </button>
                <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  (.yaml, .yml, .json, .ncx, .xml, .txt)
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)" }}>
                  或在此直接粘贴配置内容 / XML / 连接串：
                </label>
                <textarea
                  value={importInputText}
                  onChange={(e) => setImportInputText(e.target.value)}
                  placeholder={"例如直接粘贴：\n- DataGrip 复制的 <data-source> XML\n- Navicat 导出的 Connections XML / JSON\n- jdbc:mysql://127.0.0.1:3306/mydb\n- mysql://root:pass@127.0.0.1:3306/mydb"}
                  style={{
                    width: "100%",
                    height: 140,
                    padding: "8px 12px",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "12px",
                    lineHeight: 1.45,
                    borderRadius: "var(--r-md)",
                    border: "1px solid var(--input-border)",
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div className="modal-actions" style={{ marginTop: "14px", justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setShowImportModal(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!importInputText.trim()}
                  onClick={() => void doImportText(importInputText)}
                >
                  解析并导入
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
