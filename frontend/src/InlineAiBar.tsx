import React, { useState, useEffect, useRef } from "react";

interface Props {
  visible: boolean;
  selectedSql?: string;
  dbName?: string | null;
  isGenerating: boolean;
  isThinking?: boolean;
  hasGenerated: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => Promise<void>;
  onAccept: () => void;
  onReject: () => void;
}

export function InlineAiBar({
  visible,
  selectedSql,
  dbName,
  isGenerating,
  isThinking,
  hasGenerated,
  onClose,
  onSubmit,
  onAccept,
  onReject,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (visible) {
      setPrompt("");
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [visible]);

  if (!visible) return null;

  const isRewrite = !!selectedSql && selectedSql.trim().length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (hasGenerated) {
        onReject();
      } else {
        onClose();
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (hasGenerated && !isGenerating) {
        onAccept();
      } else if (prompt.trim() && !isGenerating) {
        void onSubmit(prompt.trim());
      }
    }
  };

  return (
    <div className="inline-ai-overlay">
      <div className="inline-ai-bar">
        <div className="inline-ai-head">
          <span className="inline-ai-icon">✨</span>
          <span className="inline-ai-mode">
            {isRewrite ? "改写选中 SQL" : "原地生成 SQL"}
          </span>
          {dbName && (
            <span className="inline-ai-db-pill" title={`目标数据库：${dbName}`}>
              ▦ {dbName}
            </span>
          )}
          {isRewrite && (
            <span className="inline-ai-sel-hint" title={selectedSql}>
              已选 {selectedSql!.trim().split("\n").length} 行代码
            </span>
          )}
        </div>

        <div className="inline-ai-body">
          <input
            ref={inputRef}
            type="text"
            className="inline-ai-input"
            disabled={isGenerating}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isRewrite
                ? "描述如何改写（例如：加上分页 LIMIT 20 并按时间倒序）…"
                : "输入自然语言需求（例如：统计各个部门本月订单量均值）…"
            }
          />

          <div className="inline-ai-actions">
            {isGenerating ? (
              <span className="inline-ai-status generating">
                <span className="pulse-dot" />{" "}
                {isThinking ? "✨ AI 正在深度推理思考…" : "⚡ 正在流式生成 SQL…"}
              </span>
            ) : hasGenerated ? (
              <>
                <button
                  type="button"
                  className="inline-ai-btn accept"
                  onClick={onAccept}
                  title="采纳本次生成的 SQL (Enter)"
                >
                  ✓ 采纳 (Enter)
                </button>
                <button
                  type="button"
                  className="inline-ai-btn reject"
                  onClick={onReject}
                  title="撤销并恢复原内容 (Esc)"
                >
                  ↩ 撤销 (Esc)
                </button>
              </>
            ) : (
              <button
                type="button"
                className="inline-ai-btn submit"
                disabled={!prompt.trim()}
                onClick={() => {
                  if (prompt.trim()) void onSubmit(prompt.trim());
                }}
                title="开始生成 (Enter)"
              >
                生成 ↵
              </button>
            )}

            <button
              type="button"
              className="inline-ai-close"
              onClick={() => {
                if (hasGenerated) onReject();
                else onClose();
              }}
              title="关闭 (Esc)"
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
