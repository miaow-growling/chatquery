import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { ColumnInfo, ConnSummary, TreeModel } from "./types";
import { ContextMenu, type MenuItem } from "./ContextMenu";

/// Rows fetched per page when browsing a table.
const PAGE_SIZE = 200;

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
  | { kind: "redisdb"; key: string; connId: string; db: number; count?: number }
  | { kind: "rediskey"; key: string; connId: string; db: number; name: string };

const LAZY = new Set(["conn", "db", "folder", "table", "redisdb"]);
const isLazy = (n: Node) => LAZY.has(n.kind);

function connNode(c: ConnSummary): Node {
  return { kind: "conn", key: `conn:${c.id}`, conn: c };
}

function buildRoots(tree: TreeModel): Node[] {
  const envs = [...tree.environments].sort((a, b) => a.order - b.order);
  const labelOf = (t: string) => (t === "redis" ? "Redis" : "MySQL");

  // ADR-022: environments are bound to a single db_type, so the root grouping
  // is driven by each environment's own `db_type` — not inferred from its
  // connections. This means an empty environment still lands under the correct
  // root (MySQL/Redis) instead of being orphaned at the top level.
  // The synthetic "__ungrouped" bucket holds mixed-type connections with no
  // group, so it is split by connection type like before.
  const types = new Set<string>();
  for (const env of envs) {
    if (env.id === "__ungrouped") {
      for (const g of env.groups)
        for (const c of g.connections) types.add(c.db_type);
    } else {
      types.add(env.db_type || "mysql");
    }
  }
  const sortedTypes = [...types].sort();

  const roots: Node[] = [];
  for (const t of sortedTypes) {
    const envNodes: Node[] = [];
    for (const env of envs) {
      if (env.id === "__ungrouped") {
        const conns = env.groups
          .flatMap((g) => g.connections)
          .filter((c) => c.db_type === t);
        if (conns.length === 0) continue;
        envNodes.push({
          kind: "env",
          key: `env:${env.id}:${t}`,
          id: env.id,
          name: env.name,
          children: [
            {
              kind: "group",
              key: `grp:${env.id}:${t}`,
              id: env.id,
              name: "",
              children: conns.map(connNode),
            },
          ],
        });
      } else {
        if ((env.db_type || "mysql") !== t) continue;
        envNodes.push({
          kind: "env",
          key: `env:${env.id}`,
          id: env.id,
          name: env.name,
          children: [...env.groups]
            .sort((a, b) => a.order - b.order)
            .map((g) => ({
              kind: "group" as const,
              key: `grp:${g.id}`,
              id: g.id,
              name: g.name,
              children: g.connections.map(connNode),
            })),
        });
      }
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
    case "redisdb": {
      const keys = await api.listRedisKeys(node.connId, node.db, "*", 300);
      return {
        nodes: keys.map((k) => ({
          kind: "rediskey",
          key: `rk:${node.connId}:${node.db}:${k}`,
          connId: node.connId,
          db: node.db,
          name: k,
        })),
        count: keys.length,
      };
    }
    default:
      return null;
  }
}

function badge(n: Node): { icon: string; cls: string } {
  switch (n.kind) {
    case "dbtype":
      return { icon: "🐬", cls: "b-mysql" };
    case "env":
      return { icon: "🌐", cls: "b-env" };
    case "group":
      return { icon: "📁", cls: "b-group" };
    case "conn":
      return n.conn.db_type === "redis"
        ? { icon: "🔴", cls: "b-redis" }
        : { icon: "🐬", cls: "b-mysql" };
    case "db":
      return { icon: "🗄", cls: "b-db" };
    case "folder":
      return { icon: n.folder === "views" ? "👁" : "📂", cls: "b-folder" };
    case "table":
      return { icon: n.isView ? "👁" : "⊞", cls: n.isView ? "b-view" : "b-table" };
    case "column":
      return { icon: "▏", cls: "b-col" };
    case "redisdb":
      return { icon: "🗄", cls: "b-db" };
    case "rediskey":
      return { icon: "🔑", cls: "b-key" };
  }
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

  // Auto-expand the top-level database-type nodes (e.g. "MySQL") on first
  // render so the sidebar opens directly at the 环境 level instead of hiding
  // everything one extra click down.
  const [autoExpanded, setAutoExpanded] = useState(false);
  useEffect(() => {
    if (autoExpanded || roots.length === 0) return;
    setExpanded((e) => {
      const next = { ...e };
      for (const r of roots) next[r.key] = true;
      return next;
    });
    setAutoExpanded(true);
  }, [roots, autoExpanded]);

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
      case "rediskey":
        return [
          {
            type: "item",
            label: "打开键",
            onClick: () => void props.onBrowseRedisKey(node.connId, node.db, node.name),
          },
          { type: "item", label: "复制键名", onClick: () => copy(node.name) },
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
        return `db${node.db}`;
      case "folder":
        return node.label;
      case "table":
        return node.name;
      case "rediskey":
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
    const pad = { paddingLeft: `${depth * 14 + 8}px` };
    const cnt = counts[node.key];

    // Clicking the row selects the node (connection/database/key). It does NOT
    // expand/collapse — that is handled by the dedicated caret on the left.
    const onRowClick = () => {
      if (node.kind === "conn") props.onSelectConn(node.conn.id);
      if (node.kind === "db") props.onSelectDb?.(node.connId, node.db);
      if (node.kind === "rediskey")
        props.onBrowseRedisKey(node.connId, node.db, node.name);
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
        ? "单击设为 SQL 上下文，点左侧箭头展开"
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
            className={"tw" + (hasChildren ? "" : " leaf")}
            onClick={onCaretClick}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className={"badge " + b.cls}>{b.icon}</span>
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
          (kids.length > 0 ? (
            kids.map((c) => <div key={c.key}>{renderNode(c, depth + 1)}</div>)
          ) : (
            <div className="tree-empty-child" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
              暂无连接
            </div>
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
      {roots.length === 0 && <div className="tree-empty">暂无连接，点右上角 ＋ 添加</div>}
      {roots.map((r) => (
        <div key={r.key}>{renderNode(r, 0)}</div>
      ))}
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
