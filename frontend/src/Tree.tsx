import { useCallback, useMemo, useState } from "react";
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
  | { kind: "env"; key: string; id: string; name: string; children: Node[] }
  | { kind: "group"; key: string; id: string; name: string; children: Node[] }
  | { kind: "conn"; key: string; conn: ConnSummary }
  | { kind: "db"; key: string; connId: string; db: string }
  | {
      kind: "folder";
      key: string;
      label: string;
      connId: string;
      db: string;
      folder: "tables" | "views";
    }
  | {
      kind: "table";
      key: string;
      connId: string;
      db: string;
      name: string;
      isView: boolean;
    }
  | {
      kind: "column";
      key: string;
      connId: string;
      db: string;
      table: string;
      col: ColumnInfo;
    }
  | { kind: "redisdb"; key: string; connId: string; db: number }
  | { kind: "rediskey"; key: string; connId: string; db: number; name: string };

const LAZY = new Set(["conn", "db", "folder", "table", "redisdb"]);
const isLazy = (n: Node) => LAZY.has(n.kind);

function connNode(c: ConnSummary): Node {
  return { kind: "conn", key: `conn:${c.id}`, conn: c };
}

function buildRoots(tree: TreeModel): Node[] {
  const envs = [...tree.environments].sort((a, b) => a.order - b.order);
  const roots: Node[] = [];
  for (const env of envs) {
    const groups = [...env.groups].sort((a, b) => a.order - b.order);
    const envChildren: Node[] = groups.map((g) => ({
      kind: "group",
      key: `grp:${g.id}`,
      id: g.id,
      name: g.name,
      children: g.connections.map(connNode),
    }));
    roots.push({
      kind: "env",
      key: `env:${env.id}`,
      id: env.id,
      name: env.name,
      children: envChildren,
    });
  }
  return roots;
}

async function loader(node: Node): Promise<Node[] | null> {
  switch (node.kind) {
    case "conn": {
      if (node.conn.db_type === "redis") {
        const dbs = await api.listRedisDbs(node.conn.id);
        return dbs.map((db) => ({
          kind: "redisdb",
          key: `rdb:${node.conn.id}:${db}`,
          connId: node.conn.id,
          db,
        }));
      }
      const dbs = await api.listDatabases(node.conn.id);
      return dbs.map((db) => ({
        kind: "db",
        key: `db:${node.conn.id}:${db}`,
        connId: node.conn.id,
        db,
      }));
    }
    case "db":
      return [
        {
          kind: "folder",
          key: `tbls:${node.connId}:${node.db}`,
          label: "表",
          connId: node.connId,
          db: node.db,
          folder: "tables",
        },
        {
          kind: "folder",
          key: `views:${node.connId}:${node.db}`,
          label: "视图",
          connId: node.connId,
          db: node.db,
          folder: "views",
        },
      ];
    case "folder": {
      const tables = await api.listTables(node.connId, node.db);
      const filtered = tables.filter((t) =>
        node.folder === "tables" ? !t.is_view : t.is_view
      );
      return filtered.map((t) => ({
        kind: "table",
        key: `tbl:${node.connId}:${node.db}:${t.name}`,
        connId: node.connId,
        db: node.db,
        name: t.name,
        isView: t.is_view,
      }));
    }
    case "table": {
      const cols = await api.listColumns(node.connId, node.db, node.name);
      return cols.map((col) => ({
        kind: "column",
        key: `col:${node.connId}:${node.db}:${node.name}:${col.name}`,
        connId: node.connId,
        db: node.db,
        table: node.name,
        col,
      }));
    }
    case "redisdb": {
      const keys = await api.listRedisKeys(node.connId, node.db, "*", 300);
      return keys.map((k) => ({
        kind: "rediskey",
        key: `rk:${node.connId}:${node.db}:${k}`,
        connId: node.connId,
        db: node.db,
        name: k,
      }));
    }
    default:
      return null;
  }
}

