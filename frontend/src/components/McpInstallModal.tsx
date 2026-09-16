import React, { useState, useEffect } from "react";
import { api } from "../api";
import type { McpInstallInfo } from "../types";

export interface McpInstallModalProps {
  open: boolean;
  onClose: () => void;
}

export const McpInstallModal: React.FC<McpInstallModalProps> = ({ open, onClose }) => {
  const [activeTab, setActiveTab] = useState<"claude" | "cursor" | "generic">("claude");
  const [info, setInfo] = useState<McpInstallInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .getMcpInstallInfo()
      .then((res) => {
        setInfo(res);
      })
      .catch((err) => {
        console.error("加载 MCP 安装配置失败:", err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const currentJson =
    activeTab === "claude"
      ? info?.claude_json || ""
      : activeTab === "cursor"
      ? info?.cursor_json || ""
      : info?.claude_json || "";

  const configPath =
    activeTab === "claude"
      ? info?.claude_config_path || ""
      : activeTab === "cursor"
      ? info?.cursor_config_path || ""
      : "客户端 settings.json 或 mcpServers 配置段";

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => {
      setCopied(null);
    }, 2000);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal wide db-memory-modal"
        style={{ maxWidth: "680px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="mem-modal-head">
          <div className="mem-modal-title-wrap">
            <div className="mem-modal-title-row">
              <span className="mem-modal-icon">🔌</span>
              <h3 className="mem-modal-title">MCP</h3>
              <span className="mem-count-badge" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981" }}>
                原生引擎就绪
              </span>
            </div>
            <div className="mem-modal-desc">
              将智询挂载为标准 Model Context Protocol (MCP) 服务，使 Claude Desktop、Cursor、Cline 拥有本地数据库感知、知识库与纠错记忆能力
            </div>
          </div>
          <button
            type="button"
            className="mem-modal-close-btn"
            onClick={onClose}
            title="关闭 (ESC)"
          >
            ×
          </button>
        </div>

        {/* Modal Content */}
        <div className="settings-page" style={{ padding: "20px 24px" }}>
          {/* Platform Tab Switcher */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
            <button
              type="button"
              className={"btn " + (activeTab === "claude" ? "btn-primary" : "btn-secondary")}
              style={{ fontSize: "13px", height: "32px", padding: "0 16px" }}
              onClick={() => setActiveTab("claude")}
            >
              Claude Desktop
            </button>
            <button
              type="button"
              className={"btn " + (activeTab === "cursor" ? "btn-primary" : "btn-secondary")}
              style={{ fontSize: "13px", height: "32px", padding: "0 16px" }}
              onClick={() => setActiveTab("cursor")}
            >
              Cursor 编辑器
            </button>
            <button
              type="button"
              className={"btn " + (activeTab === "generic" ? "btn-primary" : "btn-secondary")}
              style={{ fontSize: "13px", height: "32px", padding: "0 16px" }}
              onClick={() => setActiveTab("generic")}
            >
              通用 / Cline / Windsurf
            </button>
          </div>

          {/* Config Path Indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--bg-card)",
              border: "1px solid var(--border-color)",
              borderRadius: "6px",
              padding: "8px 12px",
              marginBottom: "12px",
              fontSize: "12px",
            }}
          >
            <span style={{ color: "var(--text-secondary)" }}>
              <strong style={{ color: "var(--text-primary)" }}>配置文件路径：</strong>
              <code>{configPath}</code>
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: "11px", height: "24px", padding: "0 8px" }}
              onClick={() => handleCopy(configPath, "path")}
            >
              {copied === "path" ? "✓ 已复制" : "复制路径"}
            </button>
          </div>

          {/* JSON Preview Box */}
          <div style={{ position: "relative", marginBottom: "16px" }}>
            <pre
              style={{
                background: "var(--bg-app)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "14px 16px",
                fontSize: "12px",
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-primary)",
                overflowX: "auto",
                margin: 0,
                lineHeight: "1.6",
              }}
            >
              {loading ? "正在解析本机可用程序路径…" : currentJson}
            </pre>
            <button
              type="button"
              className="btn btn-primary"
              style={{
                position: "absolute",
                top: "10px",
                right: "10px",
                fontSize: "12px",
                height: "28px",
                padding: "0 12px",
                boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
              }}
              onClick={() => handleCopy(currentJson, "json")}
            >
              {copied === "json" ? "✓ 已复制到剪贴板！" : "📋 一键复制配置 JSON"}
            </button>
          </div>

          {/* Setup Guide */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border-color)",
              borderRadius: "8px",
              padding: "12px 16px",
              fontSize: "12px",
              color: "var(--text-secondary)",
              lineHeight: "1.8",
              marginBottom: "16px",
            }}
          >
            <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>
              💡 快速安装说明：
            </div>
            <div>
              1. 打开上述配置文件（若文件或 <code>mcpServers</code> 字段已存在，将 <code>chatquery</code> 段并入即可）；
            </div>
            <div>
              2. 粘贴上方复制的配置 JSON 并保存文件；
            </div>
            <div>
              3. 完全重启外部 Agent（或点击客户端 MCP 面板的“Reload”），即可自动识别所有 <code>cq_*</code> 数据库探查与记忆工具。
            </div>
          </div>

          {/* Executable Diagnosis & Safety Banner */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              background: "rgba(59, 130, 246, 0.08)",
              border: "1px solid rgba(59, 130, 246, 0.2)",
              borderRadius: "6px",
              padding: "10px 14px",
              fontSize: "12px",
              color: "var(--text-secondary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ color: "#3b82f6" }}>✓</span>
              <span>
                <strong>可用程序路径：</strong>
                <code>{info?.executable_path || "正在定位…"}</code>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ color: "#10b981" }}>✓</span>
              <span>
                <strong>安全门禁：</strong>已启用纯只读防护模式（禁止任何增删改与 DDL 操作，强制前置阅读记忆与知识库）
              </span>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="modal-actions" style={{ padding: "12px 24px 16px" }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ height: "32px", padding: "0 20px" }}
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
