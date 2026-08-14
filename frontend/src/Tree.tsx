import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
          nodes: dbs.map((db) => ({
            kind: "redisdb",
            key: `rdb:${node.conn.id}:${db}`,
            connId: node.conn.id,
            db,
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
        }));
      return {
        nodes: [
          {
            kind: "folder",
            key: `tbls:${node.connId}:${node.db}`,
            label: "表",
            connId: node.connId,
            db: node.db,
            folder: "tables",
            count: tableNodes.length,
          },
          {
            kind: "folder",
            key: `views:${node.connId}:${node.db}`,
            label: "视图",
            connId: node.connId,
            db: node.db,
            folder: "views",
            count: viewNodes.length,
          },
        ],
        count: tables.length,
        cache: {
          [`tbls:${node.connId}:${node.db}`]: tableNodes,
          [`views:${node.connId}:${node.db}`]: viewNodes,
        },
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

/// Expanded "表"/"视图" folder: a filter box + windowed list. The folder's
/// full child list may be 8000+ nodes; we never mount them all — only the
/// filtered+windowed slice is rendered, so the sidebar stays responsive.
function FolderView(props: {
  node: Extract<Node, { kind: "folder" }>;
  kids: Node[];
  depth: number;
  filter: string;
  shown: number;
  onFilter: (v: string) => void;
  onMore: () => void;
  renderChild: (c: Node) => JSX.Element;
}) {
  const { kids, depth, filter, shown, onFilter, onMore, renderChild } = props;
  const filtered = filter
    ? kids.filter(
        (c) =>
          (c.kind === "table") &&
          c.name.toLowerCase().includes(filter.toLowerCase())
      )
    : kids;
  const visible = filtered.slice(0, shown);
  // Align the filter/empty/more rows with the child table rows below them.
  const indent = (depth + 1) * 10 + 4;
  return (
    <>
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
          placeholder="过滤表名…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          onContextMenu={(e) => e.preventDefault()}
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
      {visible.length > 0 ? (
        visible.map(renderChild)
      ) : (
        <div className="tree-empty-child" style={{ paddingLeft: `${indent}px` }}>
          无匹配表
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
}

export function Tree(props: TreeProps) {
  const { tree, selectedConnId, selectedDb } = props;
  const roots = useMemo(() => buildRoots(tree), [tree]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, Node[]>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // Per-folder filter text + how many children are currently revealed (windowing).
  const [folderFilter, setFolderFilter] = useState<Record<string, string>>({});
  const [folderShown, setFolderShown] = useState<Record<string, number>>({});

  // --- Connection import / export / template (#1, #2) ----------------------
  const fileRef = useRef<HTMLInputElement>(null);
  const cipherRef = useRef<HTMLDivElement>(null);
  const [cipher, setCipher] = useState<"system-key" | "none">("system-key");
  const [cipherOpen, setCipherOpen] = useState(false);
  const [treeMsg, setTreeMsg] = useState<string>("");

  // Close the custom cipher dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!cipherOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (cipherRef.current && !cipherRef.current.contains(e.target as HTMLElement)) {
        setCipherOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [cipherOpen]);

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

  // Export all connections. `cipher` decides whether passwords are encrypted
  // under K (system-key) or written in plaintext (none — high risk).
  const handleExport = useCallback(async () => {
    setTreeMsg("导出中…");
    try {
      const yaml = await api.exportConnections(cipher);
      const stamp = new Date().toISOString().slice(0, 10);
      download(`chatquery-connections-${stamp}.yaml`, yaml);
      setTreeMsg(cipher === "none" ? "已导出（明文，含密码！）" : "已导出（已加密）");
    } catch (e) {
      setTreeMsg("导出失败: " + String(e));
    }
  }, [cipher]);

  // Import connections from a user-picked YAML file. After a successful import
  // we refresh the tree so the new nodes appear.
  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      setTreeMsg("导入中…");
      try {
        const text = await f.text();
        const res = await api.importConnections(text);
        let msg = `导入完成：新增 ${res.connections_added} 个连接、${res.containers_added} 个容器`;
        if (res.passwords_needed.length)
          msg += `；需补密码：${res.passwords_needed.join(", ")}`;
        if (res.skipped.length) msg += `；跳过 ${res.skipped.length} 个`;
        setTreeMsg(msg);
        props.onRefreshConns();
      } catch (err) {
        setTreeMsg("导入失败: " + String(err));
      }
    },
    [props]
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

  // Auto-expand top-level dbtype nodes AND environment nodes on every tree
  // change — but only for nodes the user hasn't explicitly toggled. This way
  // newly created environments/groups appear immediately without the user
  // needing to manually expand, while respecting user collapses.
  const userToggledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (roots.length === 0) return;
    setExpanded((e) => {
      const next = { ...e };
      let changed = false;
      for (const r of roots) {
        if (!userToggledRef.current.has(r.key) && !next[r.key]) {
          next[r.key] = true;
          changed = true;
        }
        if (r.kind === "dbtype" || r.kind === "env" || r.kind === "group") {
          for (const env of r.children) {
            if (env.kind === "env" && !userToggledRef.current.has(env.key) && !next[env.key]) {
              next[env.key] = true;
              changed = true;
            }
          }
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

  const onToggle = useCallback(
    (node: Node) => {
      userToggledRef.current.add(node.key);
      const willExpand = !expanded[node.key];
      setExpanded((e) => ({ ...e, [node.key]: willExpand }));
      // Note: expanding/collapsing via the caret does NOT select the node.
      // Selection is handled by the row label click, per user request.
      if (willExpand && isLazy(node) && !cache[node.key] && !loading[node.key]) {
        void load(node);
      }
    },
    [expanded, cache, loading, load]
  );

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
          { type: "sep" },
          { type: "item", label: "删除连接", danger: true, onClick: () => props.onDeleteConn(id) },
        ];
      }
      case "db": {
        const { connId, db } = node;
        return [
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
        const { connId, db, name, isView } = node;
        return [
          {
            type: "item",
            label: isView ? "打开视图" : "打开表",
            onClick: () => void props.onBrowseTable(connId, db, name, 0, PAGE_SIZE),
          },
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
        return [{ type: "item", label: "刷新", onClick: () => refreshNode(node) }];
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
        return `db${node.db}`;
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
    const isOpen = !!expanded[node.key];
    const kids: Node[] =
      node.kind === "dbtype" || node.kind === "env" || node.kind === "group"
        ? node.children
        : cache[node.key] ?? [];
    const pad = { paddingLeft: `${depth * 10 + 4}px` };
    const cnt = counts[node.key];

    // Clicking the row selects the node (connection/database/key). It does NOT
    // expand/collapse — that is handled by the dedicated caret on the left.
    const onRowClick = () => {
      if (node.kind === "conn") props.onSelectConn(node.conn.id);
      if (node.kind === "db") props.onSelectDb?.(node.connId, node.db);
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
        ? "双击插入到编辑器"
        : node.kind === "table"
        ? "双击浏览数据（点 ▸ 可展开字段，右键更多操作）"
        : node.kind === "env" || node.kind === "group"
        ? "右键可新建组 / 新建链接 / 重命名 / 删除"
        : node.kind === "conn"
        ? "单击选中，点左侧箭头展开数据库"
        : node.kind === "db"
        ? "单击选中该数据库"
        : undefined;

    return (
      <div key={node.key} className="tree-node">
        <div
          className={"tree-row" + (isSelected(node) ? " active" : "")}
          style={pad}
          onClick={onLabelClick}
          onContextMenu={(e) => openMenu(e, node)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (node.kind === "table") {
              props.onBrowseTable(node.connId, node.db, node.name, 0, PAGE_SIZE);
            } else if (node.kind === "column") {
              props.onInsertColumn(node.col.name);
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
            {nodeLabel(node)}
            {node.kind === "column" && node.col.key === "PRI" && (
              <span className="pk">PK</span>
            )}
            {node.kind === "column" && node.col.data_type && (
              <span className="col-type">{node.col.data_type}</span>
            )}
          </span>
          {cnt !== undefined && <span className="tree-count">{cnt}</span>}
          {loading[node.key] && <span className="tree-loading">…</span>}
        </div>
        {isOpen &&
          (node.kind === "folder" ? (
            <FolderView
              node={node}
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
            />
          ) : kids.length > 0 ? (
            kids.map((c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>)
          ) : (
            <div className="tree-empty-child">暂无连接</div>
          ))}
      </div>
    );
  };

  return (
    <div
      className="tree"
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest(".tree-row")) setMenu(null);
      }}
    >
      {/* Connection import / export / template — pinned above scroll */}
      <div className="tree-toolbar">
        {/* Encryption mode — custom dropdown (replaces raw <select>) */}
        <div className="tb-group" ref={cipherRef}>
          <span className="tb-label">加密</span>
          <button
            type="button"
            className={"tb-select" + (cipherOpen ? " open" : "")}
            onClick={() => setCipherOpen((v) => !v)}
            title="选择导出加密方式"
          >
            <span className={"tb-dot " + (cipher === "system-key" ? "ok" : "warn")} />
            <span className="tb-select-text">
              {cipher === "system-key" ? "system-key" : "明文(含密码)"}
            </span>
            <span className="tb-caret">▾</span>
          </button>
          {cipherOpen && (
            <div className="tb-menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={"tb-option" + (cipher === "system-key" ? " sel" : "")}
                onClick={() => {
                  setCipher("system-key");
                  setCipherOpen(false);
                }}
              >
                <span className="tb-opt-main">🔒 system-key</span>
                <span className="tb-opt-sub">密码加密后导出</span>
              </button>
              <button
                type="button"
                className={"tb-option" + (cipher === "none" ? " sel" : "")}
                onClick={() => {
                  setCipher("none");
                  setCipherOpen(false);
                }}
              >
                <span className="tb-opt-main">⚠ 明文</span>
                <span className="tb-opt-sub">密码以明文写入文件</span>
              </button>
            </div>
          )}
        </div>

        <span className="tb-sep" />

        <div className="tb-group tb-actions">
          <button type="button" className="tb-btn" onClick={() => void handleExport()} title="导出连接为 YAML">
            <span aria-hidden>⬇</span> 导出
          </button>
          <button type="button" className="tb-btn" onClick={() => fileRef.current?.click()} title="从 YAML 文件导入连接">
            <span aria-hidden>⬆</span> 导入
          </button>
          <button type="button" className="tb-btn" onClick={() => void handleTemplate()} title="下载空白模板">
            <span aria-hidden>📄</span> 模板
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml"
            style={{ display: "none" }}
            onChange={(e) => void handleImportFile(e)}
          />
        </div>
      </div>

      {/* Scrollable tree content */}
      <ScrollArea>
        {roots.length === 0 && <div className="tree-empty">暂无连接，点右上角 ＋ 添加</div>}
        {cipher === "none" && (
          <div className="tree-warn">
            ⚠️ 明文导出会把连接密码以明文写入文件，请勿分享或提交到仓库。
          </div>
        )}
        {treeMsg && <div className="tree-msg">{treeMsg}</div>}

        {roots.map((r) => (
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
    </div>
  );
}
