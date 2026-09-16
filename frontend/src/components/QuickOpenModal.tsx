import React, { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../api";
import type { TreeModel } from "../types";

export interface QuickOpenModalProps {
  open: boolean;
  onClose: () => void;
  tree: TreeModel;
  onBrowseTable: (connId: string, db: string, table: string) => void;
  onSelectDb?: (connId: string, db: string) => void;
  onNewQuery?: (connId: string, db: string) => void;
}

interface SearchItem {
  id: string;
  kind: "table" | "db";
  title: string;
  subTitle: string;
  connId: string;
  db: string;
  table?: string;
  comment?: string;
}

export const QuickOpenModal: React.FC<QuickOpenModalProps> = ({
  open,
  onClose,
  tree,
  onBrowseTable,
  onSelectDb,
  onNewQuery,
}) => {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [remoteTables, setRemoteTables] = useState<SearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 1. Gather all connections and cached databases from TreeModel
  const baseItems = useMemo<SearchItem[]>(() => {
    const list: SearchItem[] = [];
    tree.environments.forEach((env) => {
      env.groups.forEach((grp) => {
        grp.connections.forEach((conn) => {
          if (conn.database) {
            list.push({
              id: `db:${conn.id}:${conn.database}`,
              kind: "db",
              title: conn.database,
              subTitle: `${conn.name} (${conn.host}:${conn.port}) · 数据库`,
              connId: conn.id,
              db: conn.database,
            });
          }
        });
      });
    });
    return list;
  }, [tree]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setRemoteTables([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Search remote tables across connections when user types 2+ characters
  useEffect(() => {
    const q = query.trim();
    if (!open || !q || q.length < 1) {
      setRemoteTables([]);
      return;
    }

    let isCancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found: SearchItem[] = [];

      // Collect all MySQL connections (regardless of whether they have a default database)
      const conns: { id: string; name: string; host: string; port: number }[] = [];
      tree.environments.forEach((env) => {
        env.groups.forEach((grp) => {
          grp.connections.forEach((c) => {
            if (c.db_type !== "redis" && !conns.some((x) => x.id === c.id)) {
              conns.push({ id: c.id, name: c.name, host: c.host, port: c.port });
            }
          });
        });
      });

      try {
        // Parallel concurrent search across all connections with 1800ms timeout per connection
        const searchTasks = conns.map(async (conn) => {
          try {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 1800)
            );
            const items = await Promise.race([
              api.searchCatalog(conn.id, q, 35),
              timeoutPromise,
            ]);
            return { conn, items };
          } catch {
            return { conn, items: [] };
          }
        });

        const settled = await Promise.allSettled(searchTasks);
        for (const res of settled) {
          if (res.status === "fulfilled" && res.value) {
            const { conn, items } = res.value;
            items.forEach((item) => {
              if (item.table) {
                found.push({
                  id: `tbl:${conn.id}:${item.db}:${item.table}`,
                  kind: "table",
                  title: item.table,
                  subTitle: `${conn.name} › ${item.db}`,
                  connId: conn.id,
                  db: item.db,
                  table: item.table,
                  comment: item.comment || undefined,
                });
              } else {
                found.push({
                  id: `db:${conn.id}:${item.db}`,
                  kind: "db",
                  title: item.db,
                  subTitle: `${conn.name} (${conn.host}:${conn.port}) · 数据库`,
                  connId: conn.id,
                  db: item.db,
                });
              }
            });
          }
        }
      } catch (err) {
        console.warn("[QuickOpen] searchCatalog error:", err);
      } finally {
        if (!isCancelled) {
          setRemoteTables(found);
          setSearching(false);
        }
      }
    }, 120);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [query, open, tree]);

  // Combine and rank items by relevance
  const matchedItems = useMemo<SearchItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return baseItems;

    const filteredBase = baseItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subTitle.toLowerCase().includes(q)
    );

    const combined = [...remoteTables, ...filteredBase];
    const seen = new Set<string>();
    const deduped = combined.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    // Sort by strict relevance:
    // 1. Exact match in title
    // 2. Title starts with query
    // 3. Title contains query
    // 4. Comment / subtitle match
    return deduped.sort((a, b) => {
      const aTitle = a.title.toLowerCase();
      const bTitle = b.title.toLowerCase();

      const aExact = aTitle === q;
      const bExact = bTitle === q;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      const aStarts = aTitle.startsWith(q);
      const bStarts = bTitle.startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      const aHas = aTitle.includes(q);
      const bHas = bTitle.includes(q);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;

      return aTitle.localeCompare(bTitle);
    });
  }, [baseItems, remoteTables, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [matchedItems.length]);

  const handleSelect = (item: SearchItem) => {
    if (item.kind === "table" && item.table) {
      onBrowseTable(item.connId, item.db, item.table);
    } else if (item.kind === "db") {
      if (onNewQuery) onNewQuery(item.connId, item.db);
      else if (onSelectDb) onSelectDb(item.connId, item.db);
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((prev) => (matchedItems.length === 0 ? 0 : (prev + 1) % matchedItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((prev) => (matchedItems.length === 0 ? 0 : (prev - 1 + matchedItems.length) % matchedItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matchedItems[activeIdx]) {
        handleSelect(matchedItems[activeIdx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="quick-open-mask" onClick={onClose}>
      <div className="quick-open-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Top search input box */}
        <div className="quick-open-header">
          <svg className="quick-open-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="quick-open-input"
            placeholder="键入表名、库名穿透直达 (支持拼音/英文，按 ↵ 打开)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="quick-open-kbd">ESC</span>
        </div>

        {/* Results list */}
        <div className="quick-open-list">
          {matchedItems.length === 0 ? (
            <div className="quick-open-empty">
              {searching ? "正在全局索引搜索中…" : query ? "未找到匹配的数据库或表" : "输入关键词快速检索任意表或库"}
            </div>
          ) : (
            matchedItems.slice(0, 30).map((item, idx) => {
              const isCur = idx === activeIdx;
              return (
                <div
                  key={item.id}
                  className={"quick-open-item" + (isCur ? " active" : "")}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setActiveIdx(idx)}
                >
                  <span className="quick-open-item-icon">
                    {item.kind === "table" ? "▤" : "🐬"}
                  </span>
                  <div className="quick-open-item-info">
                    <div className="quick-open-item-title">
                      <span>{item.title}</span>
                      {item.comment && <span className="quick-open-item-comment">({item.comment})</span>}
                    </div>
                    <div className="quick-open-item-subtitle">{item.subTitle}</div>
                  </div>
                  <span className="quick-open-enter-hint">↵ 打开</span>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="quick-open-footer">
          <span>↑ ↓ 键选择 · ↵ 回车直达打开 · ESC 退出</span>
          {searching && <span className="quick-open-searching-tag">正在检索表…</span>}
        </div>
      </div>
    </div>
  );
};
