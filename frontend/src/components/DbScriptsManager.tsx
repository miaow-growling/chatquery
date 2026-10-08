import React, { useState, useEffect } from "react";
import type { ConnSummary, DbScript, DbScriptInput, ScriptExecResult, ScriptType, TreeModel } from "../types";
import { api } from "../api";
import { SimpleGroupedSelect } from "./SimpleGroupedSelect";

export interface DbScriptsManagerProps {
  tree?: TreeModel;
  allConns: ConnSummary[];
  onToast: (msg: string) => void;
}

const DEFAULT_ERROR_PATTERN = "Access denied|password.*expired|1045";

export const DbScriptsManager: React.FC<DbScriptsManagerProps> = ({ tree, allConns, onToast }) => {
  const [scripts, setScripts] = useState<DbScript[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedScript, setSelectedScript] = useState<DbScript | null>(null);
  const [isNew, setIsNew] = useState(false);

  // 表单状态
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [scriptType, setScriptType] = useState<ScriptType>("shell");
  const [content, setContent] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(30);
  const [boundConnIds, setBoundConnIds] = useState<string[]>([]);
  const [triggerOnError, setTriggerOnError] = useState(true);
  const [errorPattern, setErrorPattern] = useState(DEFAULT_ERROR_PATTERN);
  const [autoRetryQuery, setAutoRetryQuery] = useState(true);
  const [envVars, setEnvVars] = useState("{}");

  // Webhook 专属可视化状态
  const [httpMethod, setHttpMethod] = useState<string>("POST");
  const [httpUrl, setHttpUrl] = useState<string>("");
  const [httpHeaders, setHttpHeaders] = useState<Array<{ key: string; value: string }>>([
    { key: "Content-Type", value: "application/json" },
  ]);
  const [httpBody, setHttpBody] = useState<string>(
    "{\n  \"host\": \"{{CQ_CONN_HOST}}\",\n  \"user\": \"{{CQ_CONN_USER}}\"\n}"
  );
  const [enableExtract, setEnableExtract] = useState<boolean>(false);
  const [httpExtractKey, setHttpExtractKey] = useState<string>("data.new_password");
  const [webhookSubTab, setWebhookSubTab] = useState<"body" | "headers" | "extract">("body");

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(httpBody);
      setHttpBody(JSON.stringify(parsed, null, 2));
      onToast("JSON 已格式化");
    } catch {
      onToast("JSON 语法有误，无法格式化");
    }
  };

  const addHeaderPreset = (key: string, value: string) => {
    const idx = httpHeaders.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
    if (idx >= 0) {
      const next = [...httpHeaders];
      next[idx].value = value;
      setHttpHeaders(next);
    } else {
      setHttpHeaders([...httpHeaders, { key, value }]);
    }
  };

  const assembleWebhookContent = (): string => {
    const headersObj: Record<string, string> = {};
    for (const h of httpHeaders) {
      if (h.key.trim()) {
        headersObj[h.key.trim()] = h.value;
      }
    }
    return JSON.stringify(
      {
        url: httpUrl.trim(),
        method: httpMethod,
        headers: headersObj,
        body: httpMethod === "GET" ? undefined : httpBody,
        extract_password_field: enableExtract && httpExtractKey.trim() ? httpExtractKey.trim() : undefined,
      },
      null,
      2
    );
  };

  const parseWebhookContent = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        setHttpMethod(obj.method || "POST");
        setHttpUrl(obj.url || "");
        if (obj.headers && typeof obj.headers === "object") {
          const list = Object.entries(obj.headers).map(([k, v]) => ({
            key: k,
            value: String(v),
          }));
          setHttpHeaders(list.length > 0 ? list : [{ key: "Content-Type", value: "application/json" }]);
        } else {
          setHttpHeaders([{ key: "Content-Type", value: "application/json" }]);
        }
        setHttpBody(obj.body || "{\n  \"host\": \"{{CQ_CONN_HOST}}\",\n  \"user\": \"{{CQ_CONN_USER}}\"\n}");
        if (obj.extract_password_field && typeof obj.extract_password_field === "string" && obj.extract_password_field.trim()) {
          setEnableExtract(true);
          setHttpExtractKey(obj.extract_password_field.trim());
        } else {
          setEnableExtract(false);
          setHttpExtractKey("data.new_password");
        }
        return;
      } catch {}
    }
    setHttpMethod("POST");
    setHttpUrl(trimmed);
    setHttpHeaders([{ key: "Content-Type", value: "application/json" }]);
    setHttpBody("{\n  \"host\": \"{{CQ_CONN_HOST}}\",\n  \"user\": \"{{CQ_CONN_USER}}\"\n}");
    setEnableExtract(false);
    setHttpExtractKey("data.new_password");
  };

  // 即时测试状态
  const [testConnId, setTestConnId] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ScriptExecResult | null>(null);

  // 保存加载状态
  const [saving, setSaving] = useState(false);

  // 初始加载列表
  const loadScripts = async () => {
    setLoading(true);
    try {
      const list = await api.listDbScripts();
      setScripts(list);
      if (list.length > 0 && !selectedScript && !isNew) {
        selectScript(list[0]);
      }
    } catch (e) {
      onToast("加载脚本列表失败: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadScripts();
  }, []);

  const selectScript = (s: DbScript) => {
    setSelectedScript(s);
    setIsNew(false);
    setName(s.name);
    setDescription(s.description);
    setEnabled(s.enabled);
    setScriptType(s.script_type);
    setContent(s.content);
    if (s.script_type === "webhook") {
      parseWebhookContent(s.content);
    }
    setTimeoutSecs(s.timeout_secs);
    setBoundConnIds(s.bound_conn_ids || []);
    setTriggerOnError(s.trigger_on_error);
    setErrorPattern(s.error_pattern || DEFAULT_ERROR_PATTERN);
    setAutoRetryQuery(s.auto_retry_query);
    setEnvVars(s.env_vars || "{}");
    setTestResult(null);
    if (s.bound_conn_ids && s.bound_conn_ids.length > 0) {
      setTestConnId(s.bound_conn_ids[0]);
    } else if (allConns.length > 0) {
      setTestConnId(allConns[0].id);
    }
  };

  const startNewScript = () => {
    setSelectedScript(null);
    setIsNew(true);
    setName("新自动化脚本");
    setDescription("");
    setEnabled(true);
    setScriptType("shell");
    setContent(
      `# 示例: 数据库账号续期/连接准备脚本
echo "正在为数据库 [$CQ_CONN_NAME] 执行维护..."
# 如果获取到新密码，输出以下格式即可自动更新连接密码并重试查询：
# echo "CQ_UPDATE_CONNECTION: {\\"password\\": \\"NewSecretPassword123!\\"}"
`
    );
    setHttpMethod("POST");
    setHttpUrl("https://iam.internal.company.com/api/db/renew");
    setHttpHeaders([{ key: "Content-Type", value: "application/json" }]);
    setHttpBody("{\n  \"host\": \"{{CQ_CONN_HOST}}\",\n  \"user\": \"{{CQ_CONN_USER}}\"\n}");
    setEnableExtract(false);
    setHttpExtractKey("");
    setTimeoutSecs(30);
    setBoundConnIds([]);
    setTriggerOnError(true);
    setErrorPattern(DEFAULT_ERROR_PATTERN);
    setAutoRetryQuery(true);
    setEnvVars("{}");
    setTestResult(null);
    if (allConns.length > 0) {
      setTestConnId(allConns[0].id);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      onToast("脚本名称不能为空");
      return;
    }
    const finalContent = scriptType === "webhook" ? assembleWebhookContent() : content;
    setSaving(true);
    try {
      const input: DbScriptInput = {
        id: selectedScript ? selectedScript.id : undefined,
        name: name.trim(),
        description: description.trim(),
        enabled,
        script_type: scriptType,
        content: finalContent,
        timeout_secs: Number(timeoutSecs) || 30,
        env_vars: envVars,
        bound_conn_ids: boundConnIds,
        trigger_on_error: triggerOnError,
        error_pattern: errorPattern.trim(),
        auto_retry_query: autoRetryQuery,
      };
      const saved = await api.saveDbScript(input);
      onToast("脚本保存成功");
      await loadScripts();
      selectScript(saved);
    } catch (e) {
      onToast("保存失败: " + String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedScript) return;
    if (!window.confirm(`确定删除脚本「${selectedScript.name}」吗？`)) return;
    try {
      await api.deleteDbScript(selectedScript.id);
      onToast("脚本已删除");
      setSelectedScript(null);
      setIsNew(false);
      await loadScripts();
    } catch (e) {
      onToast("删除失败: " + String(e));
    }
  };

  const handleTestRun = async () => {
    if (!selectedScript && !isNew) return;
    setTesting(true);
    setTestResult(null);
    try {
      // 若当前为未保存的新脚本，先做临时保存
      let targetScriptId = selectedScript?.id;
      const finalContent = scriptType === "webhook" ? assembleWebhookContent() : content;
      if (!targetScriptId) {
        const tempSaved = await api.saveDbScript({
          name: name.trim() || "临时测试脚本",
          description,
          enabled,
          script_type: scriptType,
          content: finalContent,
          timeout_secs: Number(timeoutSecs) || 30,
          env_vars: envVars,
          bound_conn_ids: boundConnIds,
          trigger_on_error: triggerOnError,
          error_pattern: errorPattern,
          auto_retry_query: autoRetryQuery,
        });
        targetScriptId = tempSaved.id;
        setSelectedScript(tempSaved);
        setIsNew(false);
      }

      const res = await api.runDbScript(targetScriptId, testConnId || null, "manual", null);
      setTestResult(res);
      if (res.success) {
        onToast(`执行完成 · 耗时 ${res.duration_ms}ms`);
      } else {
        onToast(`执行未成功 · 退出码 ${res.exit_code}`);
      }
    } catch (e) {
      onToast("测试运行失败: " + String(e));
    } finally {
      setTesting(false);
    }
  };

  const toggleConnBinding = (cid: string) => {
    setBoundConnIds((prev) =>
      prev.includes(cid) ? prev.filter((id) => id !== cid) : [...prev, cid]
    );
  };

  const selectAllConns = () => {
    setBoundConnIds(allConns.map((c) => c.id));
  };

  const clearAllConns = () => {
    setBoundConnIds([]);
  };

  const insertVariable = (varName: string) => {
    setContent((prev) => prev + varName);
  };

  const typeIcon = (t: ScriptType) => {
    switch (t) {
      case "shell":
        return "⚡";
      case "webhook":
        return "🌐";
      case "python":
        return "🐍";
      case "javascript":
        return "🟢";
      default:
        return "📜";
    }
  };

  return (
    <div className="settings-page kb-page scripts-manager-page">
      <div className="kb-layout">
        {/* 左栏：脚本列表 */}
        <div className="kb-list">
          <div className="kb-list-header">
            <div className="kb-header-title">
              <span>自动化脚本</span>
              <span className="kb-count-pill">{scripts.length}</span>
            </div>
            <button
              type="button"
              className="btn-kb-new"
              title="新建自动化脚本"
              onClick={startNewScript}
            >
              ＋ 新建
            </button>
          </div>
          <div className="kb-list-scroll">
            {scripts.length === 0 && !loading && (
              <div className="kb-empty-box">
                <span className="kb-empty-icon">⚡</span>
                <span>暂无脚本</span>
                <small>点击「＋ 新建」配置续期或自动化脚本</small>
              </div>
            )}
            {scripts.map((s) => {
              const isCur = selectedScript?.id === s.id;
              return (
                <div
                  key={s.id}
                  className={"kb-list-item" + (isCur ? " active" : "")}
                  onClick={() => selectScript(s)}
                >
                  <div className="kb-item-head">
                    <span className="kb-item-icon">{typeIcon(s.script_type)}</span>
                    <span className="kb-list-name" title={s.name}>
                      {s.name || "未命名脚本"}
                    </span>
                    {!s.enabled && <span className="script-disabled-badge">已停用</span>}
                  </div>
                  <div className="kb-list-meta">
                    <span className="kb-badge-bind">
                      {s.bound_conn_ids && s.bound_conn_ids.length > 0
                        ? `🔗 ${s.bound_conn_ids.length} 个库`
                        : "未绑定"}
                    </span>
                    {s.trigger_on_error && (
                      <span className="kb-badge-chars" style={{ color: "var(--accent-400)" }}>
                        自愈
                      </span>
                    )}
                    <span className="kb-badge-chars">{s.script_type}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右栏：编辑器与调试区 */}
        <div className="kb-right-container">
          <div className="kb-top-safe-bar">
            <div className="kb-top-safe-title">
              <span>{typeIcon(scriptType)}</span>
              <span>
                {selectedScript
                  ? `编辑脚本 · ${name || selectedScript.name}`
                  : isNew
                  ? "新建自动化脚本"
                  : "自动化脚本与生命周期钩子"}
              </span>
            </div>
            {selectedScript && <span className="kb-top-safe-badge">ID: {selectedScript.id}</span>}
          </div>

          {!selectedScript && !isNew ? (
            <div className="kb-empty-large">
              <div className="kb-empty-hero">
                <div className="kb-empty-hero-icon">⚡</div>
                <h4>数据库自动化脚本与生命周期钩子</h4>
                <p>
                  配置账号续期、跳板机隧道守护或初始化脚本，支持与一个或多个数据库关联。<br />
                  当数据库凭证过期时，系统可自动运行脚本自愈、刷新密码并重试查询。
                </p>
                <button
                  type="button"
                  className="btn btn-primary kb-hero-btn"
                  onClick={startNewScript}
                >
                  ＋ 新建自动化脚本
                </button>
              </div>
            </div>
          ) : (
            <div className="ast-form-container">
              <div className="ast-form-scroll">
                {/* 卡片 1：基础信息 */}
                <div className="ast-section-card">
                  <div className="ast-section-header">
                    <span className="ast-section-title">
                      <span>🏷️</span> 基础信息
                    </span>
                    <label className="script-enable-toggle" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                      />
                      <span>启用此脚本</span>
                    </label>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div>
                      <label style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4, display: "block" }}>
                        脚本名称 <span style={{ color: "var(--danger-500, #ef4444)" }}>*</span>
                      </label>
                      <input
                        className="kb-input"
                        value={name}
                        placeholder="例如：开发环境测试库账号一键续期、堡垒机隧道预热"
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4, display: "block" }}>
                        用途描述与备注
                      </label>
                      <input
                        className="kb-input"
                        value={description}
                        placeholder="说明此脚本的用途或适用平台..."
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* 卡片 2：脚本类型与运行参数 */}
                <div className="ast-section-card">
                  <div className="ast-section-header">
                    <span className="ast-section-title">
                      <span>⚙️</span> 执行环境与类型
                    </span>
                  </div>
                  <div className="script-type-grid">
                    {[
                      { id: "shell", icon: "⚡", label: "Shell 命令行", hint: "系统自带 · 零安装" },
                      { id: "webhook", icon: "🌐", label: "HTTP Webhook", hint: "调接口 · 免环境" },
                      { id: "python", icon: "🐍", label: "Python 3", hint: "本地环境 · 依赖 SDK" },
                      { id: "javascript", icon: "🟢", label: "JavaScript", hint: "本地环境 · Node 运行" },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={"btn-type-pill" + (scriptType === item.id ? " active" : "")}
                        onClick={() => {
                          const nextType = item.id as ScriptType;
                          setScriptType(nextType);
                          if (nextType === "webhook" && (!httpUrl || httpUrl.trim() === "")) {
                            parseWebhookContent(content);
                          }
                        }}
                      >
                        <div className="btn-type-pill-head">
                          <span className="btn-type-pill-icon">{item.icon}</span>
                          <span className="btn-type-pill-title">{item.label}</span>
                          {scriptType === item.id && <span className="btn-type-pill-check">✓</span>}
                        </div>
                        <div className="btn-type-pill-desc">{item.hint}</div>
                      </button>
                    ))}
                  </div>

                  <div className="script-timeout-bar">
                    <div className="script-timeout-label">
                      <span>⏱️ 超时熔断限制:</span>
                      <small>超过此时间未返回将强制中断进程，防止脚本卡死</small>
                    </div>
                    <div className="script-timeout-input-group">
                      <input
                        type="number"
                        className="kb-input"
                        style={{ width: 75, textAlign: "center" }}
                        min={1}
                        max={600}
                        value={timeoutSecs}
                        onChange={(e) => setTimeoutSecs(Math.max(1, parseInt(e.target.value) || 30))}
                      />
                      <span className="script-timeout-unit">秒</span>
                    </div>
                  </div>
                </div>

                {/* 卡片 3：关联数据库 */}
                <div className="ast-section-card">
                  <div className="ast-section-header" style={{ justifyContent: "space-between" }}>
                    <span className="ast-section-title">
                      <span>🔗</span> 关联数据库连接 ({boundConnIds.length}/{allConns.length})
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="btn btn-sm btn-subtle" onClick={selectAllConns}>
                        全选
                      </button>
                      <button type="button" className="btn btn-sm btn-subtle" onClick={clearAllConns}>
                        清空
                      </button>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-dim)", margin: "0 0 10px 0" }}>
                    脚本执行时将自动注入选中连接的主机、端口、用户名等参数；回传新凭证时将自动更新该连接密码。
                  </p>
                  {allConns.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>暂无已配置的数据库连接</div>
                  ) : (
                    <div className="script-conn-chips-grid">
                      {allConns.map((c) => {
                        const checked = boundConnIds.includes(c.id);
                        return (
                          <div
                            key={c.id}
                            className={"script-conn-chip" + (checked ? " checked" : "")}
                            onClick={() => toggleConnBinding(c.id)}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleConnBinding(c.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span className="conn-chip-name">{c.name}</span>
                            <span className="conn-chip-type">({c.db_type})</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 卡片 4：代码与配置编辑（按类型动态自适应） */}
                {scriptType === "webhook" ? (
                  <div className="ast-section-card">
                    <div className="ast-section-header">
                      <span className="ast-section-title">
                        <span>🌐</span> HTTP Webhook 接口配置
                      </span>
                      <span className="ast-section-badge highlight">REST API · 免装环境</span>
                    </div>

                    {/* 1. Integrated URL Bar */}
                    <div>
                      <label style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4, display: "block" }}>
                        请求方式与接口地址 (URL) <span style={{ color: "var(--danger-500, #ef4444)" }}>*</span>
                      </label>
                      <div className="http-url-group">
                        <select
                          className={`http-method-select method-${httpMethod.toLowerCase()}`}
                          value={httpMethod}
                          onChange={(e) => {
                            const m = e.target.value;
                            setHttpMethod(m);
                            if (m === "GET" && webhookSubTab === "body") {
                              setWebhookSubTab("headers");
                            }
                          }}
                        >
                          <option value="POST">POST</option>
                          <option value="GET">GET</option>
                          <option value="PUT">PUT</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                        <input
                          className="http-url-input"
                          value={httpUrl}
                          placeholder="例如：https://iam.internal.company.com/api/db/renew"
                          onChange={(e) => setHttpUrl(e.target.value)}
                        />
                      </div>
                      <div className="http-url-vars-row">
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
                          插入变量:
                        </span>
                        {[
                          { key: "{{CQ_CONN_HOST}}", label: "主机 $HOST" },
                          { key: "{{CQ_CONN_PORT}}", label: "端口 $PORT" },
                          { key: "{{CQ_CONN_USER}}", label: "账号 $USER" },
                          { key: "{{CQ_CONN_DB}}", label: "库名 $DB" },
                        ].map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            className="btn-var-tag"
                            title={`点击向 URL 追加 ${v.key}`}
                            onClick={() => setHttpUrl((prev) => prev + v.key)}
                          >
                            + {v.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 2. Sub-navigation Tabs */}
                    <div className="http-nav-tabs">
                      <button
                        type="button"
                        className={`http-tab-item ${webhookSubTab === "body" ? "active" : ""}`}
                        disabled={httpMethod === "GET"}
                        onClick={() => setWebhookSubTab("body")}
                      >
                        <span>📝 请求体 (Body)</span>
                        {httpMethod === "GET" && (
                          <span style={{ fontSize: 10, opacity: 0.6 }}>(GET 无 Body)</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className={`http-tab-item ${webhookSubTab === "headers" ? "active" : ""}`}
                        onClick={() => setWebhookSubTab("headers")}
                      >
                        <span>📋 请求头 (Headers)</span>
                        <span className="http-tab-badge">
                          {httpHeaders.filter((h) => h.key.trim()).length}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`http-tab-item ${webhookSubTab === "extract" ? "active" : ""}`}
                        onClick={() => setWebhookSubTab("extract")}
                      >
                        <span>🔑 新凭证提取</span>
                        {enableExtract && httpExtractKey.trim() ? (
                          <span
                            className="http-tab-badge"
                            style={{ background: "rgba(56, 189, 248, 0.2)", color: "#38bdf8" }}
                          >
                            已开启 · {httpExtractKey}
                          </span>
                        ) : (
                          <span
                            className="http-tab-badge"
                            style={{ background: "rgba(34, 197, 94, 0.15)", color: "#4ade80" }}
                          >
                            纯续期 (密码不变)
                          </span>
                        )}
                      </button>
                    </div>

                    {/* Sub-tab 1: Body */}
                    {webhookSubTab === "body" && httpMethod !== "GET" && (
                      <div>
                        <div className="http-body-toolbar">
                          <span className="http-pill-tag">Content-Type: application/json</span>
                          <div className="http-body-actions">
                            {["{{CQ_CONN_HOST}}", "{{CQ_CONN_USER}}"].map((v) => (
                              <button
                                key={v}
                                type="button"
                                className="http-chip-btn"
                                onClick={() => setHttpBody((prev) => prev + `"${v}"`)}
                              >
                                + {v}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="http-chip-btn"
                              onClick={handleFormatJson}
                              title="格式化并检查 JSON 语法"
                            >
                              ✨ 格式化 JSON
                            </button>
                            <button
                              type="button"
                              className="http-chip-btn"
                              onClick={() =>
                                setHttpBody('{\n  "host": "{{CQ_CONN_HOST}}",\n  "user": "{{CQ_CONN_USER}}"\n}')
                              }
                            >
                              重置模板
                            </button>
                          </div>
                        </div>
                        <textarea
                          className="script-code-editor"
                          rows={8}
                          value={httpBody}
                          placeholder='{\n  "host": "{{CQ_CONN_HOST}}",\n  "user": "{{CQ_CONN_USER}}"\n}'
                          onChange={(e) => setHttpBody(e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                    )}

                    {/* Sub-tab 2: Headers */}
                    {webhookSubTab === "headers" && (
                      <div className="http-headers-container">
                        <div className="http-headers-head">
                          <span className="http-headers-head-key">参数名 (Key)</span>
                          <span className="http-headers-head-val">参数值 (Value)</span>
                          <span style={{ width: 28 }}></span>
                        </div>
                        <div className="http-headers-table">
                          {httpHeaders.map((h, i) => (
                            <div key={i} className="http-header-row">
                              <input
                                className="kb-input"
                                style={{ width: "38%" }}
                                placeholder="如 Authorization"
                                value={h.key}
                                onChange={(e) => {
                                  const next = [...httpHeaders];
                                  next[i].key = e.target.value;
                                  setHttpHeaders(next);
                                }}
                              />
                              <input
                                className="kb-input"
                                style={{ flex: 1 }}
                                placeholder="如 Bearer YOUR_TOKEN"
                                value={h.value}
                                onChange={(e) => {
                                  const next = [...httpHeaders];
                                  next[i].value = e.target.value;
                                  setHttpHeaders(next);
                                }}
                              />
                              <button
                                type="button"
                                className="http-btn-icon"
                                title="删除此 Header"
                                onClick={() =>
                                  setHttpHeaders(httpHeaders.filter((_, idx) => idx !== i))
                                }
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            flexWrap: "wrap",
                            gap: 8,
                            marginTop: 4,
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-sm btn-subtle"
                            onClick={() => setHttpHeaders([...httpHeaders, { key: "", value: "" }])}
                          >
                            ＋ 添加一行 Header
                          </button>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                              常用快捷添加:
                            </span>
                            <button
                              type="button"
                              className="http-chip-btn"
                              onClick={() => addHeaderPreset("Authorization", "Bearer YOUR_TOKEN")}
                            >
                              + Bearer Token
                            </button>
                            <button
                              type="button"
                              className="http-chip-btn"
                              onClick={() => addHeaderPreset("Content-Type", "application/json")}
                            >
                              + Content-Type: json
                            </button>
                            <button
                              type="button"
                              className="http-chip-btn"
                              onClick={() => addHeaderPreset("X-API-Key", "")}
                            >
                              + X-API-Key
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Sub-tab 3: Credential Extraction (Optional) */}
                    {webhookSubTab === "extract" && (
                      <div className="http-extract-box">
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            gap: 12,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            <span style={{ fontSize: 18, lineHeight: 1 }}>🔑</span>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                                接口返回新临时密码时自动提取并更新 (选填)
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-tertiary)",
                                  marginTop: 2,
                                  lineHeight: 1.45,
                                }}
                              >
                                {enableExtract
                                  ? "当前模式【提取新密码】：接口会返回新生成的临时密码，系统将自动提取并热更新到当前连接配置中。"
                                  : "当前模式【纯续期 · 最常见】：仅调用接口延长有效期，账号密码完全不变。接口响应 2xx 即代表续期成功，系统自动重连。"}
                              </div>
                            </div>
                          </div>

                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              cursor: "pointer",
                              flexShrink: 0,
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: enableExtract ? "var(--brand, #6366f1)" : "var(--text-secondary)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={enableExtract}
                              onChange={(e) => setEnableExtract(e.target.checked)}
                            />
                            <span>需要提取新密码</span>
                          </label>
                        </div>

                        {!enableExtract ? (
                          <div
                            style={{
                              background: "rgba(34, 197, 94, 0.08)",
                              border: "1px solid rgba(34, 197, 94, 0.25)",
                              borderRadius: 6,
                              padding: "12px 14px",
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 10,
                              fontSize: 12,
                              color: "#86efac",
                              lineHeight: 1.45,
                            }}
                          >
                            <span style={{ fontSize: 16 }}>✅</span>
                            <div>
                              <strong>纯接口调用续期（无需提取凭证）</strong>
                              <div
                                style={{
                                  color: "rgba(255, 255, 255, 0.75)",
                                  fontSize: 11.5,
                                  marginTop: 2,
                                }}
                              >
                                适用于大多数企业内网堡垒机/云平台权限系统：仅需向 API 发送请求来顺延访问期限，当前数据库的用户名和密码完全不变。只要 HTTP 响应 2xx，系统即视为续期成功，自动清除旧连接池并重试执行 SQL。
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                            <div>
                              <label
                                style={{
                                  fontSize: 12,
                                  color: "var(--text-dim)",
                                  marginBottom: 4,
                                  display: "block",
                                }}
                              >
                                新密码字段提取路径 (JSONPath):
                              </label>
                              <input
                                className="kb-input"
                                value={httpExtractKey}
                                placeholder="例如：data.new_password 或 password 或 token"
                                onChange={(e) => setHttpExtractKey(e.target.value)}
                              />
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  marginTop: 6,
                                  flexWrap: "wrap",
                                }}
                              >
                                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                                  快速填充常见路径:
                                </span>
                                {["data.new_password", "data.token", "password", "token"].map((p) => (
                                  <button
                                    key={p}
                                    type="button"
                                    className="http-chip-btn"
                                    onClick={() => setHttpExtractKey(p)}
                                  >
                                    {p}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="http-extract-preview">
                              <div style={{ color: "var(--text-tertiary)", marginBottom: 4 }}>
                                // 提取效果示意 (当字段匹配 <code>{httpExtractKey || "data.new_password"}</code>):
                              </div>
                              <div>{"{"}</div>
                              <div>&nbsp;&nbsp;"code": 0,</div>
                              <div>&nbsp;&nbsp;"data": {"{"}</div>
                              <div>
                                &nbsp;&nbsp;&nbsp;&nbsp;"new_password": "
                                <code>NewSecretPassword123!</code>" &nbsp;
                                <span style={{ color: "#4ade80" }}>← 自动写回连接并使用新密码重试</span>
                              </div>
                              <div>&nbsp;&nbsp;{"}"}</div>
                              <div>{"}"}</div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ast-section-card">
                    <div className="ast-section-header">
                      <span className="ast-section-title">
                        <span>{typeIcon(scriptType)}</span>{" "}
                        {scriptType === "shell"
                          ? "Shell 脚本代码 (系统原生 Zsh / Bash / PowerShell)"
                          : scriptType === "python"
                          ? "Python 3 脚本代码"
                          : "JavaScript 脚本代码 (Node)"}
                      </span>
                      <span className="ast-section-badge">
                        {scriptType === "shell" ? "系统命令行" : scriptType.toUpperCase()}
                      </span>
                    </div>

                    <div>
                      <div className="script-var-bar">
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>快捷插入环境变量:</span>
                        {[
                          "$CQ_CONN_HOST",
                          "$CQ_CONN_PORT",
                          "$CQ_CONN_USER",
                          "$CQ_CONN_DB",
                          "$CQ_CONN_NAME",
                          "$CQ_ERROR_MESSAGE",
                        ].map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn-var-tag"
                            title={`点击插入 ${v}`}
                            onClick={() => insertVariable(` "${v}" `)}
                          >
                            {v}
                          </button>
                        ))}
                      </div>
                      <textarea
                        className="script-code-editor"
                        rows={12}
                        value={content}
                        placeholder={
                          scriptType === "python"
                            ? `# Python 脚本内容\nimport os\nprint(f"Connecting to {os.environ.get('CQ_CONN_HOST')}...")\n# 回传新凭证: print('CQ_UPDATE_CONNECTION: {"password": "new_secret"}')`
                            : scriptType === "javascript"
                            ? `// JavaScript 脚本内容\nconsole.log("Renewing for:", process.env.CQ_CONN_USER);\n// 回传新凭证: console.log('CQ_UPDATE_CONNECTION: {"password": "new_secret"}');`
                            : `#!/bin/sh\n# Shell 脚本内容\necho "Renewing account for $CQ_CONN_NAME..."\n# 回传新凭证示例:\n# echo 'CQ_UPDATE_CONNECTION: {"password": "new_secret"}'`
                        }
                        onChange={(e) => setContent(e.target.value)}
                        spellCheck={false}
                      />
                      <div className="script-editor-hint">
                        💡 <strong>动态热更新密码规范</strong>：在脚本中打印 <code>CQ_UPDATE_CONNECTION: {"{\"password\": \"新密码\"}"}</code>，系统将自动写回数据库凭证并重试查询。
                      </div>
                    </div>
                  </div>
                )}

                {/* 卡片 5：自愈与触发规则 */}
                <div className="ast-section-card">
                  <div className="ast-section-header">
                    <span className="ast-section-title">
                      <span>🛡️</span> 错误自愈与触发策略
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={triggerOnError}
                        onChange={(e) => setTriggerOnError(e.target.checked)}
                      />
                      <span>当连接或查询鉴权失败时，触发自愈提醒/自动执行</span>
                    </label>

                    {triggerOnError && (
                      <div style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>
                            触发匹配规则 (正则表达式或关键词):
                          </label>
                          <input
                            className="kb-input"
                            value={errorPattern}
                            placeholder="例如：Access denied|password.*expired|1045"
                            onChange={(e) => setErrorPattern(e.target.value)}
                          />
                        </div>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={autoRetryQuery}
                            onChange={(e) => setAutoRetryQuery(e.target.checked)}
                          />
                          <span>脚本执行成功并获取新密码后，自动重新执行刚才失败的查询</span>
                        </label>
                      </div>
                    )}
                  </div>
                </div>

                {/* 卡片 6：即时调试与运行测试 */}
                <div className="ast-section-card">
                  <div className="ast-section-header">
                    <span className="ast-section-title">
                      <span>🧪</span> 即时测试运行
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      测试注入的目标数据库:
                    </label>
                    <div style={{ flex: "1 1 260px", maxWidth: 360, minWidth: 200 }}>
                      {tree ? (
                        <SimpleGroupedSelect
                          tree={tree}
                          allConns={allConns}
                          value={testConnId}
                          onChange={setTestConnId}
                          placeholder="选择测试注入的目标库…"
                        />
                      ) : (
                        <select
                          className="ast-select-native"
                          value={testConnId}
                          onChange={(e) => setTestConnId(e.target.value)}
                        >
                          <option value="">选择测试注入的目标库…</option>
                          {allConns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} ({c.db_type})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={testing}
                      onClick={handleTestRun}
                    >
                      {testing ? "执行中…" : "▶ 立即测试运行"}
                    </button>
                  </div>

                  {testResult && (
                    <div className="script-terminal-box">
                      <div className="script-terminal-header">
                        <span className={"status-pill " + (testResult.success ? "success" : "failed")}>
                          {testResult.success ? "✓ 成功" : "✗ 失败"}
                        </span>
                        <span>退出码: {testResult.exit_code}</span>
                        <span>耗时: {testResult.duration_ms}ms</span>
                        {testResult.updated_credentials && (
                          <span className="status-pill success" style={{ marginLeft: "auto" }}>
                            ⚡ {testResult.update_message || "已更新数据库密码"}
                          </span>
                        )}
                      </div>
                      <div className="script-terminal-output">
                        {testResult.stdout && (
                          <div className="terminal-stdout">{testResult.stdout}</div>
                        )}
                        {testResult.stderr && (
                          <div className="terminal-stderr">{testResult.stderr}</div>
                        )}
                        {!testResult.stdout && !testResult.stderr && (
                          <div style={{ color: "#666" }}>(标准输出为空)</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 底部保存与删除 */}
                <div className="ast-footer-actions" style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
                  <div>
                    {selectedScript && (
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={handleDelete}
                      >
                        删除脚本
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={saving}
                      onClick={handleSave}
                    >
                      {saving ? "保存中…" : "保存脚本配置"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
