import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { TreeModel, ConnSummary } from "../types";

export interface SimpleGroupedSelectProps {
  tree: TreeModel;
  allConns: ConnSummary[];
  value: string;
  onChange: (connId: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

interface EnvGroupItem {
  id: string;
  name: string;
  conns: ConnSummary[];
}

interface EnvTreeItem {
  id: string;
  name: string;
  displayName: string;
  dbType?: string;
  groups: EnvGroupItem[];
  totalConns: number;
  singleGroup: boolean;
}

export function SimpleGroupedSelect({
  tree,
  allConns,
  value,
  onChange,
  placeholder = "请选择连接实例…",
  disabled = false,
}: SimpleGroupedSelectProps) {
  const [open, setOpen] = useState(false);
  // 默认全部收缩起来（空对象，所有环境和分组折叠）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 浮层相对于窗口的绝对坐标
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width: number;
    openUp: boolean;
  }>({ top: 0, left: 0, width: 220, openUp: false });

  // 构建两级层级树结构（环境 -> 业务分组 -> 连接）
  const envTree: EnvTreeItem[] = useMemo(() => {
    const list: EnvTreeItem[] = [];
    const groupedConnIds = new Set<string>();

    // 统计各环境名称出现的次数，用于区分同名环境（如 MySQL 开发环境 vs Redis 开发环境）
    const envNameCounts = new Map<string, number>();
    for (const env of tree.environments) {
      envNameCounts.set(env.name, (envNameCounts.get(env.name) || 0) + 1);
    }

    for (const env of tree.environments) {
      const validGroups: EnvGroupItem[] = [];
      let totalConns = 0;

      for (const g of env.groups) {
        if (g.connections.length > 0) {
          for (const c of g.connections) {
            groupedConnIds.add(c.id);
          }
          validGroups.push({
            id: g.id,
            name: g.name,
            conns: g.connections,
          });
          totalConns += g.connections.length;
        }
      }

      if (validGroups.length > 0) {
        const singleGroup =
          validGroups.length === 1 &&
          (validGroups[0].name === env.name ||
            validGroups[0].name === "默认分组" ||
            validGroups[0].name === "默认");

        const needTypeBadge = (envNameCounts.get(env.name) || 0) > 1;
        const typeLabel = env.db_type === "redis" ? "Redis" : "MySQL";
        const displayName = needTypeBadge
          ? `${env.name} (${typeLabel})`
          : env.name;

        list.push({
          id: env.id,
          name: env.name,
          displayName,
          dbType: env.db_type,
          groups: validGroups,
          totalConns,
          singleGroup,
        });
      }
    }

    // 未分组连接
    const ungrouped = allConns.filter((c) => !groupedConnIds.has(c.id));
    if (ungrouped.length > 0) {
      list.push({
        id: "__ungrouped",
        name: "未分组连接",
        displayName: "未分组连接",
        groups: [
          {
            id: "__ungrouped_grp",
            name: "未分组",
            conns: ungrouped,
          },
        ],
        totalConns: ungrouped.length,
        singleGroup: true,
      });
    }

    return list;
  }, [tree, allConns]);

  // 打开时计算浮层相对于视口的坐标
  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const menuH = 260;
      const openUp = spaceBelow < menuH && rect.top > spaceBelow;

      setMenuPos({
        top: openUp ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 240),
        openUp,
      });
    }
  }, [open]);

  // 点击外部、按 ESC 或外层滚动时自动收起菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(target)) {
        return;
      }
      if (menuRef.current && menuRef.current.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // 当前选中的连接实例
  const selectedConn = useMemo(
    () => allConns.find((c) => c.id === value),
    [allConns, value]
  );

  const toggleKey = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className={`simple-grouped-select ${open ? "open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`simple-grouped-trigger ${disabled ? "disabled" : ""}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <div className="simple-grouped-val">
          {selectedConn ? (
            <>
              <span className="simple-item-icon">
                {selectedConn.db_type === "redis" ? "🔴" : "🐬"}
              </span>
              <span className="simple-grouped-name">{selectedConn.name}</span>
            </>
          ) : (
            <span className="simple-grouped-placeholder">{placeholder}</span>
          )}
        </div>
        <span className={`simple-grouped-arrow ${open ? "up" : ""}`}>▾</span>
      </button>

      {/* 核心改动：使用 createPortal 挂载到 body，浮动在最外层，完全不影响卡片高度与布局 */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`simple-grouped-menu floating ${
              menuPos.openUp ? "open-up" : ""
            }`}
            style={{
              position: "fixed",
              top: menuPos.openUp ? undefined : `${menuPos.top}px`,
              bottom: menuPos.openUp
                ? `${window.innerHeight - menuPos.top}px`
                : undefined,
              left: `${menuPos.left}px`,
              minWidth: `${menuPos.width}px`,
              maxWidth: "420px",
              zIndex: 99999,
            }}
          >
            {envTree.length === 0 ? (
              <div className="simple-grouped-empty">暂无可用连接</div>
            ) : (
              envTree.map((env) => {
                const envKey = `env_${env.id}`;
                const isEnvExpanded = !!expanded[envKey];

                return (
                  <div key={env.id} className="simple-env-block">
                    {/* 一级：环境行（默认全部收起，点击展开/折叠） */}
                    <div
                      className="simple-env-header"
                      onClick={(e) => toggleKey(envKey, e)}
                    >
                      <svg
                        className={`simple-chevron-svg ${
                          isEnvExpanded ? "expanded" : ""
                        }`}
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      <span className="simple-icon">
                        {env.dbType === "redis" ? "🔴" : "🌐"}
                      </span>
                      <span className="simple-title env-title">
                        {env.displayName}
                      </span>
                      <span className="simple-count">{env.totalConns}</span>
                    </div>

                    {/* 展开后的二级内容 */}
                    {isEnvExpanded && (
                      <div className="simple-env-content">
                        {env.singleGroup ? (
                          /* 单分组环境：直接展示连接列表 */
                          <div className="simple-conn-list single">
                            {env.groups[0].conns.map((c) => {
                              const isSel = c.id === value;
                              return (
                                <div
                                  key={c.id}
                                  className={`simple-conn-item ${
                                    isSel ? "active" : ""
                                  }`}
                                  onClick={() => {
                                    onChange(c.id);
                                    setOpen(false);
                                  }}
                                >
                                  <span className="simple-item-icon">
                                    {c.db_type === "redis" ? "🔴" : "🐬"}
                                  </span>
                                  <span className="simple-item-name">
                                    {c.name}
                                  </span>
                                  {isSel && (
                                    <span className="simple-item-check">✓</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          /* 多分组环境：展示二级分组列表（默认收起，点击展开） */
                          <div className="simple-grp-list">
                            {env.groups.map((grp) => {
                              const grpKey = `grp_${grp.id}`;
                              const isGrpExpanded = !!expanded[grpKey];

                              return (
                                <div key={grp.id} className="simple-grp-block">
                                  <div
                                    className="simple-grp-header"
                                    onClick={(e) => toggleKey(grpKey, e)}
                                  >
                                    <svg
                                      className={`simple-chevron-svg ${
                                        isGrpExpanded ? "expanded" : ""
                                      }`}
                                      width="10"
                                      height="10"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2.5"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                    <span className="simple-icon">📁</span>
                                    <span className="simple-title grp-title">
                                      {grp.name}
                                    </span>
                                    <span className="simple-count">
                                      {grp.conns.length}
                                    </span>
                                  </div>

                                  {/* 展开后的三级连接列表 */}
                                  {isGrpExpanded && (
                                    <div className="simple-conn-list nested">
                                      {grp.conns.map((c) => {
                                        const isSel = c.id === value;
                                        return (
                                          <div
                                            key={c.id}
                                            className={`simple-conn-item ${
                                              isSel ? "active" : ""
                                            }`}
                                            onClick={() => {
                                              onChange(c.id);
                                              setOpen(false);
                                            }}
                                          >
                                            <span className="simple-item-icon">
                                              {c.db_type === "redis"
                                                ? "🔴"
                                                : "🐬"}
                                            </span>
                                            <span className="simple-item-name">
                                              {c.name}
                                            </span>
                                            {isSel && (
                                              <span className="simple-item-check">
                                                ✓
                                              </span>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
