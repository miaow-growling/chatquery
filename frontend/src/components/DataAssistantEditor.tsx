import React, { useState, useEffect, useRef } from "react";
import type {
  AssistantDbBinding,
  ConnSummary,
  DataAssistant,
  DataAssistantInput,
  KbDocDto,
} from "../types";

export interface DataAssistantEditorProps {
  initialAssistant: DataAssistant | null;
  isNew: boolean;
  allConns: ConnSummary[];
  kbDocs: KbDocDto[];
  kbDbCache: Record<string, string[]>;
  kbLoadingDbs: string | null;
  loadKbDbs: (connId: string) => Promise<void>;
  onSave: (data: DataAssistantInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}

export const DataAssistantEditor: React.FC<DataAssistantEditorProps> = ({
  initialAssistant,
  isNew,
  allConns,
  kbDocs,
  kbDbCache,
  kbLoadingDbs,
  loadKbDbs,
  onSave,
  onDelete,
}) => {
  const [name, setName] = useState(initialAssistant?.name || "");
  const [avatar, setAvatar] = useState(initialAssistant?.avatar || "🤖");
  const [desc, setDesc] = useState(initialAssistant?.description || "");
  const [prompt, setPrompt] = useState(initialAssistant?.system_prompt || "");
  const [boundDbs, setBoundDbs] = useState<AssistantDbBinding[]>(
    initialAssistant?.bound_databases ? [...initialAssistant.bound_databases] : []
  );
  const [boundKbs, setBoundKbs] = useState<string[]>(
    initialAssistant?.bound_knowledge_base_ids ? [...initialAssistant.bound_knowledge_base_ids] : []
  );
  const [newConn, setNewConn] = useState("");
  const [newDb, setNewDb] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [kbDropdownOpen, setKbDropdownOpen] = useState(false);
  const [kbSearch, setKbSearch] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const kbDropdownRef = useRef<HTMLDivElement>(null);

  // 当切换编辑目标时同步状态
  useEffect(() => {
    setName(initialAssistant?.name || "");
    setAvatar(initialAssistant?.avatar || "🤖");
    setDesc(initialAssistant?.description || "");
    setPrompt(initialAssistant?.system_prompt || "");
    setBoundDbs(
      initialAssistant?.bound_databases ? [...initialAssistant.bound_databases] : []
    );
    setBoundKbs(
      initialAssistant?.bound_knowledge_base_ids
        ? [...initialAssistant.bound_knowledge_base_ids]
        : []
    );
    setNewConn("");
    setNewDb("");
    setEmojiOpen(false);
    setKbDropdownOpen(false);
    setKbSearch("");
    setMsg(null);
  }, [initialAssistant?.id, isNew]);

  // 点击外部收起下拉框
  useEffect(() => {
    if (!kbDropdownOpen && !emojiOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        kbDropdownRef.current &&
        !kbDropdownRef.current.contains(e.target as Node)
      ) {
        setKbDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [kbDropdownOpen, emojiOpen]);

  const addBinding = (connId: string, database: string | null) => {
    if (!connId) return;
    setBoundDbs((prev) => {
      if (
        prev.some(
          (b) =>
            b.conn_id === connId &&
            (b.database ?? null) === (database ?? null)
        )
      ) {
        return prev;
      }
      return [...prev, { conn_id: connId, database: database ?? null }];
    });
  };

  const removeBinding = (idx: number) => {
    setBoundDbs((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setMsg(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setMsg({ ok: false, text: "请填写数据助手名称" });
      return;
    }
    try {
      setSubmitting(true);
      await onSave({
        id: isNew ? undefined : initialAssistant?.id,
        name: trimmed,
        avatar,
        description: desc.trim(),
        system_prompt: prompt,
        bound_databases: boundDbs,
        bound_knowledge_base_ids: boundKbs,
      });
      setMsg({ ok: true, text: "保存成功" });
    } catch (e) {
      setMsg({ ok: false, text: "保存失败: " + String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ast-form-container">
      <div className="ast-form-scroll">
        {/* 卡片 1：基础信息 */}
        <div className="ast-section-card">
          <div className="ast-section-header">
            <span className="ast-section-title">
              <span>👤</span> 基础信息
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div>
              <label className="kb-label" style={{ marginBottom: "6px" }}>
                助手名称 & 图标 <span style={{ color: "var(--danger-500, #ef4444)" }}>*</span>
              </label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <button
                  type="button"
                  className="ast-avatar-btn"
                  title="点击更换 Emoji 图标"
                  onClick={() => setEmojiOpen((v) => !v)}
                >
                  {avatar}
                </button>
                <input
                  type="text"
                  className="kb-input"
                  style={{ flex: 1 }}
                  placeholder="例如：电商运营专家 / 财务数据分析师"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </div>
            </div>

            {emojiOpen && (
              <div className="ast-emoji-popover">
                {[
                  "🤖", "🛒", "📊", "💡", "💰", "🎯", "👤", "🛠️",
                  "🔍", "⚡", "📈", "🛡️", "📦", "🚀", "🏷️", "💼",
                ].map((em) => (
                  <button
                    key={em}
                    type="button"
                    className={"ast-emoji-option" + (avatar === em ? " selected" : "")}
                    onClick={() => {
                      setAvatar(em);
                      setEmojiOpen(false);
                    }}
                  >
                    {em}
                  </button>
                ))}
              </div>
            )}

            <div>
              <label className="kb-label" style={{ marginBottom: "6px" }}>
                定位描述
              </label>
              <input
                type="text"
                className="kb-input"
                placeholder="简述该助手的业务职责（例如：专注于订单转化、GMV核算与用户生命周期分析）"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </div>
          </div>
        </div>

        {/* 卡片 2：关联数据库（连接 / 具体数据库） */}
        <div
          className="kb-bindings-card"
          style={{
            background: "var(--bg-surface, rgba(255,255,255,0.03))",
            border: "1px solid var(--border, rgba(255,255,255,0.08))",
            borderRadius: "8px",
            padding: "14px 16px",
          }}
        >
          <div className="kb-bindings-head">
            <div>
              <div
                className="kb-bindings-title"
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--text-primary, #fff)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <span>🔗</span> 绑定到连接 / 具体数据库
                <span
                  className={
                    "ast-section-badge" + (boundDbs.length > 0 ? " highlight" : "")
                  }
                >
                  已绑定 {boundDbs.length} 项
                </span>
              </div>
              <div
                className="kb-bindings-sub"
                style={{
                  fontSize: "11px",
                  color: "var(--text-tertiary, #888)",
                  marginTop: "4px",
                }}
              >
                未绑定时，提问将自动继承会话选中的数据库；可精确绑定到具体库，支持多库协同查询
              </div>
            </div>
          </div>

          <div className="ast-bindings-list">
            {boundDbs.length === 0 ? (
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-tertiary, #888)",
                  padding: "6px 0",
                }}
              >
                未关联具体数据库（执行时将自动继承当前会话数据库）
              </div>
            ) : (
              boundDbs.map((b, i) => {
                const c = allConns.find((x) => x.id === b.conn_id);
                const isRedis = c?.db_type === "redis";
                const dbName = b.database || "默认库";
                return (
                  <div
                    className="ast-binding-chip"
                    key={i}
                    title={`${c?.name ?? b.conn_id} / ${dbName}`}
                  >
                    <span className="ast-binding-chip-icon">
                      {isRedis ? "🔴" : "🐬"}
                    </span>
                    <span className="ast-binding-chip-conn">
                      {c ? c.name : b.conn_id}
                    </span>
                    <span className="ast-binding-chip-sep">/</span>
                    <span className="ast-binding-chip-db">
                      {dbName}
                    </span>
                    <button
                      type="button"
                      className="ast-binding-chip-del"
                      title="移除此绑定"
                      onClick={() => removeBinding(i)}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="ast-bind-bar">
            <select
              className="ast-select-native"
              value={newConn}
              onChange={(e) => {
                setNewConn(e.target.value);
                setNewDb("");
                if (e.target.value) void loadKbDbs(e.target.value);
              }}
            >
              <option value="">请选择连接实例…</option>
              {allConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.db_type === "redis" ? "🔴 " : "🐬 "}
                  {c.name}
                </option>
              ))}
            </select>

            <span style={{ color: "var(--text-tertiary, #64748b)", fontSize: "12px", flexShrink: 0 }}>/</span>

            <select
              className="ast-select-native"
              value={newDb}
              disabled={!newConn}
              onChange={(e) => setNewDb(e.target.value)}
            >
              <option value="">整条连接（默认库）</option>
              {(kbDbCache[newConn] ?? []).map((db) => (
                <option key={db} value={db}>
                  🗄 {db}
                </option>
              ))}
              {kbLoadingDbs === newConn && (
                <option value="" disabled>
                  加载库列表中…
                </option>
              )}
            </select>

            <button
              type="button"
              className="ast-btn-add-bind"
              disabled={!newConn}
              onClick={() => {
                addBinding(newConn, newDb === "" ? null : newDb);
                setNewDb("");
              }}
            >
              ＋ 添加绑定
            </button>
          </div>
        </div>

        {/* 卡片 3：关联业务知识库（下拉多选） */}
        <div className="ast-section-card" ref={kbDropdownRef}>
          <div className="ast-section-header">
            <span className="ast-section-title">
              <span>📚</span> 关联业务知识库
              <span
                className={
                  "ast-section-badge" + (boundKbs.length > 0 ? " highlight" : "")
                }
              >
                已选 {boundKbs.length} 项
              </span>
            </span>
            {kbDocs.length > 0 && (
              <div style={{ display: "flex", gap: "8px", fontSize: "11px" }}>
                <button
                  type="button"
                  className="btn-kb-binding-add"
                  style={{ padding: "2px 6px", fontSize: "11px" }}
                  onClick={() => setBoundKbs(kbDocs.map((d) => d.id))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="btn-kb-binding-add"
                  style={{ padding: "2px 6px", fontSize: "11px" }}
                  onClick={() => setBoundKbs([])}
                >
                  清空
                </button>
              </div>
            )}
          </div>
          <div className="ast-section-desc">
            该助手执行时，将自动注入这些业务指标定义、计算公式与字段规范。
          </div>

          <div className="ast-select-wrap">
            <div
              className={"ast-select-trigger" + (kbDropdownOpen ? " open" : "")}
              onClick={() => {
                setKbDropdownOpen((v) => !v);
              }}
            >
              <div className="ast-select-tags">
                {boundKbs.length === 0 ? (
                  <span className="ast-select-placeholder">
                    点击选择关联知识库（支持多选）...
                  </span>
                ) : (
                  boundKbs.map((id) => {
                    const doc = kbDocs.find((x) => x.id === id);
                    if (!doc) return null;
                    return (
                      <span
                        key={id}
                        className="ast-select-tag"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span>📄</span>
                        <span>{doc.name}</span>
                        <span
                          className="ast-select-tag-del"
                          title="移除"
                          onClick={(e) => {
                            e.stopPropagation();
                            setBoundKbs((prev) => prev.filter((x) => x !== id));
                          }}
                        >
                          ×
                        </span>
                      </span>
                    );
                  })
                )}
              </div>
              <span className={"ast-select-arrow" + (kbDropdownOpen ? " open" : "")}>
                ▼
              </span>
            </div>

            {kbDropdownOpen && (
              <div
                className="ast-select-menu"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ast-select-menu-header">
                  <input
                    type="text"
                    className="ast-select-menu-search"
                    placeholder="搜索知识库文档..."
                    value={kbSearch}
                    onChange={(e) => setKbSearch(e.target.value)}
                    autoFocus
                    spellCheck={false}
                  />
                </div>
                <div className="ast-select-menu-list">
                  {kbDocs
                    .filter(
                      (d) =>
                        !kbSearch.trim() ||
                        d.name.toLowerCase().includes(kbSearch.toLowerCase())
                    )
                    .map((doc) => {
                      const checked = boundKbs.includes(doc.id);
                      return (
                        <div
                          key={doc.id}
                          className={
                            "ast-select-menu-item" + (checked ? " active" : "")
                          }
                          onClick={() => {
                            if (checked) {
                              setBoundKbs((prev) =>
                                prev.filter((x) => x !== doc.id)
                              );
                            } else {
                              setBoundKbs((prev) => [...prev, doc.id]);
                            }
                          }}
                        >
                          <span className="ast-select-checkbox">
                            {checked ? "✓" : ""}
                          </span>
                          <span>📄</span>
                          <span style={{ flex: 1 }}>{doc.name}</span>
                          <span
                            style={{
                              fontSize: "11px",
                              color: "var(--text-tertiary, #888)",
                            }}
                          >
                            {doc.content.length}字
                          </span>
                        </div>
                      );
                    })}
                  {kbDocs.length === 0 && (
                    <div className="ast-select-empty">暂无知识库文档</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 卡片 4：系统预设提示词 */}
        <div className="ast-section-card">
          <div className="ast-section-header">
            <span className="ast-section-title">
              <span>⚡</span> 预设提示词
              <span className="ast-section-badge">{prompt.length} 字</span>
            </span>
            <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
              <button
                type="button"
                className="ast-template-btn"
                onClick={() =>
                  setPrompt(
                    "你是一位专业的数据分析专家。请遵循以下规则：\n1. 优先使用只读 SELECT 查询，严禁任何未确认的破坏性操作；\n2. 解释查询结果时，先给出核心数据结论，再附带业务洞察与增长建议；\n3. 表格与报表请使用清晰规范的 Markdown 排版输出。"
                  )
                }
              >
                ⚡ 分析师
              </button>
              <button
                type="button"
                className="ast-template-btn"
                onClick={() =>
                  setPrompt(
                    "你是 SQL 性能调优专家。当用户给出查询意图或待优化 SQL 时：\n1. 深入分析执行计划、索引命中情况与潜在的全表扫描隐患；\n2. 给出改写后的高效 SQL 并重点标注优化理由；\n3. 说明复合索引建议与预计提升幅度。"
                  )
                }
              >
                🔍 SQL调优
              </button>
            </div>
          </div>
          <textarea
            className="kb-textarea"
            style={{
              minHeight: "150px",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "13px",
              resize: "vertical",
            }}
            placeholder="设定助手的专业身份、角色定位、数据口径与分析规范..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
      </div>

      {/* 底部固定操作栏（始终吸底可见） */}
      <div className="ast-footer-fixed">
        <div>
          {msg && (
            <div
              className={"cfg-msg " + (msg.ok ? "ok" : "err")}
              style={{ margin: 0 }}
            >
              {msg.text}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {!isNew && onDelete && (
            <button
              type="button"
              className="btn btn-danger"
              style={{ height: "34px", padding: "0 14px", fontSize: "13px" }}
              onClick={onDelete}
              disabled={submitting}
            >
              删除助手
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            style={{
              height: "34px",
              padding: "0 22px",
              fontSize: "13px",
              fontWeight: 600,
            }}
            onClick={handleSave}
            disabled={submitting}
          >
            {isNew ? "创建数据助手" : "保存修改"}
          </button>
        </div>
      </div>
    </div>
  );
};
