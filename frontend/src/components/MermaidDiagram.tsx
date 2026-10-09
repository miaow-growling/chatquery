import React, { useState, useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";

export interface MermaidDiagramProps {
  code: string;
  onCopy?: (text: string) => void;
}

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

/** 从 SVG 字符串中解析出原生 viewBox 宽高，用于高清矢量尺寸缩放计算 */
function parseViewBox(svgStr: string): { width: number; height: number } {
  const m = svgStr.match(/viewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/);
  if (m) {
    const w = parseFloat(m[3]);
    const h = parseFloat(m[4]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  return { width: 1200, height: 800 };
}

// 全局 SVG 渲染缓存：相同图表只渲染一次，杜绝外部弹窗（如数据库记忆管理）打开导致重新渲染
const svgCache = new Map<string, string>();
let renderQueue = Promise.resolve();

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, onCopy }) => {
  const cleanInitial = code.trim();
  const [svg, setSvg] = useState<string>(() => svgCache.get(cleanInitial) || "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !svgCache.has(cleanInitial));
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const [copied, setCopied] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // 全屏大图模式下的缩放比例与平移坐标
  const [fsScale, setFsScale] = useState<number>(1);
  const [fsPos, setFsPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isAnimating, setIsAnimating] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const fsViewportRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  // 拖拽手势高性能引用，避免 mousemove 过程中触发高频 React 重渲染
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);
  const currentPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafIdRef = useRef<number | null>(null);

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

    // 若已经有缓存，直接同步载入缓存，不重复执行任何 Mermaid 渲染
    if (svgCache.has(cleanRaw)) {
      setSvg(svgCache.get(cleanRaw)!);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    // 60ms 防抖 + 串行任务队列，确保多个图表有序渲染，避免并发插入 DOM 造成测量错乱
    const timer = setTimeout(() => {
      renderQueue = renderQueue.then(async () => {
        if (cancelled) return;
        if (svgCache.has(cleanRaw)) {
          setSvg(svgCache.get(cleanRaw)!);
          setLoading(false);
          return;
        }

        const isDark = getIsDark();
        const uniqueId = `mmd-${rawId}-${Math.random().toString(36).slice(2, 7)}`;

        try {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            // 彻底屏蔽 Mermaid 向 DOM 注入错误横幅
            suppressErrorRendering: true,
            theme: isDark ? "dark" : "default",
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
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
            const healedId = `mmd-${rawId}-h-${Math.random().toString(36).slice(2, 7)}`;
            const res = await mermaid.render(healedId, healed);
            renderedSvg = res.svg;
          }

          if (renderedSvg) {
            svgCache.set(cleanRaw, renderedSvg);
            if (!cancelled) {
              setSvg(renderedSvg);
              setError(null);
              setLoading(false);
            }
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
      });
    }, 60);

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

  // 触发平滑过渡动画（仅在点击按钮或双击等离散缩放事件中触发，拖拽时保持0延迟无动画）
  const triggerSmoothAnimate = () => {
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 220);
  };

  // 全屏视口鼠标滚轮无级缩放
  useEffect(() => {
    const el = fsViewportRef.current;
    if (!el || !isFullscreen) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.15 : 0.88;
      setFsScale((prev) => {
        const next = Math.min(Math.max(prev * factor, 0.2), 6.0);
        return parseFloat(next.toFixed(2));
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isFullscreen]);

  // 全屏模式下双击多级放大与复位
  const handleFsDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    triggerSmoothAnimate();
    setFsScale((prev) => {
      if (prev < 1.2) return 1.8;
      if (prev < 2.3) return 2.8;
      return 1.0;
    });
  };

  // 全屏模式高性能鼠标拖拽平移（使用 requestAnimationFrame + 直连 DOM translate3d，杜绝重渲染闪烁）
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: fsPos.x,
      startY: fsPos.y,
    };
    currentPosRef.current = { x: fsPos.x, y: fsPos.y };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const dx = moveEvent.clientX - dragStartRef.current.clientX;
      const dy = moveEvent.clientY - dragStartRef.current.clientY;
      const nextX = dragStartRef.current.startX + dx;
      const nextY = dragStartRef.current.startY + dy;
      currentPosRef.current = { x: nextX, y: nextY };

      // 使用硬件垂直同步 RAF 帧驱动，跳过 React 虚拟 DOM 开销，杜绝拖拽卡顿抖动
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          if (planeRef.current) {
            planeRef.current.style.transform = `translate3d(${currentPosRef.current.x}px, ${currentPosRef.current.y}px, 0)`;
          }
          rafIdRef.current = null;
        });
      }
    };

    const onMouseUp = () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      isDraggingRef.current = false;
      setIsDragging(false);
      dragStartRef.current = null;
      // 拖拽结束时将最终坐标同步回 React 状态持久化
      setFsPos(currentPosRef.current);
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
    // 智能自适应屏幕视口大小，初始尺寸优雅铺满视口
    const vb = parseViewBox(svg);
    const winW = window.innerWidth * 0.86;
    const winH = window.innerHeight * 0.78;
    const fitScale = Math.min(winW / vb.width, winH / vb.height, 1.25);
    const initialScale = Math.max(parseFloat(fitScale.toFixed(2)), 0.35);

    setFsScale(initialScale);
    setFsPos({ x: 0, y: 0 });
    currentPosRef.current = { x: 0, y: 0 };
    setIsFullscreen(true);
  };

  // 解析并计算全屏模式下的原生 SVG 矢量尺寸（从根源解决文字模糊与位图拉伸）
  const vb = parseViewBox(svg);
  const scaledWidth = Math.round(vb.width * fsScale);
  const scaledHeight = Math.round(vb.height * fsScale);

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

      {/* 全屏大图灯箱预览（纯矢量尺寸缩放 + RAF 无抖动平移） */}
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
                      onClick={() => {
                        triggerSmoothAnimate();
                        setFsScale((p) => Math.max(parseFloat((p - 0.25).toFixed(2)), 0.2));
                      }}
                    >
                      -
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn scale-val"
                      title="点击重置为 100%"
                      onClick={() => {
                        triggerSmoothAnimate();
                        setFsScale(1.0);
                        setFsPos({ x: 0, y: 0 });
                        currentPosRef.current = { x: 0, y: 0 };
                      }}
                    >
                      {Math.round(fsScale * 100)}%
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn"
                      title="放大"
                      onClick={() => {
                        triggerSmoothAnimate();
                        setFsScale((p) => Math.min(parseFloat((p + 0.25).toFixed(2)), 6.0));
                      }}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="mermaid-tool-btn reset"
                      title="一键居中复位"
                      onClick={() => {
                        triggerSmoothAnimate();
                        openFullscreen();
                      }}
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
                  className={`mermaid-canvas-plane ${isAnimating ? "is-animated" : ""}`}
                  ref={planeRef}
                  style={{
                    transform: `translate3d(${fsPos.x}px, ${fsPos.y}px, 0)`,
                  }}
                >
                  <div
                    className="mermaid-svg-render fs-render"
                    style={{
                      width: `${scaledWidth}px`,
                      height: `${scaledHeight}px`,
                    }}
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
