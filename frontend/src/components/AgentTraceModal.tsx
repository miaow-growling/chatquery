import { useState, useEffect, useMemo, useRef } from "react";
import { getAgentTraces, clearAgentTraces } from "../api";
import type { TurnTraceDto, ConversationSummary } from "../types";

interface AgentTraceModalProps {
  onClose: () => void;
  activeConvId?: string | null;
  conversations?: ConversationSummary[];
}

type NodeKind = "trace" | "planning" | "generation" | "tool" | "synthesizer";

interface TraceTreeNode {
  id: string;
  kind: NodeKind;
  label: string;
  subtitle?: string;
  role?: string;
  model?: string;
  startOffsetMs: number;
  costMs: number;
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  connection?: string | null;
  queryPreview?: string | null;
  summary?: string | null;
  argsHash?: number;
  resultLen?: number;
  guarded?: string | null;
  inputContent?: string;
  outputContent?: string;
  rawJson: unknown;
  depth: number;
}

interface DropdownOption {
  value: string;
  label: string;
  count?: number;
  isCurrent?: boolean;
}

function formatTraceTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  if (diffSec < 86400) return `${hours}:${mins}`;
  const month = d.getMonth() + 1;
  const date = d.getDate();
  return `${month}/${date} ${hours}:${mins}`;
}

function TraceConvDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (val: string) => void;
}) {
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
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const selectedOpt = options.find((o) => o.value === value) || options[0];

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  return (
    <div className="trace-custom-dropdown" ref={containerRef}>
      <button
        type="button"
        className={`trace-dropdown-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="trace-dropdown-trigger-left">
          {selectedOpt?.value === "all" ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--brand, #6366f1)" }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-secondary)" }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          )}
          <span className="trace-dropdown-label">{selectedOpt?.label || "全部会话"}</span>
        </div>
        {selectedOpt && selectedOpt.count !== undefined && (
          <span className="trace-dropdown-badge">{selectedOpt.count} 轮</span>
        )}
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`trace-dropdown-arrow ${open ? "open" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="trace-dropdown-menu">
          {options.length > 5 && (
            <div className="trace-dropdown-search-wrap">
              <input
                type="text"
                placeholder="快速检索会话..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                className="trace-dropdown-search-input"
              />
            </div>
          )}
          <div className="trace-dropdown-list">
            {filteredOptions.length === 0 ? (
              <div className="trace-dropdown-empty">无匹配会话</div>
            ) : (
              filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    className={`trace-dropdown-item ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <div className="trace-dropdown-item-main">
                      {opt.value === "all" ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--brand, #6366f1)" }}>
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-tertiary)" }}>
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                      )}
                      <span className="trace-dropdown-item-title">{opt.label}</span>
                      {opt.isCurrent && (
                        <span className="trace-dropdown-current-tag">当前</span>
                      )}
                    </div>
                    {opt.count !== undefined && (
                      <span className={`trace-dropdown-count-tag ${opt.count > 0 ? "has-data" : ""}`}>
                        {opt.count} 轮
                      </span>
                    )}
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--brand, #6366f1)", marginLeft: "4px" }}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
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

export function AgentTraceModal({
  onClose,
  activeConvId,
  conversations = [],
}: AgentTraceModalProps) {
  const [traces, setTraces] = useState<TurnTraceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedConvFilter, setSelectedConvFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("root");
  const [inspectorTab, setInspectorTab] = useState<"details" | "input" | "output" | "json">("details");
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 会话 ID -> 会话标题快速映射
  const convTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      map.set(c.id, c.title || "未命名会话");
    }
    return map;
  }, [conversations]);

  // 统计每个会话下的 Trace 数量
  const convTraceCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of traces) {
      if (t.conv_id) {
        map.set(t.conv_id, (map.get(t.conv_id) || 0) + 1);
      }
    }
    return map;
  }, [traces]);

  // 构建下拉选项
  const convDropdownOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = [
      {
        value: "all",
        label: "全部历史会话",
        count: traces.length,
      },
    ];
    if (activeConvId) {
      opts.push({
        value: "current",
        label: convTitleMap.get(activeConvId) || "当前会话",
        count: convTraceCountMap.get(activeConvId) || 0,
        isCurrent: true,
      });
    }
    for (const c of conversations) {
      if (c.id === activeConvId) continue;
      opts.push({
        value: c.id,
        label: c.title || c.id.slice(0, 8),
        count: convTraceCountMap.get(c.id) || 0,
      });
    }
    return opts;
  }, [traces.length, activeConvId, convTitleMap, convTraceCountMap, conversations]);

  // 加载 Trace 数据
  const loadTraces = async () => {
    setLoading(true);
    try {
      const list = await getAgentTraces();
      setTraces(list);

      // 智能默认选择：如果 activeConvId 存在且有数据，聚焦它；否则展示全部（"all"）
      if (activeConvId && list.some((t) => t.conv_id === activeConvId)) {
        setSelectedConvFilter(activeConvId);
        const firstInConv = list.find((t) => t.conv_id === activeConvId);
        if (firstInConv) setSelectedTurnId(firstInConv.turn_id);
      } else {
        setSelectedConvFilter("all");
        if (list.length > 0) {
          setSelectedTurnId(list[0].turn_id);
        }
      }
    } catch (e) {
      setMsg("加载链路数据失败: " + String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTraces();
  }, []);

  // ESC 键关闭弹窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // 过滤后的 Trace 列表
  const filteredTraces = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return traces.filter((t) => {
      // 1. 会话过滤
      if (selectedConvFilter === "current") {
        if (t.conv_id !== activeConvId) return false;
      } else if (selectedConvFilter !== "all") {
        if (t.conv_id !== selectedConvFilter) return false;
      }

      // 2. 状态过滤
      if (statusFilter === "completed" && t.terminate !== "completed") return false;
      if (statusFilter === "issue") {
        const isNormal = t.terminate === "completed" && (!t.redundant_calls || t.redundant_calls.length === 0);
        if (isNormal) return false;
      }
      if (statusFilter === "redundant" && (!t.redundant_calls || t.redundant_calls.length === 0)) return false;
      if (statusFilter === "guarded" && !t.steps.some((s) => !!s.guarded)) return false;

      // 3. 关键字搜索（按 Turn ID、用户提问、会话标题、工具名或连接名过滤）
      if (q) {
        const convTitle = t.conv_id ? (convTitleMap.get(t.conv_id) || "").toLowerCase() : "";
        const userQ = (t.user_query || "").toLowerCase();
        const matchesTurnId = t.turn_id.toLowerCase().includes(q);
        const matchesConv = convTitle.includes(q);
        const matchesUserQ = userQ.includes(q);
        const matchesSteps = t.steps.some(
          (s) =>
            s.tool.toLowerCase().includes(q) ||
            (s.query_preview && s.query_preview.toLowerCase().includes(q)) ||
            (s.connection && s.connection.toLowerCase().includes(q))
        );
        if (!matchesTurnId && !matchesConv && !matchesUserQ && !matchesSteps) return false;
      }

      return true;
    });
  }, [traces, selectedConvFilter, statusFilter, searchTerm, activeConvId, convTitleMap]);

  // 选中的 Trace 详情
  const currentTrace = useMemo(() => {
    if (!selectedTurnId) return filteredTraces[0] || null;
    return traces.find((t) => t.turn_id === selectedTurnId) || filteredTraces[0] || null;
  }, [traces, selectedTurnId, filteredTraces]);

  // 当选中的 Trace 变更时，默认重置选中根节点
  useEffect(() => {
    setSelectedNodeId("root");
  }, [selectedTurnId]);

  // 将选中的 Turn 构建为 Langfuse 规范的树状时序节点（Trace Tree Nodes）
  const treeNodes = useMemo<TraceTreeNode[]>(() => {
    if (!currentTrace) return [];
    const list: TraceTreeNode[] = [];
    const totalMs = currentTrace.total_ms || 1;

    // 1. Root Trace Node (用户提问与全流程)
    list.push({
      id: "root",
      kind: "trace",
      label: currentTrace.user_query ? `提问: "${currentTrace.user_query}"` : "用户请求交互",
      subtitle: `${currentTrace.steps.length} 步工具调用 · ${currentTrace.llm_rounds} 轮模型往返`,
      role: currentTrace.role,
      startOffsetMs: 0,
      costMs: totalMs,
      inputContent: currentTrace.user_query || "(空)",
      outputContent: `终态: ${currentTrace.terminate} · 消耗 Tokens: ${currentTrace.usage?.total_tokens || 0}`,
      rawJson: currentTrace,
      depth: 0,
    });

    const subNodes: TraceTreeNode[] = [];

    // 2. 如果记录了具体的 LLM Generations（新版本格式）
    if (currentTrace.generations && currentTrace.generations.length > 0) {
      currentTrace.generations.forEach((gen, idx) => {
        subNodes.push({
          id: `gen-${idx + 1}`,
          kind: "generation",
          label: gen.name,
          subtitle: `${gen.model}${gen.usage ? ` · ${gen.usage.total_tokens.toLocaleString()} tok` : ""}`,
          role: "LLM",
          model: gen.model,
          startOffsetMs: gen.start_offset_ms,
          costMs: gen.cost_ms,
          tokens: gen.usage?.total_tokens,
          promptTokens: gen.usage?.prompt_tokens,
          completionTokens: gen.usage?.completion_tokens,
          inputContent: gen.input_preview || "(无提示词记录)",
          outputContent: gen.output_preview || "(空返回)",
          rawJson: gen,
          depth: 1,
        });
      });
    } else {
      // 降级兼容：若没有 generations 记录，用虚拟节点兜底
      if (currentTrace.plan && currentTrace.plan.length > 0) {
        const planCost = currentTrace.planning_cost_ms || Math.min(2500, Math.floor(totalMs * 0.15));
        subNodes.push({
          id: "planning",
          kind: "planning",
          label: `Task Planning (任务规划阶段)`,
          subtitle: `生成了 ${currentTrace.plan.length} 个执行步骤`,
          role: "Planner",
          startOffsetMs: 50,
          costMs: planCost,
          inputContent: currentTrace.user_query || "",
          outputContent: currentTrace.plan.map((p, i) => `${i + 1}. ${p}`).join("\n"),
          rawJson: { plan: currentTrace.plan, cost_ms: planCost },
          depth: 1,
        });
      }
      if (currentTrace.steps.length > 0) {
        const synCost = currentTrace.synthesis_cost_ms || Math.min(4000, Math.floor(totalMs * 0.2));
        const synStart = Math.max(0, totalMs - synCost);
        subNodes.push({
          id: "synthesizer",
          kind: "synthesizer",
          label: `Synthesizer (综合结论生成)`,
          subtitle: "Orchestrator 汇总各步骤产出，输出最终回答",
          role: "Orchestrator",
          startOffsetMs: synStart,
          costMs: synCost,
          inputContent: "综合以上所有步骤的执行结果...",
          outputContent: "面向结论的综合回答输出",
          rawJson: { synthesis_cost_ms: synCost },
          depth: 1,
        });
      }
    }

    // 3. Tool Execution Steps
    currentTrace.steps.forEach((step, idx) => {
      const offset =
        step.start_offset_ms !== undefined && step.start_offset_ms > 0
          ? step.start_offset_ms
          : Math.floor((idx / Math.max(1, currentTrace.steps.length)) * totalMs * 0.85);

      subNodes.push({
        id: `step-${step.iter}`,
        kind: "tool",
        label: `${step.tool}${step.connection ? ` · ${step.connection}` : ""}`,
        subtitle: step.summary || (step.query_preview ? step.query_preview.slice(0, 80) : `第 ${step.iter} 步调用`),
        role: step.role || "Worker",
        startOffsetMs: offset,
        costMs: step.cost_ms,
        connection: step.connection,
        queryPreview: step.query_preview,
        summary: step.summary,
        argsHash: step.args_hash,
        resultLen: step.result_len,
        guarded: step.guarded,
        inputContent: step.query_preview || `Tool Arguments Hash: 0x${step.args_hash.toString(16)}`,
        outputContent: step.summary ? `${step.summary} (${step.result_len} 字符)` : `${step.result_len} 字符返回`,
        rawJson: step,
        depth: 2,
      });
    });

    // 4. 按真实发生的时间偏移量(startOffsetMs)升序排序，实现 LLM 与 Tool 真实时序交替排列！
    subNodes.sort((a, b) => a.startOffsetMs - b.startOffsetMs);

    list.push(...subNodes);
    return list;
  }, [currentTrace]);

  // 当前在 Inspector 中聚焦检查的节点
  const activeNode = useMemo(() => {
    return treeNodes.find((n) => n.id === selectedNodeId) || treeNodes[0] || null;
  }, [treeNodes, selectedNodeId]);

  // 计算耗时拆解：工具纯耗时 vs 模型思考生成耗时
  const timingBreakdown = useMemo(() => {
    if (!currentTrace) return { toolCost: 0, llmCost: 0, toolPercent: 0, llmPercent: 0 };
    const toolCost = currentTrace.steps.reduce((acc, s) => acc + s.cost_ms, 0);
    const totalMs = currentTrace.total_ms || 1;
    const llmCost = Math.max(0, totalMs - toolCost);
    const toolPercent = Math.min(100, Math.round((toolCost / totalMs) * 100));
    const llmPercent = Math.max(0, 100 - toolPercent);
    return { toolCost, llmCost, toolPercent, llmPercent };
  }, [currentTrace]);

  const handleClear = async () => {
    if (!window.confirm("确定要清空本地所有记录的链路排障日志吗？")) return;
    try {
      await clearAgentTraces();
      setTraces([]);
      setSelectedTurnId(null);
      setMsg("链路日志已清空");
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg("清空失败: " + String(e));
    }
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(label);
      setTimeout(() => setCopiedText(null), 2000);
    } catch (e) {
      console.warn("复制失败", e);
    }
  };

  const getTerminateBadge = (term: string) => {
    switch (term) {
      case "completed":
        return <span className="trace-tag tag-success">● completed</span>;
      case "timeout":
        return <span className="trace-tag tag-danger">⏱ timeout</span>;
      case "tool-budget-exhausted":
        return <span className="trace-tag tag-warning">⚡ budget-exhausted</span>;
      case "cancelled":
        return <span className="trace-tag tag-muted">⏹ cancelled</span>;
      case "errored":
        return <span className="trace-tag tag-danger">❌ error</span>;
      default:
        return <span className="trace-tag">{term}</span>;
    }
  };

  const getNodeKindPill = (kind: NodeKind) => {
    switch (kind) {
      case "trace":
        return <span className="langfuse-kind-pill trace">TRACE</span>;
      case "planning":
        return <span className="langfuse-kind-pill span">PLAN</span>;
      case "tool":
        return <span className="langfuse-kind-pill tool">TOOL</span>;
      case "synthesizer":
        return <span className="langfuse-kind-pill generation">GEN</span>;
    }
  };

  return (
    <div className="agent-trace-mask" onClick={onClose}>
      <div className="agent-trace-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Langfuse Top Bar: Breadcrumb + Status Metrics + Actions */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elevated, var(--bg-surface))",
            gap: "16px",
            flexWrap: "wrap",
          }}
        >
          {/* Breadcrumb & Trace ID */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            <span style={{ fontSize: "16px" }}>⚡</span>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              <span>Traces</span>
              <span style={{ color: "var(--text-tertiary)" }}>/</span>
              <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--brand, #6366f1)" }}>
                {currentTrace ? currentTrace.turn_id : "No Trace"}
              </span>
            </div>
            {currentTrace && getTerminateBadge(currentTrace.terminate)}
          </div>

          {/* Quick Metrics Bar */}
          {currentTrace && (
            <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "var(--text-secondary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <span style={{ color: "var(--text-tertiary)" }}>Latency:</span>
                <b style={{ color: currentTrace.total_ms > 5000 ? "#ef4444" : "var(--text-primary)" }}>
                  {(currentTrace.total_ms / 1000).toFixed(2)}s
                </b>
              </div>
              <span>•</span>
              <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <span style={{ color: "var(--text-tertiary)" }}>Tokens:</span>
                <b>{currentTrace.usage ? currentTrace.usage.total_tokens.toLocaleString() : "—"}</b>
              </div>
              <span>•</span>
              <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <span style={{ color: "var(--text-tertiary)" }}>Steps:</span>
                <b>{currentTrace.steps.length} tools</b>
              </div>
            </div>
          )}

          {/* Top Actions */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void loadTraces()}
              title="刷新最新链路"
              style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              🔄 刷新
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void handleClear()}
              title="清空日志"
              style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
            >
              🗑️ 清空
            </button>
            <button
              className="btn-icon"
              onClick={onClose}
              style={{ fontSize: "16px", width: "28px", height: "28px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              title="关闭 (ESC)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filters Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            padding: "8px 20px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            fontSize: "12px",
            flexWrap: "wrap",
          }}
        >
          {/* 会话切换 */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}>Session:</span>
            <TraceConvDropdown
              value={selectedConvFilter}
              options={convDropdownOptions}
              onChange={(val) => setSelectedConvFilter(val)}
            />
          </div>

          {/* 状态胶囊 */}
          <div className="trace-segmented-group">
            <button
              type="button"
              className={`trace-segmented-item ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={`trace-segmented-item ${statusFilter === "completed" ? "active" : ""}`}
              onClick={() => setStatusFilter("completed")}
            >
              Success
            </button>
            <button
              type="button"
              className={`trace-segmented-item ${statusFilter === "issue" ? "active" : ""}`}
              onClick={() => setStatusFilter("issue")}
            >
              Issues
            </button>
            <button
              type="button"
              className={`trace-segmented-item ${statusFilter === "redundant" ? "active" : ""}`}
              onClick={() => setStatusFilter("redundant")}
            >
              ⚠️ Redundant
            </button>
            <button
              type="button"
              className={`trace-segmented-item ${statusFilter === "guarded" ? "active" : ""}`}
              onClick={() => setStatusFilter("guarded")}
            >
              🛡️ Guarded
            </button>
          </div>

          {/* 搜索 */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
            <input
              type="text"
              placeholder="Filter by Query / SQL / Tool..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: "210px",
                height: "28px",
                padding: "0 10px",
                fontSize: "11.5px",
                borderRadius: "5px",
                border: "1px solid var(--border)",
                background: "var(--bg-elevated, var(--bg-inset))",
                color: "var(--text-primary)",
                outline: "none",
              }}
            />
          </div>

          {msg && (
            <span style={{ color: "var(--brand, #6366f1)", fontSize: "11px", fontWeight: 500 }}>
              {msg}
            </span>
          )}
        </div>

        {/* Main Body: 3-Pane / Split-Pane Layout */}
        <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
          {/* Pane 1: Turn Session List (Leftmost, 240px) */}
          <div
            style={{
              width: "250px",
              borderRight: "1px solid var(--border)",
              overflowY: "auto",
              background: "var(--bg-surface)",
              flexShrink: 0,
            }}
          >
            <div style={{ padding: "8px 12px", fontSize: "11px", fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Runs ({filteredTraces.length})
            </div>
            {loading ? (
              <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "12px" }}>
                加载中…
              </div>
            ) : filteredTraces.length === 0 ? (
              <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "12px" }}>
                暂无记录
              </div>
            ) : (
              filteredTraces.map((t) => {
                const isSelected = t.turn_id === selectedTurnId;
                const timeStr = formatTraceTime(t.created_at);
                const title = t.user_query || convTitleMap.get(t.conv_id || "") || t.turn_id;

                return (
                  <div
                    key={t.turn_id}
                    onClick={() => setSelectedTurnId(t.turn_id)}
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid var(--border-soft)",
                      cursor: "pointer",
                      background: isSelected ? "var(--bg-subtle, rgba(99, 102, 241, 0.08))" : "transparent",
                      borderLeft: isSelected ? "3px solid var(--brand, #6366f1)" : "3px solid transparent",
                    }}
                  >
                    <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "4px" }} title={title}>
                      {title}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11px", color: "var(--text-tertiary)" }}>
                      <span>{(t.total_ms / 1000).toFixed(1)}s · {t.steps.length} tools</span>
                      <span>{timeStr}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Pane 2: Langfuse Trace Tree & Gantt Waterfall Timeline (Middle, 420px~450px) */}
          <div
            style={{
              flex: "1 1 420px",
              minWidth: "380px",
              borderRight: "1px solid var(--border)",
              overflowY: "auto",
              padding: "16px 20px",
              background: "var(--bg-surface)",
            }}
          >
            {/* Tree Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
              <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Trace Tree & Waterfall
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Total: <b>{currentTrace ? (currentTrace.total_ms / 1000).toFixed(2) : 0}s</b>
              </div>
            </div>

            {/* Tree Nodes List */}
            {treeNodes.length === 0 ? (
              <div style={{ padding: "40px", textAlign: "center", color: "var(--text-tertiary)" }}>
                选择左侧运行以加载调用树
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {treeNodes.map((node) => {
                  const isSelected = node.id === selectedNodeId;
                  const totalMs = currentTrace?.total_ms || 1;
                  const leftPercent = Math.min(95, Math.max(0, (node.startOffsetMs / totalMs) * 100));
                  const widthPercent = Math.min(100 - leftPercent, Math.max(3, (node.costMs / totalMs) * 100));

                  return (
                    <div
                      key={node.id}
                      className={`langfuse-node-row ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedNodeId(node.id)}
                      style={{
                        paddingLeft: `${10 + node.depth * 18}px`,
                      }}
                    >
                      {/* Kind Badge */}
                      {getNodeKindPill(node.kind)}

                      {/* Node Label & Subtitle */}
                      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: "2px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {node.label}
                          </span>
                          {node.guarded && (
                            <span className="trace-tag tag-purple" style={{ fontSize: "9.5px", padding: "0 4px" }}>
                              {node.guarded}
                            </span>
                          )}
                        </div>
                        {node.subtitle && (
                          <span style={{ fontSize: "10.5px", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {node.subtitle}
                          </span>
                        )}
                      </div>

                      {/* Gantt Timeline Bar */}
                      <div className="langfuse-gantt-rail" title={`耗时: ${node.costMs}ms`}>
                        <div
                          className={`langfuse-gantt-bar ${node.kind} ${node.costMs > 3000 ? "danger" : node.costMs > 800 ? "warning" : ""}`}
                          style={{
                            left: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                          }}
                        />
                      </div>

                      {/* Duration Text */}
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)", minWidth: "48px", textAlign: "right", fontFamily: "var(--font-mono, monospace)" }}>
                        {node.costMs < 1000 ? `${node.costMs}ms` : `${(node.costMs / 1000).toFixed(1)}s`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pane 3: Langfuse Inspector Detail Pane (Rightmost, ~50%) */}
          <div
            style={{
              flex: "1 1 500px",
              minWidth: "380px",
              display: "flex",
              flexDirection: "column",
              background: "var(--bg-inset, var(--bg-surface))",
              overflow: "hidden",
            }}
          >
            {activeNode ? (
              <>
                {/* Inspector Header Tabs */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0 16px",
                    borderBottom: "1px solid var(--border)",
                    background: "var(--bg-elevated, var(--bg-surface))",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center" }}>
                    <button
                      type="button"
                      className={`langfuse-tab-btn ${inspectorTab === "details" ? "active" : ""}`}
                      onClick={() => setInspectorTab("details")}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      className={`langfuse-tab-btn ${inspectorTab === "input" ? "active" : ""}`}
                      onClick={() => setInspectorTab("input")}
                    >
                      Input / Query
                    </button>
                    <button
                      type="button"
                      className={`langfuse-tab-btn ${inspectorTab === "output" ? "active" : ""}`}
                      onClick={() => setInspectorTab("output")}
                    >
                      Output
                    </button>
                    <button
                      type="button"
                      className={`langfuse-tab-btn ${inspectorTab === "json" ? "active" : ""}`}
                      onClick={() => setInspectorTab("json")}
                    >
                      Raw JSON
                    </button>
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                    ID: <code>{activeNode.id}</code>
                  </div>
                </div>

                {/* Inspector Tab Content Area */}
                <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
                  {inspectorTab === "details" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                      {/* Metric Snapshot */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
                        <div className="trace-card" style={{ padding: "10px 14px" }}>
                          <div className="trace-card-label">Latency</div>
                          <div className="trace-card-val" style={{ fontSize: "16px" }}>
                            {activeNode.costMs} <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>ms</span>
                          </div>
                        </div>
                        <div className="trace-card" style={{ padding: "10px 14px" }}>
                          <div className="trace-card-label">Node Type</div>
                          <div className="trace-card-val" style={{ fontSize: "14px" }}>
                            {getNodeKindPill(activeNode.kind)}
                          </div>
                        </div>
                        <div className="trace-card" style={{ padding: "10px 14px" }}>
                          <div className="trace-card-label">Start Offset</div>
                          <div className="trace-card-val" style={{ fontSize: "16px" }}>
                            +{(activeNode.startOffsetMs / 1000).toFixed(2)} <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>s</span>
                          </div>
                        </div>
                      </div>

                      {/* Redundant alert for turn */}
                      {activeNode.id === "root" && currentTrace?.redundant_calls && currentTrace.redundant_calls.length > 0 && (
                        <div style={{ background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.25)", borderRadius: "6px", padding: "10px 14px", fontSize: "12px", color: "#ef4444" }}>
                          <b>⚠️ 原地打转预警：</b> 本轮检测到多次完全相同参数的重复工具调用。
                        </div>
                      )}

                      {/* Property Table */}
                      <div style={{ background: "var(--bg-elevated, var(--bg-surface))", border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" }}>
                        <table className="langfuse-prop-table">
                          <tbody>
                            <tr>
                              <td className="langfuse-prop-label">Label:</td>
                              <td className="langfuse-prop-value">{activeNode.label}</td>
                            </tr>
                            <tr>
                              <td className="langfuse-prop-label">Role:</td>
                              <td className="langfuse-prop-value">{activeNode.role || "Orchestrator"}</td>
                            </tr>
                            {activeNode.model && (
                              <tr>
                                <td className="langfuse-prop-label">Model:</td>
                                <td className="langfuse-prop-value" style={{ color: "var(--brand, #6366f1)", fontWeight: 600 }}>
                                  {activeNode.model}
                                </td>
                              </tr>
                            )}
                            {activeNode.tokens !== undefined && (
                              <tr>
                                <td className="langfuse-prop-label">Tokens Usage:</td>
                                <td className="langfuse-prop-value">
                                  <b>{activeNode.tokens.toLocaleString()}</b> tokens
                                  {activeNode.promptTokens !== undefined && (
                                    <span style={{ fontSize: "11px", color: "var(--text-tertiary)", marginLeft: "6px" }}>
                                      (prompt: {activeNode.promptTokens.toLocaleString()}, completion: {activeNode.completionTokens?.toLocaleString() || 0})
                                    </span>
                                  )}
                                </td>
                              </tr>
                            )}
                            {activeNode.connection && (
                              <tr>
                                <td className="langfuse-prop-label">Connection:</td>
                                <td className="langfuse-prop-value">{activeNode.connection}</td>
                              </tr>
                            )}
                            {activeNode.argsHash !== undefined && (
                              <tr>
                                <td className="langfuse-prop-label">Args Hash:</td>
                                <td className="langfuse-prop-value">0x{activeNode.argsHash.toString(16)}</td>
                              </tr>
                            )}
                            {activeNode.guarded && (
                              <tr>
                                <td className="langfuse-prop-label">Safety Guard:</td>
                                <td className="langfuse-prop-value">
                                  <span className="trace-tag tag-purple">{activeNode.guarded}</span>
                                </td>
                              </tr>
                            )}
                            {activeNode.resultLen !== undefined && (
                              <tr>
                                <td className="langfuse-prop-label">Output Length:</td>
                                <td className="langfuse-prop-value">{activeNode.resultLen} chars</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* 耗时分布总览条 (如果是根节点) */}
                      {activeNode.id === "root" && (
                        <div style={{ background: "var(--bg-elevated, var(--bg-surface))", border: "1px solid var(--border)", borderRadius: "8px", padding: "12px 16px" }}>
                          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px" }}>
                            ⏱️ 耗时拆解 (Latency Breakdown)
                          </div>
                          <div className="trace-time-breakdown-bar">
                            <div className="trace-time-segment-tools" style={{ width: `${timingBreakdown.toolPercent}%` }} />
                            <div className="trace-time-segment-llm" style={{ width: `${timingBreakdown.llmPercent}%` }} />
                          </div>
                          <div style={{ display: "flex", gap: "16px", marginTop: "8px", fontSize: "11px" }}>
                            <span style={{ color: "var(--text-secondary)" }}>
                              🛠️ 工具执行: <b>{(timingBreakdown.toolCost / 1000).toFixed(2)}s</b> ({timingBreakdown.toolPercent}%)
                            </span>
                            <span style={{ color: "var(--text-secondary)" }}>
                              🧠 大模型推理生成: <b>{(timingBreakdown.llmCost / 1000).toFixed(2)}s</b> ({timingBreakdown.llmPercent}%)
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {inspectorTab === "input" && (
                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
                          {activeNode.kind === "tool" ? "Input Query / Arguments" : "Prompt Input"}
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ height: "24px", fontSize: "11px" }}
                          onClick={() => void handleCopy(activeNode.inputContent || "", "input")}
                        >
                          {copiedText === "input" ? "✓ 已复制" : "复制内容"}
                        </button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          flex: 1,
                          padding: "12px 14px",
                          background: "var(--bg-inset, #080a12)",
                          border: "1px solid var(--border)",
                          borderRadius: "6px",
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "12px",
                          lineHeight: 1.5,
                          color: "var(--text-primary)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          overflowY: "auto",
                        }}
                      >
                        {activeNode.inputContent || "(无输入内容)"}
                      </pre>
                    </div>
                  )}

                  {inspectorTab === "output" && (
                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
                          Output Response
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ height: "24px", fontSize: "11px" }}
                          onClick={() => void handleCopy(activeNode.outputContent || "", "output")}
                        >
                          {copiedText === "output" ? "✓ 已复制" : "复制输出"}
                        </button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          flex: 1,
                          padding: "12px 14px",
                          background: "var(--bg-inset, #080a12)",
                          border: "1px solid var(--border)",
                          borderRadius: "6px",
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "12px",
                          lineHeight: 1.5,
                          color: "var(--text-primary)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          overflowY: "auto",
                        }}
                      >
                        {activeNode.outputContent || "(无输出内容)"}
                      </pre>
                    </div>
                  )}

                  {inspectorTab === "json" && (
                    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
                          Node Raw JSON
                        </span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ height: "24px", fontSize: "11px" }}
                          onClick={() => void handleCopy(JSON.stringify(activeNode.rawJson, null, 2), "json")}
                        >
                          {copiedText === "json" ? "✓ 已复制" : "复制 JSON"}
                        </button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          flex: 1,
                          padding: "12px 14px",
                          background: "var(--bg-inset, #080a12)",
                          border: "1px solid var(--border)",
                          borderRadius: "6px",
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: "11.5px",
                          lineHeight: 1.5,
                          color: "#38bdf8",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          overflowY: "auto",
                        }}
                      >
                        {JSON.stringify(activeNode.rawJson, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: "60px", textAlign: "center", color: "var(--text-tertiary)" }}>
                选择左侧时序树上的节点以检查详情
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "8px 20px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-elevated, var(--bg-surface))",
            fontSize: "11px",
            color: "var(--text-tertiary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>
            本地数据落盘路径：<code>~/Library/Logs/com.chatquery.app/agent-trace.jsonl</code>
          </span>
          <span>嵌入式轻量级 Langfuse 架构 · 本地单机离线分析</span>
        </div>
      </div>
    </div>
  );
}