function badge(n: Node): { text: string; cls: string } {
  switch (n.kind) {
    case "env":
      return { text: "ENV", cls: "b-env" };
    case "group":
      return { text: "GRP", cls: "b-group" };
    case "conn":
      return n.conn.db_type === "redis"
        ? { text: "Rd", cls: "b-redis" }
        : { text: "My", cls: "b-mysql" };
    case "db":
      return { text: "DB", cls: "b-db" };
    case "folder":
      return { text: n.folder === "views" ? "V" : "T", cls: "b-folder" };
    case "table":
      return { text: n.isView ? "V" : "T", cls: n.isView ? "b-view" : "b-table" };
    case "column":
      return { text: "·", cls: "b-col" };
    case "redisdb":
      return { text: "db", cls: "b-db" };
    case "rediskey":
      return { text: "k", cls: "b-key" };
  }
}

interface TreeProps {
  tree: TreeModel;
  selectedConnId: string;
  onSelectConn: (id: string) => void;
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
  onRenameContainer: (id: string, name: string) => void;
  onDeleteContainer: (id: string) => void;
  onShowStructure: (connId: string, db: string, table: string) => void;
  onShowRelationships: (connId: string, db: string) => void;
}

export function Tree(props: TreeProps) {
  const { tree, selectedConnId } = props;
  const roots = useMemo(() => buildRoots(tree), [tree]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cache, setCache] = useState<Record<string, Node[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async (node: Node) => {
    setLoading((l) => ({ ...l, [node.key]: true }));
    try {
      const kids = await loader(node);
      setCache((c) => ({ ...c, [node.key]: kids ?? [] }));
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
          { type: "item", label: "新建查询", onClick: () => props.onSelectConn(id) },
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
            onClick: () => {
              props.onSelectConn(connId);
              props.onInsertText(`USE \`${db}\`;\n`);
            },
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
              props.onSelectConn(connId);
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

  const renderNode = (node: Node, depth: number): JSX.Element => {
    const b = badge(node);
    const hasChildren =
      node.kind === "env" || node.kind === "group" || isLazy(node);
    const isOpen = !!expanded[node.key];
    const kids: Node[] =
      node.kind === "env" || node.kind === "group"
        ? node.children
        : cache[node.key] ?? [];
    const pad = { paddingLeft: `${depth * 14 + 8}px` };

    const onRowClick = () => {
      if (node.kind === "conn") props.onSelectConn(node.conn.id);
      if (node.kind === "rediskey")
        props.onBrowseRedisKey(node.connId, node.db, node.name);
    };

    // Single click on the label: expand/collapse. Tables deliberately do NOT
    // auto-expand here — the per-table column list made the whole tree too
    // long. Columns are still one click away via the ▸ caret that sits next to
    // the table name. Environments/groups always toggle so empty ones can be
    // opened (showing nothing inside).
    const onLabelClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      onRowClick();
      if (hasChildren && node.kind !== "table") onToggle(node);
    };

    return (
      <div key={node.key} className="tree-node">
        <div
          className={
            "tree-row" +
            (node.kind === "conn" && node.conn.id === selectedConnId
              ? " active"
              : "")
          }
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
          title={
            node.kind === "column"
              ? "双击插入到编辑器"
              : node.kind === "table"
              ? "双击浏览数据（点 ▸ 可展开字段，右键更多操作）"
              : node.kind === "env" || node.kind === "group"
              ? "右键可新建组 / 重命名 / 删除"
              : undefined
          }
        >
          <span
            className={"tw" + (hasChildren ? "" : " leaf")}
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) onToggle(node);
            }}
          >
            {hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className={"badge " + b.cls}>{b.text}</span>
          <span className="tree-label">
            {node.kind === "env" || node.kind === "group"
              ? node.name
              : node.kind === "conn"
              ? node.conn.name
              : node.kind === "db" || node.kind === "redisdb"
              ? node.kind === "db"
                ? node.db
                : `db${node.db}`
              : node.kind === "folder"
              ? node.label
              : node.kind === "table"
              ? node.name
              : node.kind === "rediskey"
              ? node.name
              : node.col.name}
            {node.kind === "column" && node.col.key === "PRI" && (
              <span className="pk">PK</span>
            )}
            {node.kind === "column" && node.col.data_type && (
              <span className="col-type">{node.col.data_type}</span>
            )}
          </span>
          {loading[node.key] && <span className="tree-loading">…</span>}
        </div>
        {isOpen &&
          kids.map((c) => (
            <div key={c.key}>
              {renderNode(c, node.kind === "env" || node.kind === "group" ? depth : depth + 1)}
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
