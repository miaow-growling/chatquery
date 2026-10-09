import React, { useState, useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";

export interface MermaidDiagramProps {
  code: string;
  onCopy?: (text: string) => void;
}

interface TransformState {
  scale: number;
  x: number;
  y: number;
}

const DEFAULT_TRANSFORM: TransformState = { scale: 1, x: 0, y: 0 };

/** 嗅探 Mermaid 图表类型名称 */
function getDiagramTitle(code: string): string {
  const trimmed = code.trim();
  if (/^erDiagram\b/i.test(trimmed)) return "ER 实体关系图";
  if (/^(flowchart|graph)\b/i.test(trimmed)) return "流程 / 拓扑图";
  if (/^sequenceDiagram\b/i.test(trimmed)) return "时序图";
  if (/^classDiagram\b/i.test(trimmed)) return "类图";
  if (/^stateDiagram(-v2)?\b/i.test(trimmed)) return "状态机图";
  if (/^mindmap\b/i.test(trimmed)) return "思维导图";
  if (/^timeline\b/i.test(trimmed)) return "时间线图";
  if (/^gantt\b/i.test(trimmed)) return "甘特图";
  if (/^pie\b/i.test(trimmed)) return "饼图";
  return "Mermaid 关系图";
}

/** 语法自愈修复器：修复模型流式打字或中文关系未加引号等易报错语法 */
function sanitizeMermaidCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n").map((line) => {
    // 1. 修复单行内奇数个双引号（流式未输出完或缺少闭合引号）
    const quoteCount = (line.match(/"/g) || []).length;
    let fixedLine = line;
    if (quoteCount % 2 !== 0) {
      fixedLine = line + '"';
    }

    // 2. 修复 ER 图中关系连线后的中文或带空格标签未加双引号
    const relMatch = fixedLine.match(
      /^(\s*\S+\s+(?:\|\||}\||\.\.|\-\-|\|o|\}o|o\{|o\|)[^\:]+\:\s*)([^\"]\S.*)$/
    );
    if (relMatch && !relMatch[2].startsWith('"')) {
      const label = relMatch[2].trim().replace(/^"|"$/g, "");
      fixedLine = `${relMatch[1]}"${label}"`;
    }

    return fixedLine;
  });

  return lines.join("\n");
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, onCopy }) => {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const [copied, setCopied] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // 全屏大图模式下的平移与缩放
  const [fsTransform, setFsTransform] = useState<TransformState>(DEFAULT_TRANSFORM);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const fsViewportRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);

  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const diagramTitle = getDiagramTitle(code);

  const getIsDark = () => {
    return (
      document.documentElement.dataset.theme === "dark" ||
      document.documentElement.classList.contains("dark")
    );
  };

  useEffect(() => {
    let cancelled = false;
    const cleanRaw = code.trim();
    if (!cleanRaw) {
      setSvg("");
      setLoading(false);
      return;
    }

    // 80ms 防抖，兼顾流式响应速度与语法解析稳定性
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      const isDark = getIsDark();
      const uniqueId = `mmd-${rawId}-${Math.random().toString(36).slice(2, 7)}`;

      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          // 彻底屏蔽 Mermaid 向 DOM 注入丑陋的 Syntax error 横幅
          suppressErrorRendering: true,
          theme: isDark ? "dark" : "default",
          fontFamily: "var(--font-mono, ui-monospace, Menlo, Consolas, monospace)",
          themeVariables: isDark
            ? {
                darkMode: true,
                background: "#0f172a",
                primaryColor: "#3b82f6",
                primaryTextColor: "#f1f5f9",
                primaryBorderColor: "#60a5fa",
                lineColor: "#94a3b8",
                secondaryColor: "#1e293b",
                tertiaryColor: "#334155",
              }
            : {
                darkMode: false,
                background: "#ffffff",
                primaryColor: "#2563eb",
                primaryTextColor: "#0f172a",
                primaryBorderColor: "#3b82f6",
                lineColor: "#64748b",
              },
          er: {
            useMaxWidth: true,
          },
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
          },
        });

        // 优先尝试原始代码，若语法不规范则使用自愈代码再次尝试
        let renderedSvg = "";
        try {
          const res = await mermaid.render(uniqueId, cleanRaw);
          renderedSvg = res.svg;
        } catch {
          const healed = sanitizeMermaidCode(cleanRaw);
          const healedId = `mermaid-${rawId}-h-${Math.random().toString(36).slice(2, 7)}`;
          const res = await mermaid.render(healedId, healed);
          renderedSvg = res.svg;
        }

        if (!cancelled && renderedSvg) {
          setSvg(renderedSvg);
          setError(null);
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message || String(err);
          setError(msg);
          setLoading(false);
          setMode("code");
        }
      } finally {
        const strays = document.querySelectorAll(
          "body > svg.error-icon, body > svg:has(.error-text)"
        );
        strays.forEach((el) => el.remove());
      }
    }, 80);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, rawId]);

  // 全屏模式下监听 ESC 退出
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  // 全屏视口鼠标滚轮无级缩放
  useEffect(() => {
    const el = fsViewportRef.current;
    if (!el || !isFullscreen) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.15 : 0.88;
      setFsTransform((prev) => {
        const next = Math.min(Math.max(prev.scale * factor, 0.25), 6.0);
        return { ...prev, scale: parseFloat(next.toFixed(2)) };
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isFullscreen]);

  // 全屏模式下双击缩放：1.0x -> 1.8x -> 2.6x -> 复位 1.0x
  const handleFsDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    setFsTransform((prev) => {
      if (prev.scale < 1.4) {
        return { ...prev, scale: 1.8 };
      } else if (prev.scale < 2.3) {
        return { ...prev, scale: 2.6 };
      } else {
        return DEFAULT_TRANSFORM;
      }
    });
  };

  // 全屏模式鼠标拖拽平移
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: fsTransform.x,
      startY: fsTransform.y,
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const dx = moveEvent.clientX - dragStartRef.current.clientX;
      const dy = moveEvent.clientY - dragStartRef.current.clientY;
      setFsTransform((prev) => ({
        ...prev,
        x: dragStartRef.current!.startX + dx,
        y: dragStartRef.current!.startY + dy,
      }));
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      dragStartRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleCopy = async () => {
    if (onCopy) {
      onCopy(code);
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(code);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleDownloadSvg = () => {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${diagramTitle.replace(/\s+/g, "_")}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openFullscreen = () => {
    setFsTransform(DEFAULT_TRANSFORM);
    setIsFullscreen(true);
  };

  return (
    <div className="mermaid-card-container" ref={containerRef}>
      {/* 卡片头部：简洁优雅、绝不折行 */}
      <div className="mermaid-card-header">
        <div className="mermaid-header-title">
          <span className="mermaid-badge-icon">📊</span>
          <span className="mermaid-badge-name">{diagramTitle}</span>
          {loading && <span className="mermaid-status-hint">渲染中…</span>}
        </div>
        <div className="mermaid-card-actions">
          {mode === "diagram" && svg && (
            <button
              type="button"
              className="mermaid-action-btn fullscreen"
              onClick={openFullscreen}
              title="双击卡片或点击此处全屏查看大图"
            >
              ⤢ 全屏大图
            </button>
          )}

          <div className="mermaid-mode-toggle">
            <button
              type="button"
              className={`mermaid-toggle-btn ${mode === "diagram" ? "active" : ""}`}
              onClick={() => setMode("diagram")}
              title="查看渲染图表"
            >
              图表
            </button>
            <button
              type="button"
              className={`mermaid-toggle-btn ${mode === "code" ? "active" : ""}`}
              onClick={() => setMode("code")}
              title="查看图表代码"
            >
              源码
            </button>
          </div>

          <button
            type="button"
            className="mermaid-action-btn"
            onClick={handleCopy}
            title="复制代码"
          >
            {copied ? "✓ 已复制" : "复制代码"}
          </button>
        </div>
      </div>

      {/* 卡片主体：双击直接全屏，避免小卡片内拖拽复杂易错 */}
      <div className="mermaid-card-body">
        {mode === "diagram" ? (
          <div
            className="mermaid-diagram-wrap"
            onDoubleClick={openFullscreen}
            title="双击直接全屏查看大图"
          >
            {loading && !svg && (
              <div className="mermaid-placeholder loading">
                <span className="mermaid-spin" /> 正在渲染关系图表…
              </div>
            )}
            {error ? (
              <div className="mermaid-placeholder error">
                <div className="mermaid-error-title">💡 图表内容正在生成或语法暂未闭合</div>
                <div className="mermaid-error-detail">已自动切换至源码模式，完整输出后即可恢复图表展示</div>
              </div>
            ) : svg ? (
              <div
                className="mermaid-svg-render"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : null}

            {svg && (
              <div
                className="mermaid-interaction-hint"
                onClick={openFullscreen}
                title="点击直接全屏大图"
              >
                🔍 双击直接全屏大图 · 支持画板缩放平移
              </div>
            )}
          </div>
        ) : (
          <div className="mermaid-code-wrap">
            {error && (
              <div className="mermaid-syntax-warning">
                💡 语法提示：模型输出的语句语法可能尚未闭合，您可直接查看或复制代码。
              </div>
            )}
            <pre className="mermaid-code-pre">
              <code>{code}</code>
            </pre>
          </div>
        )}
      </div>

      {/* 全屏大图灯箱预览（全屏后再支持缩放、拖拽与平移） */}
      {isFullscreen &&
        createPortal(
          <div className="mermaid-fs-overlay" onClick={() => setIsFullscreen(false)}>
            <div className="mermaid-fs-container" onClick={(e) => e.stopPropagation()}>
              <div className="mermaid-fs-header">
                <div className="mermaid-fs-title">
                  <span className="mermaid-badge-icon">📊</span>
                  <span className="mermaid-fs-main-title">{diagramTitle}</span>
                  <span className="mermaid-fs-subtitle">大图画板模式</span>
                </div>
                <div className="mermaid-fs-actions">
                  <div className="mermaid-zoom-toolbar">
                    <button
                      type="button"
                      className="mermaid-tool-btn"
                      title="缩小"
                      onClick={() =>
                        setFsTransform((p) => ({
                          ...p,
                          scale: Math.max(parseFloat((p.scale - 0.25).toFixed(2)), 0.3),
                        }))
                      }
                    >
                      -
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn scale-val"
                      title="点击重置为 100%"
                      onClick={() => setFsTransform(DEFAULT_TRANSFORM)}
                    >
                      {Math.round(fsTransform.scale * 100)}%
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn"
                      title="放大"
                      onClick={() =>
                        setFsTransform((p) => ({
                          ...p,
                          scale: Math.min(parseFloat((p.scale + 0.25).toFixed(2)), 5.0),
                        }))
                      }
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn reset"
                      title="一键居中复位"
                      onClick={() => setFsTransform(DEFAULT_TRANSFORM)}
                    >
                      ↺
                    </button>
                  </div>
                  <button
                    type="button"
                    className="mermaid-action-btn"
                    onClick={handleDownloadSvg}
                    title="下载为 SVG 矢量图"
                  >
                    ⬇ 导出 SVG
                  </button>
                  <button
                    type="button"
                    className="mermaid-action-btn"
                    onClick={handleCopy}
                    title="复制 Mermaid 源码"
                  >
                    {copied ? "✓ 已复制" : "复制源码"}
                  </button>
                  <button
                    type="button"
                    className="mermaid-fs-close-btn"
                    onClick={() => setIsFullscreen(false)}
                    title="退出全屏 (ESC)"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div
                className={`mermaid-fs-viewport ${isDragging ? "is-dragging" : ""}`}
                ref={fsViewportRef}
                onDoubleClick={handleFsDoubleClick}
                onMouseDown={handleMouseDown}
                title="鼠标滚轮缩放 · 拖拽平移画布 · 双击放大"
              >
                <div
                  className="mermaid-canvas-plane"
                  style={{
                    transform: `translate(${fsTransform.x}px, ${fsTransform.y}px) scale(${fsTransform.scale})`,
                    transformOrigin: "center center",
                  }}
                >
                  <div
                    className="mermaid-svg-render fs-render"
                    dangerouslySetInnerHTML={{ __html: svg }}
                  />
                </div>
              </div>

              <div className="mermaid-fs-footer">
                <span>💡 鼠标滚轮自由缩放 · 拖拽自由平移 · 双击放大/复位 · 按 ESC 退出全屏</span>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
