import { useState, useEffect, useMemo, useRef } from "react";
import { api } from "../api";
import type { ConnSummary, DbMemoryDto, TreeModel } from "../types";
import { buildGroupedConnOptions } from "../types";

export interface SelectOption {
  value: string;
  label: string;
  tag?: string;
  icon?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (val: string) => void;
  placeholder?: string;
  width?: string | number;
  minWidth?: string | number;
  maxWidth?: string | number;
  disabled?: boolean;
}

function CustomSelect({
  value,
  options,
  onChange,
  placeholder,
  width,
  minWidth,
  maxWidth,
  disabled,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectedOption = options.find((o) => o.value === value);

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.tag && o.tag.toLowerCase().includes(q))
    );
  }, [options, search]);

  return (
    <div
      className="mem-custom-select"
      ref={containerRef}
      style={{
        width: width || "auto",
        minWidth: minWidth || "auto",
        maxWidth: maxWidth || "none",
      }}
    >
      <button
        type="button"
        className={`mem-custom-select-trigger ${open ? "open" : ""}`}
        style={{ width: "100%" }}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span className="mem-custom-select-value">
          {selectedOption ? (
            <>
              {selectedOption.icon && (
                <span className="mem-custom-select-icon">{selectedOption.icon}</span>
              )}
              <span className="mem-custom-select-text">{selectedOption.label}</span>
              {selectedOption.tag && (
                <span className="mem-custom-select-tag">{selectedOption.tag}</span>
              )}
            </>
          ) : (
            <span style={{ color: "var(--text-tertiary)" }}>
              {placeholder || "请选择"}
            </span>
          )}
        </span>
        <span className={`mem-custom-select-caret ${open ? "open" : ""}`}>▾</span>
      </button>

      {open && (
        <div className="mem-custom-select-menu">
          {options.length > 7 && (
            <div className="mem-custom-select-search">
              <input
                type="text"
                placeholder="搜索筛选..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <div style={{ maxHeight: "220px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "1px" }}>
            {filteredOptions.length === 0 ? (
              <div style={{ padding: "8px 10px", fontSize: "11.5px", color: "var(--text-tertiary)", textAlign: "center" }}>
                无匹配项
              </div>
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    className={`mem-custom-select-item ${isSelected ? "active" : ""}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <div className="mem-custom-select-item-left">
                      {opt.icon && (
                        <span className="mem-custom-select-icon">{opt.icon}</span>
                      )}
                      <span className="mem-custom-select-text">{opt.label}</span>
                      {opt.tag && (
                        <span className="mem-custom-select-tag">{opt.tag}</span>
                      )}
                    </div>
                    {isSelected && <span className="mem-custom-select-check">✓</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface DbMemoryModalProps {
  tree?: TreeModel;
  conns: ConnSummary[];
  activeConnId?: string | null;
  activeDb?: string | null;
  onClose: () => void;
  embedded?: boolean;
}

export function DbMemoryModal({
  tree,
  conns,
  activeConnId,
  activeDb,
  onClose,
  embedded = false,
}: DbMemoryModalProps) {
  const [selectedConnId, setSelectedConnId] = useState<string>(activeConnId || "");
  const [selectedDb, setSelectedDb] = useState<string>(activeDb || "");
  const [availableDbs, setAvailableDbs] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [memories, setMemories] = useState<DbMemoryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editDb, setEditDb] = useState("");

  // Adding state
  const [adding, setAdding] = useState(false);
  const [newConnId, setNewConnId] = useState<string>(activeConnId || conns[0]?.id || "");
  const [newDb, setNewDb] = useState<string>(activeDb || "");
  const [newContent, setNewContent] = useState("");
  const [newAvailableDbs, setNewAvailableDbs] = useState<string[]>([]);

  // Load databases when selectedConnId changes
  useEffect(() => {
    if (!selectedConnId) {
      setAvailableDbs([]);
      return;
    }
    const c = conns.find((x) => x.id === selectedConnId);
    if (!c || c.db_type !== "mysql") {
      setAvailableDbs([]);
      return;
    }
    let isCancelled = false;
    api.listDatabases(selectedConnId).then((list) => {
      if (!isCancelled) {
        setAvailableDbs(list);
      }
    }).catch((err) => {
      console.warn("Failed to load databases for connection", err);
    });
    return () => {
      isCancelled = true;
    };
  }, [selectedConnId, conns]);

  // Load databases for new memory form
  useEffect(() => {
    if (!newConnId) {
      setNewAvailableDbs([]);
      return;
    }
    const c = conns.find((x) => x.id === newConnId);
    if (!c || c.db_type !== "mysql") {
      setNewAvailableDbs([]);
      return;
    }
    let isCancelled = false;
    api.listDatabases(newConnId).then((list) => {
      if (!isCancelled) {
        setNewAvailableDbs(list);
      }
    }).catch(() => {});
    return () => {
      isCancelled = true;
    };
  }, [newConnId, conns]);

  // Fetch memories based on selected filters
  const loadMemories = async () => {
    setLoading(true);
    try {
      if (!selectedConnId) {
        const list = await api.listAllDbMemories(200);
        setMemories(list);
      } else {
        const list = await api.getDbMemories(selectedConnId, selectedDb || null);
        setMemories(list);
      }
    } catch (err) {
      console.error("Failed to load memories", err);
      setMsg("加载记忆失败: " + String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMemories();
  }, [selectedConnId, selectedDb]);

  // Quick message clearing
  useEffect(() => {
    if (msg) {
      const timer = setTimeout(() => setMsg(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [msg]);

  // Filter memories by keyword
  const filteredMemories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(q) ||
        m.user_raw.toLowerCase().includes(q) ||
        (m.database && m.database.toLowerCase().includes(q))
    );
  }, [memories, search]);

  const connMap = useMemo(() => {
    const map = new Map<string, ConnSummary>();
    for (const c of conns) {
      map.set(c.id, c);
    }
    return map;
  }, [conns]);

  const connOptions: SelectOption[] = useMemo(() => {
    const list: SelectOption[] = [{ value: "", label: "全部连接", icon: "🌐" }];
    if (tree) {
      const groups = buildGroupedConnOptions(tree, conns);
      for (const g of groups) {
        for (const c of g.conns) {
          list.push({
            value: c.id,
            label: c.name,
            tag: g.label.replace(/^🌐\s*/, "").replace(/^📁\s*/, ""),
            icon: c.db_type === "redis" ? "🔴" : "🐬",
          });
        }
      }
    } else {
      for (const c of conns) {
        list.push({
          value: c.id,
          label: c.name,
          tag: c.db_type,
          icon: c.db_type === "redis" ? "🔴" : "🐬",
        });
      }
    }
    return list;
  }, [tree, conns]);

  const dbOptions: SelectOption[] = useMemo(() => {
    return [
      { value: "", label: "全部库（含连接通用）", icon: "🏠" },
      ...availableDbs.map((db) => ({
        value: db,
        label: db,
        icon: "🗄",
      })),
    ];
  }, [availableDbs]);

  const newConnOptions: SelectOption[] = useMemo(() => {
    const list: SelectOption[] = [];
    if (tree) {
      const groups = buildGroupedConnOptions(tree, conns);
      for (const g of groups) {
        for (const c of g.conns) {
          list.push({
            value: c.id,
            label: c.name,
            tag: g.label.replace(/^🌐\s*/, "").replace(/^📁\s*/, ""),
            icon: c.db_type === "redis" ? "🔴" : "🐬",
          });
        }
      }
    } else {
      for (const c of conns) {
        list.push({
          value: c.id,
          label: c.name,
          tag: c.db_type,
          icon: c.db_type === "redis" ? "🔴" : "🐬",
        });
      }
    }
    return list;
  }, [tree, conns]);

  const newDbOptions: SelectOption[] = useMemo(() => {
    return [
      { value: "", label: "整个连接实例生效（全局）", icon: "🏠" },
      ...newAvailableDbs.map((db) => ({
        value: db,
        label: db,
        icon: "🗄",
      })),
    ];
  }, [newAvailableDbs]);

  const handleStartEdit = (m: DbMemoryDto) => {
    setEditingId(m.id);
    setEditContent(m.content);
    setEditDb(m.database || "");
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editContent.trim()) return;
    try {
      const updated = await api.updateDbMemory(editingId, editContent.trim(), editDb || null);
      setMemories((prev) =>
        prev.map((m) => (m.id === editingId ? updated : m))
      );
      setEditingId(null);
      setMsg("记忆已纠正更新");
    } catch (err) {
      setMsg("保存失败: " + String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteDbMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      if (editingId === id) setEditingId(null);
      setMsg("已删除该条记忆");
    } catch (err) {
      setMsg("删除失败: " + String(err));
    }
  };

  const handleCreateMemory = async () => {
    if (!newConnId || !newContent.trim()) {
      setMsg("请填写完整的规则内容");
      return;
    }
    try {
      const created = await api.addDbMemory(newConnId, newContent.trim(), newDb || null);
      setMemories((prev) => [created, ...prev]);
      setAdding(false);
      setNewContent("");
      setMsg("新记忆已添加");
    } catch (err) {
      setMsg("添加失败: " + String(err));
    }
  };

  const formatTime = (ts: number) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - ts;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const innerContent = (
    <div
      className={embedded ? "db-memory-embedded" : "modal wide db-memory-modal"}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Modal Header */}
      <div className="mem-modal-head">
        <div className="mem-modal-title-wrap">
          <div className="mem-modal-title-row">
            <span className="mem-modal-icon">🧠</span>
            <h3 className="mem-modal-title">数据库记忆管理</h3>
            <span className="mem-count-badge">
              {filteredMemories.length} 条规则
            </span>
          </div>
          <div className="mem-modal-desc">
            沉淀您在日常对话中对 AI 的纠错、业务偏好与防坑约束，在后续查询中强制遵循
          </div>
        </div>
        {!embedded && (
          <button
            type="button"
            className="mem-modal-close-btn"
            onClick={onClose}
            title="关闭 (ESC)"
          >
            ×
          </button>
        )}
      </div>

      {/* Toolbar & Filters */}
        <div className="mem-modal-toolbar">
          <div className="mem-filter-group">
            {/* Connection Filter */}
            <div className="mem-filter-item">
              <span className="mem-filter-label">连接:</span>
              <CustomSelect
                value={selectedConnId}
                options={connOptions}
                onChange={(val) => {
                  setSelectedConnId(val);
                  setSelectedDb("");
                }}
                minWidth="160px"
                maxWidth="260px"
              />
            </div>

            {/* Database Filter */}
            {selectedConnId && (
              <div className="mem-filter-item">
                <span className="mem-filter-label">数据库:</span>
                <CustomSelect
                  value={selectedDb}
                  options={dbOptions}
                  onChange={(val) => setSelectedDb(val)}
                  minWidth="160px"
                  maxWidth="230px"
                />
              </div>
            )}

            {/* Search Input */}
            <div className="mem-search-wrap">
              <input
                type="text"
                className="mem-search-input"
                placeholder="搜索记忆规则或用户原话…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="mem-search-clear"
                  onClick={() => setSearch("")}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Add New Rule Button */}
          <button
            type="button"
            className="mem-btn-add"
            onClick={() => setAdding(!adding)}
          >
            <span>{adding ? "收起表单" : "＋ 手动添加规则"}</span>
          </button>
        </div>

        {/* Global Alert / Toast */}
        {msg && (
          <div className="mem-alert-bar">
            <span>ℹ</span>
            <span>{msg}</span>
          </div>
        )}

        {/* Add Memory Form */}
        {adding && (
          <div className="mem-form-card">
            <div className="mem-form-title">
              手动录入记忆规则
            </div>
            <div className="mem-form-grid">
              <div className="mem-form-field">
                <label className="mem-form-label">
                  生效连接
                </label>
                <CustomSelect
                  value={newConnId}
                  options={newConnOptions}
                  onChange={(val) => {
                    setNewConnId(val);
                    setNewDb("");
                  }}
                  width="100%"
                />
              </div>
              <div className="mem-form-field">
                <label className="mem-form-label">
                  限定数据库（留空则整个连接生效）
                </label>
                <CustomSelect
                  value={newDb}
                  options={newDbOptions}
                  onChange={(val) => setNewDb(val)}
                  width="100%"
                />
              </div>
            </div>
            <div className="mem-form-field">
              <label className="mem-form-label">
                硬性规则内容（陈述句，指导 AI 查询时必须遵守的约束）
              </label>
              <textarea
                rows={2}
                className="mem-form-textarea"
                placeholder="例如：查询房产项目时必须排除包含'测试'的项目；yk_config 表使用 code 字段作为配置键，而非 key 字段"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
              />
            </div>
            <div className="mem-form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                style={{ height: "28px", padding: "0 12px", fontSize: "12px" }}
                onClick={() => setAdding(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ height: "28px", padding: "0 16px", fontSize: "12px" }}
                onClick={handleCreateMemory}
              >
                保存规则
              </button>
            </div>
          </div>
        )}

        {/* Memory List Area */}
        <div className="mem-list-container">
          {loading && memories.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px", color: "var(--text-tertiary)" }}>
              正在加载记忆列表…
            </div>
          )}

          {!loading && filteredMemories.length === 0 && (
            <div className="mem-empty-box">
              <span className="mem-empty-icon">💭</span>
              <div className="mem-empty-title">
                {search ? `未搜索到包含 “${search}” 的记忆规则` : "暂无沉淀的数据库记忆"}
              </div>
              <div className="mem-empty-sub">
                当您在日常对话中对 AI 进行纠错（如“不要测过项目的”、“用code不是key”）或者严厉指责时，系统会自动将硬规则提炼并沉淀在此；您也可以随时在上方手动添加。
              </div>
              {!adding && (
                <button
                  type="button"
                  className="mem-btn-add"
                  style={{ marginTop: "4px" }}
                  onClick={() => setAdding(true)}
                >
                  ＋ 立即录入第一条规则
                </button>
              )}
            </div>
          )}

          {filteredMemories.map((m) => {
            const conn = connMap.get(m.conn_id);
            const connName = conn ? conn.name : m.conn_id;
            const scopeLabel = m.database ? `${connName} · ${m.database}` : `${connName} (整个连接通用)`;
            const isEditing = editingId === m.id;

            return (
              <div
                key={m.id}
                className={"mem-card" + (isEditing ? " editing" : "")}
              >
                {/* Card Top Meta */}
                <div className="mem-card-header">
                  <div className="mem-card-tags">
                    <span className={"mem-tag-scope" + (!m.database ? " global" : "")}>
                      <span>{m.database ? "🗄" : "🌐"}</span>
                      <span>{scopeLabel}</span>
                    </span>

                    {m.source === "harsh_correction" && (
                      <span className="mem-tag-source harsh">
                        ⚡ 严厉指正
                      </span>
                    )}
                    {m.source === "correction" && (
                      <span className="mem-tag-source correction">
                        🛠 用户纠错
                      </span>
                    )}
                    {m.source === "manual" && (
                      <span className="mem-tag-source manual">
                        ✍ 手动录入
                      </span>
                    )}

                    <span className="mem-card-time">
                      {formatTime(m.updated)}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="mem-card-actions">
                    {!isEditing && (
                      <>
                        <button
                          type="button"
                          className="mem-btn-icon"
                          onClick={() => handleStartEdit(m)}
                          title="纠正 / 修改该条记忆"
                        >
                          ✏️ 纠正
                        </button>
                        <button
                          type="button"
                          className="mem-btn-icon danger"
                          onClick={() => handleDelete(m.id)}
                          title="删除该条记忆"
                        >
                          🗑️
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Card Body / Edit Form */}
                {isEditing ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
                    <textarea
                      rows={2}
                      className="mem-form-textarea"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>所属数据库:</span>
                        <CustomSelect
                          value={editDb}
                          options={[
                            { value: "", label: "整个连接通用", icon: "🏠" },
                            ...Array.from(new Set([
                              ...(m.database ? [m.database] : []),
                              ...(m.conn_id === selectedConnId ? availableDbs : []),
                            ])).map((d) => ({
                              value: d,
                              label: d,
                              icon: "🗄",
                            })),
                          ]}
                          onChange={(val) => setEditDb(val)}
                          minWidth="160px"
                          maxWidth="240px"
                        />
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ height: "26px", padding: "0 10px", fontSize: "11px" }}
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ height: "26px", padding: "0 14px", fontSize: "11px" }}
                          onClick={handleSaveEdit}
                        >
                          保存修改
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="mem-card-content">
                      {m.content}
                    </div>

                    {m.user_raw && m.user_raw !== m.content && (
                      <div className="mem-card-quote">
                        🗣️ 触发原话: “{m.user_raw}”
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Modal Footer */}
        <div className="mem-modal-footer">
          <span className="mem-footer-hint">
            <span>💡</span>
            <span>已记忆规则已持久化保存，针对该连接/库的后续对话将强制优先遵守</span>
          </span>
          {!embedded && (
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: "30px", padding: "0 22px", fontSize: "12px" }}
              onClick={onClose}
            >
              完成
            </button>
          )}
        </div>
      </div>
  );

  if (embedded) {
    return innerContent;
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      {innerContent}
    </div>
  );
}
