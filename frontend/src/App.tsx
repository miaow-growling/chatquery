import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import React, { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  api,
  cancelTurn,
  chatTurn,
  onChatConfirm,
  onChatDone,
  onChatError,
  onChatPlan,
  onChatToken,
  onChatTool,
  onChatUsage,
  resolveConfirm,
} from "./api";
import type {
  AuditRow,
  ChatItem,
  ChatMessage,
  ConfirmRequest,
  ConnInput,
  ConnSummary,
  ConversationSummary,
  ConvRefCard,
  DataAssistant,
  DataAssistantInput,
  ExplainNode,
  ExplainVisual,
  ForeignKeyInfo,
  KbBindingDto,
  KbDocDto,
  KeyStatus,
  LlmConfigDto,
  VendorProfileDto,
  NewChatMessage,
  ChatDbBinding,
  QueryItem,
  QueryOutput,
  RedisValueView,
  SqlReference,
  StatusInfo,
  StoredChatMessage,
  TableStructure,
  TokenUsage,
  TreeModel,
  VendorPreset,
} from "./types";
import { createEditor, splitStatements, type EditorHandle } from "./editor-cm6";
// Redis 面板只在连接 Redis 实例时才需要，懒加载避免 MySQL 用户为它付出解析/内存成本。
const RedisBrowser = lazy(() =>
  import("./RedisBrowser").then((m) => ({ default: m.RedisBrowser }))
);
import { ContextMenu, useAutoMenuPosition, type MenuItem } from "./ContextMenu";
import { Tree } from "./Tree";
import { Icon } from "./components/ui";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InlineAiBar } from "./InlineAiBar";
import { DataAssistantEditor } from "./components/DataAssistantEditor";

/** 表格右键菜单自适应容器（具有视口边缘碰撞检测，自动翻转防止菜单底部被遮挡截断） */
function TableContextMenuContainer({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
}) {
  const { pos, ref } = useAutoMenuPosition(x, y);
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
    >
      {children}
    </div>
  );
}

/** 复制图标（内联 SVG，避免引入图标库）。 */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/** 导入到编辑器图标（内联 SVG：进入文档/编辑器）。 */
function ImportSqlIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <polyline points="12 9 16 13 12 17" />
    </svg>
  );
}

function NewTabIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function RunCodeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

/** 从 React 子树里抽纯文本，用来喂剪贴板（避开 react-markdown 传进来的
 *  <code> 元素层级）。递归处理字符串、数字、数组、React 元素。 */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** AI 消息里的代码块：在右上角支持复制代码、新Tab打开、直接运行与一键导入到查询。
 *  用 useMemo 缓存一次，codeText 在 children 引用变化时才重算。 */
function CodeBlock({
  children,
  onImport,
  onOpenNewTab,
  onExecute,
}: {
  children?: React.ReactNode;
  onImport?: (code: string) => void;
  onOpenNewTab?: (code: string) => void;
  /** 提供 = 该代码块可一键执行（结果展示在结果区） */
  onExecute?: (code: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [imported, setImported] = useState(false);
  const [openedTab, setOpenedTab] = useState(false);
  const [execState, setExecState] = useState<"idle" | "running" | "done" | "dismissed">("idle");
  const codeText = useMemo(() => nodeText(children).replace(/\n$/, ""), [children]);
  const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(codeText);
  const canExecute = !!onExecute;
  const lineCount = useMemo(() => codeText.split("\n").length, [codeText]);
  const isLong = lineCount > 6 || codeText.length > 220;
  const [collapsed, setCollapsed] = useState(isLong);

  return (
    <div className={"md-code" + (collapsed ? " collapsed" : "")}>
      <div className="md-code-actions">
        {isLong && (
          <button
            type="button"
            className="md-code-btn md-code-toggle"
            title={collapsed ? "展开完整 SQL" : "收起 SQL"}
            aria-label={collapsed ? "展开完整 SQL" : "收起 SQL"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? "▾ 展开" : "▴ 收起"}
          </button>
        )}
        {canExecute && (
          <button
            type="button"
            className={"md-code-btn md-code-run" + (execState === "running" ? " running" : execState === "done" ? " done" : "")}
            title="直接运行这条 SQL（结果展示在下方结果区）"
            aria-label="直接运行"
            disabled={execState === "running"}
            onClick={async () => {
              setExecState("running");
              try {
                await onExecute!(codeText);
                setExecState("done");
                setTimeout(() => setExecState("idle"), 2000);
              } catch {
                setExecState("idle");
              }
            }}
          >
            {execState === "running" ? "…" : execState === "done" ? "✓" : <RunCodeIcon />}
          </button>
        )}
        {onOpenNewTab && (
          <button
            type="button"
            className={"md-code-btn md-code-newtab" + (openedTab ? " opened" : "")}
            title="在新标签页打开（不覆盖当前草稿）"
            aria-label="在新标签页打开"
            onClick={() => {
              onOpenNewTab(codeText);
              setOpenedTab(true);
              setTimeout(() => setOpenedTab(false), 1500);
            }}
          >
            {openedTab ? "✓" : <NewTabIcon />}
          </button>
        )}
        {onImport && (
          <button
            type="button"
            className={"md-code-btn md-code-import" + (imported ? " imported" : "")}
            title="导入到当前查询"
            aria-label="导入到当前查询"
            onClick={() => {
              onImport(codeText);
              setImported(true);
              setTimeout(() => setImported(false), 1500);
            }}
          >
            {imported ? "✓" : <ImportSqlIcon />}
          </button>
        )}
        <button
          type="button"
          className={"md-code-btn md-code-copy" + (copied ? " copied" : "")}
          title="复制代码"
          aria-label="复制代码"
          onClick={async () => {
            const ok = await copyText(codeText);
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? "✓" : <CopyIcon />}
        </button>
      </div>
      {canExecute && isWrite && execState !== "dismissed" && (
        <div className="md-code-exec">
          {execState === "done" ? (
            <span className="md-code-exec-done">✓ 已执行，结果见下方 toast</span>
          ) : (
            <>
              <button
                type="button"
                className="md-code-exec-btn exec"
                disabled={execState === "running"}
                title="在绑定的连接/库上执行这条 SQL（写操作仍会走确认弹窗）"
                onClick={async () => {
                  setExecState("running");
                  try {
                    await onExecute!(codeText);
                    setExecState("done");
                  } catch {
                    setExecState("idle");
                  }
                }}
              >
                {execState === "running" ? "执行中…" : "▶ 执行"}
              </button>
              <button
                type="button"
                className="md-code-exec-btn dismiss"
                title="不执行这条 SQL"
                onClick={() => setExecState("dismissed")}
              >
                不执行
              </button>
            </>
          )}
        </div>
      )}
      <pre>{children}</pre>
      {collapsed && isLong && (
        <div className="md-code-expand-bar" onClick={() => setCollapsed(false)} title="点击展开完整 SQL">
          <span className="md-code-expand-btn">
            ▾ 展开完整 SQL（共 {lineCount} 行，{codeText.length.toLocaleString()} 字符）
          </span>
        </div>
      )}
      {!collapsed && isLong && (
        <div className="md-code-collapse-bar">
          <span className="md-code-collapse-btn" onClick={() => setCollapsed(true)}>
            ▴ 收起 SQL
          </span>
        </div>
      )}
    </div>
  );
}

/** 解析消息中的 <think>...</think> 深度思考内容（支持多段 think 与流式未闭合） */
interface ParsedMessage {
  thinking: string | null;
  isThinking: boolean;
  content: string;
}

function splitThinkContent(raw: string): ParsedMessage {
  if (!raw) return { thinking: null, isThinking: false, content: "" };

  const startTagRegex = /<\s*think\s*>/gi;
  const endTagRegex = /<\s*\/\s*think\s*>/gi;

  const thinkParts: string[] = [];
  const contentParts: string[] = [];
  let isThinking = false;

  let pos = 0;
  const len = raw.length;

  while (pos < len) {
    // 寻找下一个 <think>
    startTagRegex.lastIndex = pos;
    const startMatch = startTagRegex.exec(raw);

    if (!startMatch) {
      // 后面没有 <think> 了，全部归入正文
      contentParts.push(raw.slice(pos));
      break;
    }

    // <think> 之前的部分归入正文
    if (startMatch.index > pos) {
      contentParts.push(raw.slice(pos, startMatch.index));
    }

    const thoughtStart = startMatch.index + startMatch[0].length;

    // 寻找配对的 </think>
    endTagRegex.lastIndex = thoughtStart;
    const endMatch = endTagRegex.exec(raw);

    if (endMatch) {
      // 已完整闭合的 <think>...</think>
      const thought = raw.slice(thoughtStart, endMatch.index).trim();
      if (thought) {
        thinkParts.push(thought);
      }
      pos = endMatch.index + endMatch[0].length;
    } else {
      // 未闭合的 <think>（流式输出中）
      const thought = raw.slice(thoughtStart).trim();
      if (thought) {
        thinkParts.push(thought);
      }
      isThinking = true;
      pos = len;
      break;
    }
  }

  const thinking = thinkParts.length > 0 ? thinkParts.join("\n\n---\n\n") : null;
  const content = contentParts
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/<\s*\/?\s*think\s*>/gi, "")
    .trim();

  return { thinking, isThinking, content };
}

/** 思考过程可折叠组件 */
function ThinkingBlock({ text, isThinking }: { text: string; isThinking: boolean }) {
  const [open, setOpen] = useState<boolean>(isThinking);

  useEffect(() => {
    if (isThinking) setOpen(true);
  }, [isThinking]);

  return (
    <div className={`thinking-container ${isThinking ? "is-thinking" : ""}`}>
      <details
        className="thinking-details"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="thinking-summary">
          <span className="thinking-icon">{isThinking ? "💭" : "💡"}</span>
          <span className="thinking-title">
            {isThinking ? "思考中…" : "思考过程"}
          </span>
          <span className="thinking-hint">{open ? "收起" : "展开"}</span>
        </summary>
        <div className="thinking-content">
          <pre className="thinking-text">{text}</pre>
        </div>
      </details>
    </div>
  );
}

/** 执行步骤与工具调用折叠组件（类似思考过程，可一键展开/收起完整步骤与所有 SQL） */
function ExecutionBlock({
  plan,
  tools,
  isRunning,
  onImportSql,
  onOpenNewTab,
}: {
  plan?: string[];
  tools?: string[];
  isRunning: boolean;
  onImportSql?: (sql: string) => void;
  onOpenNewTab?: (sql: string) => void;
}) {
  const hasPlan = !!(plan && plan.length > 0);
  const hasTools = !!(tools && tools.length > 0);
  if (!hasPlan && !hasTools) return null;

  // 运行中默认展开让用户看到实时进展；运行完成后默认折叠保持界面整洁
  const [open, setOpen] = useState<boolean>(isRunning);

  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning]);

  // 统计实际执行了多少次 SQL
  const sqlCount = useMemo(() => {
    if (!tools) return 0;
    return tools.filter((t) => t.startsWith("execute_query")).length;
  }, [tools]);

  // 获取最新的进行中文案
  const latestStatus = useMemo(() => {
    if (!tools || tools.length === 0) {
      if (hasPlan) return "已制定执行计划，正在准备执行…";
      return "";
    }
    const last = tools[tools.length - 1];
    return last;
  }, [tools, hasPlan]);

  return (
    <div className={`execution-container ${isRunning ? "is-running" : ""}`}>
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="execution-summary">
          <span className="execution-icon">{isRunning ? "⏳" : "⚡"}</span>
          <span className="execution-title">
            {isRunning ? "正在执行步骤" : "执行步骤"}
            {hasPlan && <span className="execution-badge plan">{plan!.length} 步计划</span>}
            {sqlCount > 0 && <span className="execution-badge sql">{sqlCount} 次查询</span>}
          </span>
          {isRunning && !open && (
            <span className="execution-live-hint">{latestStatus}</span>
          )}
          <span className="execution-toggle">{open ? "收起" : "展开"}</span>
        </summary>
        <div className="execution-content">
          {hasPlan && (
            <div className="execution-plan-section">
              <div className="execution-section-title">📋 任务执行计划</div>
              <ol className="execution-plan-list">
                {plan!.map((step, idx) => (
                  <li key={idx}>{step}</li>
                ))}
              </ol>
            </div>
          )}
          {hasTools && (
            <div className="execution-tools-section">
              {hasPlan && <div className="execution-section-title">🛠️ 实际执行与工具调用</div>}
              <div className="execution-tools-list">
                {tools!.map((toolContent, idx) => (
                  <ToolCallCard
                    key={idx}
                    content={toolContent}
                    onImportSql={onImportSql}
                    onOpenNewTab={onOpenNewTab}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/** 修复模型输出里"粘行"的代码围栏。CommonMark 要求闭合围栏独占一行；部分模型
 *  会把结尾 ``` 直接接在最后一行内容后面（如 `WHERE x = 'y'```，中间无换行），
 *  导致围栏永远不闭合，后续的 `---`、说明文字全部被吞进同一个代码块。
 *  处理：内容行尾出现 3+ 个反引号时拆成独立闭合行；流结束时围栏未闭合则补上。
 *  只影响渲染，不改原始消息内容。SQL 里合法的反引号标识符（1~2 个）不会误伤。 */
function repairCodeFences(src: string): string {
  if (!src.includes("`")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLen = 3;
  let fenceChar = "`";
  for (const line of lines) {
    if (!inFence) {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) {
        inFence = true;
        fenceChar = open[1][0];
        fenceLen = open[1].length;
      }
      out.push(line);
      continue;
    }
    // 围栏内：独占一行的闭合围栏
    if (/^\s*(`{3,}|~{3,})\s*$/.test(line)) {
      inFence = false;
      out.push(line);
      continue;
    }
    // 粘在内容行尾的闭合围栏（仅反引号围栏；运行长度 ≥ 开头围栏才拆分）
    if (fenceChar === "`") {
      const glued = line.match(/^(.+[^\s`])\s*(`{3,})\s*$/);
      if (glued && glued[2].length >= fenceLen) {
        out.push(glued[1]);
        out.push(glued[2]);
        inFence = false;
        continue;
      }
    }
    out.push(line);
  }
  if (inFence) out.push(fenceChar.repeat(fenceLen));
  return out.join("\n");
}

/** 工具调用卡片：如果是 execute_query「<SQL>」→ <SUMMARY> 则渲染为可展开查看完整 SQL 的卡片，
 *  带复制和导入编辑器按钮；其他工具提示（如“正在执行步骤...”）以轻量胶囊显示。 */
function ToolCallCard({
  content,
  onImportSql,
  onOpenNewTab,
}: {
  content: string;
  onImportSql?: (sql: string) => void;
  onOpenNewTab?: (sql: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // 解析 execute_query「<SQL>」→ <SUMMARY>
  const match = /^execute_query「([\s\S]+?)」→\s*(.*)$/.exec(content);
  if (!match) {
    return (
      <div className="chat-tool-chip" title={content}>
        <span className="chat-tool-icon">⚡</span>
        <span className="chat-tool-text">{content}</span>
      </div>
    );
  }

  const sql = match[1].trim();
  const summary = match[2].trim();
  const previewSql = sql.replace(/\s+/g, " ");

  return (
    <div className={"chat-tool-card" + (expanded ? " expanded" : "")}>
      <div
        className="chat-tool-head"
        onClick={() => setExpanded(!expanded)}
        title="点击展开 / 收起完整 SQL"
      >
        <span className="chat-tool-icon">⚡</span>
        <span className="chat-tool-tag">SQL</span>
        <span className="chat-tool-sql-preview" title={previewSql}>
          {previewSql}
        </span>
        <span className="chat-tool-sep">→</span>
        <span className="chat-tool-summary">{summary}</span>
        <span className="chat-tool-toggle">{expanded ? "▴" : "▾"}</span>
      </div>
      {expanded && (
        <div className="chat-tool-detail">
          <div className="chat-tool-actions">
            {onOpenNewTab && (
              <button
                type="button"
                className="tool-act-btn"
                onClick={() => onOpenNewTab(sql)}
                title="在新标签页打开此 SQL"
              >
                新 Tab 打开
              </button>
            )}
            {onImportSql && (
              <button
                type="button"
                className="tool-act-btn"
                onClick={() => onImportSql(sql)}
                title="导入此 SQL 到查询编辑器"
              >
                导入编辑器
              </button>
            )}
            <button
              type="button"
              className="tool-act-btn"
              onClick={async () => {
                const ok = await copyText(sql);
                if (ok) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? "已复制" : "复制 SQL"}
            </button>
          </div>
          <pre className="chat-tool-sql-full">{sql}</pre>
        </div>
      )}
    </div>
  );
}

/** 渲染 AI 消息内容为 Markdown：标题/加粗/列表/代码块/表格/链接等。
 *  用 react-markdown + remark-gfm，默认不 dangerouslySetInnerHTML，XSS 安全。 */
function MarkdownMessage({
  content,
  onImportSql,
  onOpenNewTab,
  onExecuteSql,
}: {
  content: string;
  onImportSql?: (sql: string) => void;
  onOpenNewTab?: (sql: string) => void;
  /** 提供 = AI 回复里的 SQL 代码块支持直接运行 */
  onExecuteSql?: (sql: string) => Promise<void>;
}) {
  const { thinking, isThinking, content: rawContent } = splitThinkContent(content);
  const actualContent = useMemo(() => repairCodeFences(rawContent), [rawContent]);

  const customComponents = useMemo(
    () => ({
      a: ({ href, children }: any) => (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ),
      pre: ({ children }: any) => (
        <CodeBlock onImport={onImportSql} onOpenNewTab={onOpenNewTab} onExecute={onExecuteSql}>
          {children}
        </CodeBlock>
      ),
    }),
    [onImportSql, onOpenNewTab, onExecuteSql]
  );

  return (
    <div className="md">
      {thinking && (
        <ThinkingBlock text={thinking} isThinking={isThinking} />
      )}
      {actualContent ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={customComponents}
        >
          {actualContent}
        </ReactMarkdown>
      ) : isThinking ? null : (
        <span className="dim" style={{ fontSize: "var(--fs-xs)" }}>
          （无正文回复）
        </span>
      )}
    </div>
  );
}

interface DropdownOption {
  value: string;
  label: string;
  tag?: string;
}
interface DropdownSelectProps {
  label?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** 证书/密钥文件选择按钮：点开系统文件框，读取文本内容回填到对应字段。
 *  跟在文本框后面，免去手动粘贴 PEM 或敲路径。 */
function CertPickButton({
  onPick,
  accept,
  title,
  label,
}: {
  onPick: (text: string) => void;
  accept?: string;
  title?: string;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const handle = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // 允许重复选同一文件
    if (!f) return;
    const r = new FileReader();
    r.onload = () => onPick(String(r.result ?? ""));
    r.readAsText(f);
  };
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={handle}
      />
      <button
        type="button"
        className={label ? "ast-template-btn" : "field-file-btn"}
        title={title ?? "从文件选择"}
        aria-label={title ?? "从文件选择"}
        onClick={() => ref.current?.click()}
      >
        <Icon name="folder" size={12} />
        {label && <span>{label}</span>}
      </button>
    </>
  );
}

function DropdownSelect({ label, value, options, onChange, disabled }: DropdownSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || disabled) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, disabled]);

  const selected = options.find((o) => o.value === value);

  return (
    <label>
      {label}
      <div className={"vendor-select" + (disabled ? " disabled" : "")} ref={ref}>
        <button
          type="button"
          className="vendor-trigger"
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="vendor-value">
            {selected?.label || value || "—"}
            {selected?.tag && <span className="vendor-provider">{selected.tag}</span>}
          </span>
          <span className="vendor-caret">▾</span>
        </button>
        {open && (
          <ul className="vendor-options" role="listbox">
            {options.map((o) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={o.value === value ? "active" : ""}
                onMouseDown={(e) => {
                  // Close on mousedown (not click) so the trigger <button>'s
                  // focus/blur cycle can't re-toggle it open. preventDefault
                  // keeps focus on the trigger instead of the <li>.
                  e.preventDefault();
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.tag && <span className="vendor-tag">{o.tag}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}

type FieldProps = {
  label: string;
  value?: string;
  onChange?: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  type?: "text" | "password";
  /** Use the monospace font for the input (URLs / model names). */
  mono?: boolean;
  /** Right-side decoration (e.g. status badge, chevron). */
  adornment?: React.ReactNode;
  disabled?: boolean;
  /** When provided, this replaces the default <input> with custom
   * content (e.g. a <select>). Use this when the field needs a
   * non-text control that still benefits from the Field layout. */
  children?: React.ReactNode;
};

function Field({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  type = "text",
  mono,
  adornment,
  disabled,
  children,
}: FieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-row">
        {children ?? (
          <input
            className={"field-input" + (mono ? " mono" : "")}
            type={type}
            value={value ?? ""}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange?.(e.target.value)}
            onBlur={onBlur}
          />
        )}
        {adornment && <span className="field-adornment">{adornment}</span>}
      </span>
    </label>
  );
}

/// Render a structured Redis value with type-appropriate layout.
function RedisValueViewer(props: {
  value: RedisValueView;
  ttl?: number;
  size?: number;
}) {
  const { value, ttl, size } = props;

  // Metadata header
  const metaParts: string[] = [];
  if (ttl != null) {
    metaParts.push(ttl < 0 ? "持久" : `TTL ${ttl}s`);
  }
  if (size != null) {
    metaParts.push(
      size < 1024
        ? `${size} B`
        : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / (1024 * 1024)).toFixed(1)} MB`
    );
  }

  const metaEl =
    metaParts.length > 0 ? (
      <div className="redis-meta">{metaParts.join(" · ")}</div>
    ) : null;

  switch (value.type) {
    case "string":
      return (
        <div className="redis-view">
          {metaEl}
          <div className="redis-head">String</div>
          <pre className="redis-string-value">{value.value}</pre>
        </div>
      );

    case "hash":
      return (
        <div className="redis-view">
          {metaEl}
          <div className="redis-head">
            Hash · {value.entries.length} 字段
          </div>
          <div className="redis-kv-table">
            <div className="kv-header">
              <span className="kv-field">Field</span>
              <span className="kv-value">Value</span>
            </div>
            {value.entries.map((e, i) => (
              <div key={i} className="kv-row">
                <span className="kv-field">{e.field}</span>
                <span className="kv-value">{e.value}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "list":
      return (
        <div className="redis-view">
          {metaEl}
          <div className="redis-head">
            List · {value.entries.length} 项
            {value.truncated && "（已截断）"}
          </div>
          <div className="redis-list-view">
            {value.entries.map((e) => (
              <div key={e.index} className="redis-list-item">
                <span className="list-idx">{e.index}</span>
                <span className="list-val">{e.value}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "set":
      return (
        <div className="redis-view">
          {metaEl}
          <div className="redis-head">
            Set · {value.members.length} 成员
            {value.truncated && "（已截断）"}
          </div>
          <div className="redis-set-grid">
            {value.members.map((m, i) => (
              <span key={i} className="redis-set-tag">
                {m}
              </span>
            ))}
          </div>
        </div>
      );

    case "zset":
      return (
        <div className="redis-view">
          {metaEl}
          <div className="redis-head">
            Sorted Set · {value.entries.length} 项
            {value.truncated && "（已截断）"}
          </div>
          <div className="redis-kv-table">
            <div className="kv-header">
              <span className="kv-field">Member</span>
              <span className="kv-value right">Score</span>
            </div>
            {value.entries.map((e, i) => (
              <div key={i} className="kv-row">
                <span className="kv-field">{e.member}</span>
                <span className="kv-value right">{e.score}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "none":
      return (
        <div className="redis-view">
          <div className="redis-note redis-error">键不存在</div>
        </div>
      );

    default:
      return (
        <div className="redis-view">
          <div className="redis-note">未知类型: {(value as any).type}</div>
        </div>
      );
  }
}

interface ConnForm {
  open: boolean;
  editing: boolean;
  cfg: ConnInput;
  /// When creating a connection from a group's context menu, the db type is
  /// pinned to that environment's type so you can't accidentally create a
  /// redis connection under a mysql group (it would silently show up under a
  /// different top-level category).
  lockDbType: boolean;
}

// ---------------------------------------------------------------------------
// Database-picker popup (Phase 27). Instead of a flat cached list, this shows
// the connection hierarchy (env → group → conn) and fetches a connection's
// databases on demand when the connection is expanded. All transient state
// lives inside the component and is destroyed when the popup closes.
// ---------------------------------------------------------------------------

type PickerNode =
  | { kind: "type"; key: string; name: string; children: PickerNode[] }
  | { kind: "env"; key: string; name: string; children: PickerNode[] }
  | { kind: "group"; key: string; name: string; children: PickerNode[] }
  | { kind: "conn"; key: string; conn: ConnSummary };

function buildPickerRoots(tree: TreeModel): PickerNode[] {
  const envs = [...tree.environments].sort((a, b) => a.order - b.order);
  const types = new Set<string>();
  for (const env of envs)
    for (const g of env.groups)
      for (const c of g.connections) types.add(c.db_type);
  const sortedTypes = [...types].sort();
  const labelOf = (t: string) => (t === "redis" ? "Redis" : "MySQL");

  const roots: PickerNode[] = [];
  for (const t of sortedTypes) {
    const envNodes: PickerNode[] = [];
    for (const env of envs) {
      const groups = [...env.groups]
        .sort((a, b) => a.order - b.order)
        .map((g): PickerNode | null => {
          const conns = g.connections.filter((c) => c.db_type === t);
          if (conns.length === 0) return null;
          return {
            kind: "group",
            key: `grp:${g.id}:${t}`,
            name: g.name,
            children: conns.map((c) => ({
              kind: "conn",
              key: `conn:${c.id}`,
              conn: c,
            })),
          };
        })
        .filter((x): x is PickerNode => x !== null);
      if (groups.length === 0) continue;
      envNodes.push({
        kind: "env",
        key: `env:${env.id}:${t}`,
        name: env.name,
        children: groups,
      });
    }
    if (envNodes.length === 0) continue;
    roots.push({ kind: "type", key: `type:${t}`, name: labelOf(t), children: envNodes });
  }
  return roots;
}

interface DbPickerProps {
  tree: TreeModel;
  activeConnId: string;
  activeDb: string | null;
  onSelect: (connId: string, db: string | null) => void;
  onClose: () => void;
}

/** 渲染带有搜索关键词高亮的文本 */
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const matched = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <span className="search-match">{matched}</span>
      {highlightMatch(after, query)}
    </>
  );
}

function DbPicker({ tree, activeConnId, activeDb, onSelect, onClose }: DbPickerProps) {
  const roots = useMemo(() => buildPickerRoots(tree), [tree]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /// Text filter — matches both the connection name (any depth) and the
  /// list of databases that have already been loaded for that connection
  /// (databases are lazy, so a connection's db list is only searchable
  /// after the user has expanded it at least once — that's an accepted
  /// trade-off to keep the picker fast on large accounts).
  const [filter, setFilter] = useState("");

  // 打开时除当前数据库所在连接及环境外，其他全部收缩到环境那一层
  useEffect(() => {
    if (roots.length === 0) return;

    // 查找当前激活连接所属的环境与分组
    let targetEnvKey: string | null = null;
    let targetGroupKey: string | null = null;
    let targetConn: ConnSummary | null = null;

    if (activeConnId) {
      for (const env of tree.environments) {
        for (const g of env.groups) {
          const found = g.connections.find((c) => c.id === activeConnId);
          if (found) {
            targetConn = found;
            targetEnvKey = `env:${env.id}:${found.db_type}`;
            targetGroupKey = `grp:${g.id}:${found.db_type}`;
            break;
          }
        }
        if (targetConn) break;
      }
    }

    setExpanded((prev) => {
      const next = { ...prev };
      for (const r of roots) {
        // 展开顶层类型（MySQL、Redis），露出各个环境
        next[r.key] = true;
        if (r.kind === "type") {
          for (const e of r.children) {
            // 仅当前连接所在的环境展开，其余环境默认收缩在环境那一层
            const isTargetEnv = targetEnvKey ? e.key === targetEnvKey : false;
            next[e.key] = isTargetEnv;
            if (e.kind === "env") {
              for (const g of e.children) {
                // 仅当前连接所在的分组展开，其余收缩
                const isTargetGroup = targetGroupKey ? g.key === targetGroupKey : false;
                next[g.key] = isTargetGroup;
              }
            }
          }
        }
      }
      if (activeConnId) {
        next[`conn:${activeConnId}`] = true;
      }
      return next;
    });

    // 打开弹框时若当前已有连接，自动触发拉取其数据库列表
    if (targetConn) {
      const key = `conn:${activeConnId}`;
      if (!(key in dbs) && !loading[key]) {
        void toggleConn(targetConn);
      }
    }
  }, [roots, activeConnId]);

  // Does this node (or any of its descendants) match the active filter?
  // Used at render time to skip non-matching branches. We don't touch
  // `expanded` — when a match is found we force `isOpen` in the row
  // render, which is enough to surface the hit without polluting the
  // user's manually-collapsed state once they clear the filter.
  const nodeMatches = (n: PickerNode): boolean => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    const ownName = (n.kind === "conn" ? n.conn.name : n.name).toLowerCase();
    if (ownName.indexOf(q) >= 0) return true;
    if (n.kind === "conn") {
      const dbsKey = `conn:${n.conn.id}`;
      const list = dbs[dbsKey] ?? [];
      if (list.some((d) => d.toLowerCase().indexOf(q) >= 0)) return true;
    } else {
      if (n.children.some(nodeMatches)) return true;
    }
    return false;
  };
  const [dbs, setDbs] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const toggleConn = async (conn: ConnSummary) => {
    const key = `conn:${conn.id}`;
    const willExpand = !expanded[key];
    setExpanded((e) => ({ ...e, [key]: willExpand }));
    if (willExpand && !(key in dbs) && !loading[key]) {
      setLoading((l) => ({ ...l, [key]: true }));
      try {
        const list =
          conn.db_type === "redis"
            ? (await api.listRedisDbs(conn.id)).map(String)
            : await api.listDatabases(conn.id);
        setDbs((m) => ({ ...m, [key]: list }));
      } catch (e) {
        console.error("db picker load failed", key, e);
        setDbs((m) => ({ ...m, [key]: [] }));
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    }
  };

  const iconFor = (n: PickerNode) => {
    switch (n.kind) {
      case "type":
        return n.name === "Redis" ? "🔴" : "🐬";
      case "env":
        return "🌐";
      case "group":
        return "📁";
      case "conn":
        return n.conn.db_type === "redis" ? "🔴" : "🐬";
    }
  };

  const renderNode = (node: PickerNode, depth: number): JSX.Element | null => {
    // Filter: drop nodes that don't match AND have no matching descendants.
    // The check is cheap (O(N) on render, but the tree is small).
    if (!nodeMatches(node)) return null;

    const hasChildren = node.kind !== "conn";
    // While filtering, force every node ON the path to a match to render
    // expanded so the user actually sees the hit. Once they clear the
    // filter we fall back to the `expanded` state (so a user who
    // collapsed "MySQL" can still do that).
    const filtering = filter.trim() !== "";
    const isOpen = filtering ? true : !!expanded[node.key];
    const kids = node.kind === "conn" ? [] : node.children;
    const pad = { paddingLeft: `${depth * 16 + 8}px` };

    const onCaretClick = (e: ReactMouseEvent) => {
      e.stopPropagation();
      if (node.kind === "conn") {
        toggleConn(node.conn);
      } else if (hasChildren) {
        setExpanded((ex) => ({ ...ex, [node.key]: !isOpen }));
      }
    };

    const onRowClick = () => {
      if (node.kind === "conn") {
        onSelect(node.conn.id, null);
      } else if (hasChildren) {
        setExpanded((ex) => ({ ...ex, [node.key]: !isOpen }));
      }
    };

    const isActive =
      node.kind === "conn" &&
      node.conn.id === activeConnId &&
      activeDb == null;

    return (
      <div key={node.key} className="tree-node">
        <div
          className={"tree-row" + (isActive ? " active" : "")}
          style={pad}
          onClick={onRowClick}
          title={node.kind === "conn" ? "点击选中连接默认库，点箭头展开数据库" : undefined}
        >
          <span
            className={"tw" + (node.kind === "conn" ? "" : hasChildren ? "" : " leaf")}
            onClick={onCaretClick}
          >
            {node.kind === "conn" ? (isOpen ? "▾" : "▸") : hasChildren ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className="badge">{iconFor(node)}</span>
          <span className="tree-label">
            {highlightMatch(node.kind === "conn" ? node.conn.name : node.name, filter)}
          </span>
          {node.kind === "conn" && loading[`conn:${node.conn.id}`] && (
            <span className="tree-loading">…</span>
          )}
        </div>
        {node.kind === "conn" && isOpen && (() => {
          const q = filter.trim().toLowerCase();
          const allDbs = dbs[`conn:${node.conn.id}`] ?? [];
          const hasDbMatch = q ? allDbs.some((db) => db.toLowerCase().includes(q)) : false;
          const connNameMatches = q ? node.conn.name.toLowerCase().includes(q) : false;

          // 筛选可见数据库：若有明确匹配搜索词的数据库，仅展示匹配项；若仅连接名命中，则展示全部
          const visibleDbs = q && hasDbMatch
            ? allDbs.filter((db) => db.toLowerCase().includes(q))
            : allDbs;

          const showDefaultDb =
            !q || (!hasDbMatch && connNameMatches) || "连接默认库".includes(q) || "default".includes(q);

          return (
            <div>
              {showDefaultDb && (
                <div
                  className={
                    "tree-row db-pick-item" +
                    (node.conn.id === activeConnId && activeDb == null ? " active" : "")
                  }
                  style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                  onClick={() => onSelect(node.conn.id, null)}
                >
                  <span className="tw leaf" />
                  <span className="badge">🏠</span>
                  <span className="tree-label">
                    {highlightMatch("连接默认库", filter)}
                  </span>
                </div>
              )}
              {visibleDbs.map((db) => (
                <div
                  key={db}
                  className={
                    "tree-row db-pick-item" +
                    (node.conn.id === activeConnId && activeDb === db ? " active" : "")
                  }
                  style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
                  onClick={() => onSelect(node.conn.id, db)}
                >
                  <span className="tw leaf" />
                  <span className="badge">🗄</span>
                  <span className="tree-label">{highlightMatch(db, filter)}</span>
                </div>
              ))}
              {q && visibleDbs.length === 0 && !showDefaultDb && (
                <div
                  className="dim"
                  style={{
                    paddingLeft: `${(depth + 1) * 16 + 8}px`,
                    fontSize: "var(--fs-xs)",
                    paddingTop: "4px",
                    paddingBottom: "4px",
                  }}
                >
                  无匹配数据库
                </div>
              )}
            </div>
          );
        })()}
        {node.kind !== "conn" && isOpen &&
          kids
            .map((c) => renderNode(c, depth + 1))
            .filter((n): n is JSX.Element => n !== null)
            .map((n, i) => (
              <div key={kids[i].key}>{n}</div>
            ))}
      </div>
    );
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal db-picker-modal" onClick={(e) => e.stopPropagation()}>
        <h3>切换数据库（当前查询）</h3>
        <div className="db-pick-filter">
          <Icon name="search" size={12} />
          <input
            type="text"
            placeholder="筛选连接名 / 库名…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            // Suppress macOS WKWebView inline suggestions while typing.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
          {filter && (
            <button
              type="button"
              className="db-pick-filter-clear"
              title="清空筛选"
              onClick={() => setFilter("")}
            >
              ×
            </button>
          )}
        </div>
        <div className="db-pick-tree">
          {roots.length === 0 && (
            <div className="tree-empty">暂无连接，请先在左侧添加连接</div>
          )}
          {filter.trim() !== "" &&
            roots.every((r) => !nodeMatches(r)) && (
              <div className="tree-empty">无匹配：{filter}</div>
            )}
          {roots
            .map((r) => renderNode(r, 0))
            .filter((n): n is JSX.Element => n !== null)
            .map((n, i) => (
              <div key={roots[i].key}>{n}</div>
            ))}
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/// Rows per page when browsing a table (kept in sync with the backend PAGE_LIMIT).
const PAGE_SIZE = 200;
/// User-selectable page sizes for the result pager (must be <= backend MAX_PAGE_SIZE).
const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000];

interface BrowseCtx {
  connId: string;
  db: string;
  table: string;
  page: number;
  pageSize: number;
}

/// A query editor tab. Each tab keeps its own SQL text, last result, and
/// browse context so switching tabs never loses work.
interface QueryTab {
  id: string;
  name: string;
  sql: string;
  result: QueryOutput | null;
  browseCtx: BrowseCtx | null;
  // Per-tab database context (Phase 26): each query keeps its own connection
  // and database so switching tabs never clobbers another query's context.
  connId: string;
  db: string | null;
  // 查询的虚拟 ID：作为历史版本组的分组键。同一 tab 里迭代执行的每次
  // 运行都归到同一组，历史面板按组展示（最新一条 + 可展开的历史版本）。
  qid: string;
}

const genTabId = () => "t" + Math.random().toString(36).slice(2, 9);
const genQid = () => "g" + Math.random().toString(36).slice(2, 10);
const INITIAL_TAB = "t1";

const emptyForm = (): ConnInput => ({
  id: "",
  name: "",
  db_type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "",
  password: "",
  database: "",
  group_id: null,
  // --- SSL / TLS (#4) ---
  ssl_mode: "",
  ssl_ca: "",
  client_cert: "",
  client_key: "",
  // --- SSH tunnel / bastion (#5) ---
  ssh_host: "",
  ssh_port: 22,
  ssh_user: "",
  ssh_auth_kind: "password",
  ssh_password: "",
  ssh_private_key: "",
});

/// Build an error "result" the UI already knows how to render (redis variant
/// just shows `note` as a message line).
const errOut = (msg: string): QueryOutput => ({
  kind: "redis",
  command: "",
  lines: [],
  note: msg,
  truncated: false,
});

export function App() {
  const [tree, setTree] = useState<TreeModel>({ environments: [] });
  const [selId, setSelId] = useState<string>("");
  // Currently selected connection/database in the TREE. This is only the
  // "intended" context — new queries inherit it, but each query tab keeps its
  // own connection/db (Phase 26), so selecting a node in the tree never
  // switches an existing query's context.
  const [selDb, setSelDb] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusInfo>({
    llm_enabled: false,
    mask_enabled: true,
  });
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [streaming, setStreaming] = useState(false);
  // Instant send guard. `streaming` is React state — a double-click fires the
  // second sendChat before the re-render lands, and two concurrent turns then
  // stream every token twice ("你好你好…/查询查询"). The ref flips
  // synchronously inside sendChat, so the second click is dropped immediately.
  // Released on chat-done / chat-error / invoke failure. 2026-08-12.
  const sendingRef = useRef(false);
  // --- Conversations (docs/chat-conversation-design.md) ----------------------
  // `convs` is the cached list backing the selector; `convId` is the active
  // conversation. Messages themselves live in `chat` (the transcript) and are
  // appended to the store when a turn finishes (§5.2) — the UI never persists
  // itself, so TUI/future clients share the same data.
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  /// Live mirror of `chat` for the one-shot chat-done listener (registered
  /// once on mount, so it must not close over stale state).
  const chatRef = useRef<ChatItem[]>([]);
  chatRef.current = chat;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;
  /// Snapshot of the *current turn's* items (ref card + user + plan + assistant
  /// placeholder), tagged with the conversation it belongs to. Refilled on
  /// sendChat, extended by plan/token events, and appended to the store on
  /// chat-done — exactly the §5.2 persistence window. Tagging the conv id
  /// stops a mid-stream conversation switch from persisting under the new one.
  const turnItemsRef = useRef<{ convId: string | null; items: ChatItem[] }>({
    convId: null,
    items: [],
  });
  /// Pending @-mention cards staged on the composer (P1, §6.1).
  const [pendingConvRefs, setPendingConvRefs] = useState<ConvRefCard[]>([]);
  /// Conversation selector dropdown state.
  const [convOpen, setConvOpen] = useState(false);
  const [convSearch, setConvSearch] = useState("");
  const convWrapRef = useRef<HTMLDivElement | null>(null);
  /// @-mention picker: open flag + filtered list cursor.
  const [atOpen, setAtOpen] = useState(false);
  const [atFilter, setAtFilter] = useState("");
  const [atIdx, setAtIdx] = useState(0);
  /// Message-level scope picker: after choosing a conversation, the user can
  /// drill into its messages and reference a single one (§6.1).
  const [convMsgPick, setConvMsgPick] = useState<ConversationSummary | null>(null);
  const [convMsgList, setConvMsgList] = useState<StoredChatMessage[]>([]);
  /// SQL staged on the composer, waiting to be sent with the next message
  /// (ADR: Chat 引用 SQL, 方案 B). Held here rather than pasted into the input
  /// box so it stays structured (connection + db travel with it) and reversible
  /// — dismissing a chip leaves the user's typed question untouched.
  const [pendingRefs, setPendingRefs] = useState<SqlReference[]>([]);
  /// A reference the user clicked to inspect in full (chips only show a head).
  const [refView, setRefView] = useState<SqlReference | null>(null);
  /// Id of the in-flight turn — the handle for cancelling it. Kept in a ref
  /// (not state) because the event listeners are registered once on mount and
  /// would otherwise close over a stale value.
  const turnIdRef = useRef<string | null>(null);
  /// The conn/db context this turn runs against, captured at send time and
  /// stamped onto the final assistant message so the reply remembers which DB
  /// its SQL targets (persisted in the message meta, survives restarts).
  const turnBindingRef = useRef<ChatDbBinding | null>(null);
  /// Pending write confirmations. A single ReAct round can emit several tool
  /// calls in parallel, so this is a queue: we show the head and answer them
  /// one at a time rather than stacking modals.
  const [confirmQueue, setConfirmQueue] = useState<ConfirmRequest[]>([]);
  /// Write-guardrail audit trail (ADR-AI-1 决策3), loaded on demand.
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  /// Chat 中一键执行 SQL 的二次确认弹窗（防误触）
  const [chatSqlConfirm, setChatSqlConfirm] = useState<{
    sql: string;
    connId: string;
    db: string | null;
    connName: string;
    isWrite: boolean;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [form, setForm] = useState<ConnForm>({
    open: false,
    editing: false,
    cfg: emptyForm(),
    lockDbType: false,
  });
  const [formTab, setFormTab] = useState<"basic" | "ssl" | "ssh">("basic");
  const [addOpen, setAddOpen] = useState(false);
  const addWrapRef = useRef<HTMLDivElement | null>(null);

  // --- Query tabs -----------------------------------------------------------
  const [tabs, setTabs] = useState<QueryTab[]>([
    {
      id: INITIAL_TAB,
      name: "查询 1",
      sql: "",
      result: null,
      browseCtx: null,
      connId: "",
      db: null,
      qid: genQid(),
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_TAB);
  // "More actions" dropdown (格式化 / 问 AI / 存为片段 / 历史 / 执行计划).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  // "引用到 Chat" dropdown on editor toolbar
  const [refMenuOpen, setRefMenuOpen] = useState(false);
  const refMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (refMenuRef.current && !refMenuRef.current.contains(e.target as Node)) setRefMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setRefMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [refMenuOpen]);
  // Current page size for query results / table browse. Selectable 100..1000.
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);
  // Raw text of the "jump to page" input (kept as string for controlled input).
  const [jumpPage, setJumpPage] = useState<string>("");
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Phase 26: per-tab database picker. The active query tab's DB is changed
  // through this popup (not by clicking the tree) to avoid accidental context
  // switches between queries.
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  // Per-opener callback for the db picker. The same modal is used from
  // two places with different intents:
  //   • SQL editor area → wants to update the active tab's context
  //   • Chat + menu     → wants to update the chat's own context
  // (without disturbing the SQL tab, which is what the original
  // behaviour did — picking from the chat "jumped" to the query area).
  // When null we fall back to the SQL-editor default (changeTabContext).
  const [dbPickerCallback, setDbPickerCallback] = useState<
    ((connId: string, db: string | null) => void) | null
  >(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<QueryItem[]>([]);
  const [historyTab, setHistoryTab] = useState<"history" | "snippet">("history");
  const [historySearch, setHistorySearch] = useState("");
  const [historyConn, setHistoryConn] = useState<string>("");
  // 展开的版本组（组头 id → 显示其历史版本列表）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const editorRef = useRef<EditorHandle | null>(null);
  // Editor right-click menu (Navicat-style): where to show it + whether text
  // is selected (drives cut/copy/delete/case/"run selection" enabled state).
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    hasSel: boolean;
  } | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // --- Inline cell editing (ADR-018) + INSERT/DELETE (ADR-019) ------------
  // `edits` is an overlay keyed by row index -> column index -> new value.
  // The underlying `result.rows` always holds the DB snapshot, so locating a
  // row for writes uses the original primary-key values, never the edited ones.
  const [edits, setEdits] = useState<Record<number, Record<number, string>>>({});
  // Row indices marked for deletion. The row is still displayed (struck-through)
  // until "保存修改" commits the DELETE.
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  // Pending insert rows. Each entry is a column-index -> value map. Cells left
  // empty are omitted from the INSERT so DB defaults (AUTO_INCREMENT etc) apply.
  const [inserts, setInserts] = useState<Record<number, string>[]>([]);
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(null);
  const [draft, setDraft] = useState("");

  // --- Row multi-select + copy menu (Phase 20) -----------------------------
  // `selRows` holds result-row indices selected for copy (JSON / INSERT / UPDATE).
  const [selRows, setSelRows] = useState<Set<number>>(new Set());
  // `selCols` mirrors `selRows` for column headers: Ctrl/Cmd+click toggles,
  // Shift+click takes the anchor range, right-click pins the menu's columns.
  const [selCols, setSelCols] = useState<Set<number>>(new Set());
  // Single-cell selection (set by clicking a data cell; cleared on row/column
  // selection). Drives the .cell-selected highlight independently of rows/cols.
  const [selCell, setSelCell] = useState<{ ri: number; ci: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    rows: number[];
    cell?: { ri: number; ci: number };
    col?: number;
  } | null>(null);
  // Hover preview of a clipped result cell. Only shown when the cell's content
  // overflows its 360px max-width, so short cells stay clean. Positioned with
  // fixed coords + clamped to the viewport after mount.
  const [cellTip, setCellTip] = useState<{ text: string; x: number; y: number; maxW: number } | null>(null);
  const cellTipRef = useRef<HTMLDivElement>(null);
  // Hover-tip hide timer. We keep a small grace period so moving the cursor
  // from the cell onto the tip (or back) doesn't instantly clear it — this is
  // what made the tip "disappear when you move onto it" before.
  const cellTipHideTimer = useRef<number | null>(null);
  const cancelCellTipHide = () => {
    if (cellTipHideTimer.current != null) {
      clearTimeout(cellTipHideTimer.current);
      cellTipHideTimer.current = null;
    }
  };
  const scheduleCellTipHide = () => {
    cancelCellTipHide();
    cellTipHideTimer.current = window.setTimeout(() => setCellTip(null), 160);
  };
  // Stable cell-detail viewer. Unlike the hover tooltip, this works even when
  // the Chat panel covers the right side of the result grid — you can open it
  // via double-click or the right-click context menu.
  const [cellView, setCellView] = useState<{ ri: number; ci: number; text: string } | null>(null);
  useEffect(() => {
    if (cellTip && cellTipRef.current) {
      const el = cellTipRef.current;
      const r = el.getBoundingClientRect();
      let x = cellTip.x;
      let y = cellTip.y;
      if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
      if (y + r.height > window.innerHeight - 8) y = window.innerHeight - r.height - 8;
      if (x < 8) x = 8;
      if (y < 8) y = 8;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [cellTip]);
  const [toast, setToast] = useState<string | null>(null);
  const lastAnchorRef = useRef(0);
  // Shift-range anchor for column-header selection (mirrors lastAnchorRef).
  const lastColAnchorRef = useRef(0);

  // Drag-to-select (marquee) for the result grid: hold left mouse and move
  // across rows to select a continuous range. Sits alongside the click / Ctrl /
  // Shift selection handled in onRowClick below.
  const dragRef = useRef<{ anchor: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const up = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDragging(false);
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Defensive: Tauri's WKWebView shows its own context menu (Reload / Inspect),
  // and on macOS a native "Paste" bubble pops up on right-click over editable
  // areas. `contextmenu` preventDefault suppresses the menu, but that "Paste"
  // bubble is triggered by the OS on the right-button *mousedown* — before the
  // contextmenu event our custom menu depends on — so we also swallow the
  // default there. Both run in the capture phase so they fire before any
  // native handling. This guarantees our custom menus are the only thing that
  // appear over the editor and the result table.
  useEffect(() => {
    const inScope = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest?.(".result-table") || !!el?.closest?.(".editor");
    };
    const onMouseDown = (e: MouseEvent) => {
      if ((e.button === 2 || e.ctrlKey) && inScope(e.target)) {
        e.preventDefault();
      }
    };
    const onCtx = (e: MouseEvent) => {
      if (inScope(e.target)) e.preventDefault();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("contextmenu", onCtx, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("contextmenu", onCtx, true);
    };
  }, []);

  // --- Table structure view (ADR-020) --------------------------------------
  // When set, the result panel renders a structure view (columns, indexes,
  // DDL) instead of the data grid. Cleared on tab switch, new query, browse.
  const [structureView, setStructureView] =
    useState<{ connId: string; db: string; table: string; data: TableStructure } | null>(null);

  // --- Table relationship view (ER simplified, ADR-021) -------------------
  // When set, the result panel shows a list of foreign-key relationships for
  // the entire database (not just one table). Cleared alongside other views.
  const [relationshipView, setRelationshipView] =
    useState<{ connId: string; db: string; fks: ForeignKeyInfo[] } | null>(null);

  // --- Result sub-tabs (Phase 18) -----------------------------------------
  // Unifies the three result-panel views behind a Chat2DB-style tab strip:
  // "data" (grid) | "structure" (columns/indexes/DDL) | "relation" (FK map).
  // Structure/relation data live in the *_View states above; this just picks
  // which one the body renders.
  const [resultTab, setResultTab] =
    useState<"data" | "structure" | "relation" | "explain">("data");
  // EXPLAIN execution-plan visualisation (#6), populated by `explainQuery`.
  const [explainView, setExplainView] = useState<ExplainVisual | null>(null);

  // --- Result grid filter / sort / search (#3) ---
  // All operate on the in-memory current page only (no server round-trip).
  const [gridSearch, setGridSearch] = useState("");
  const [gridCase, setGridCase] = useState(false);
  const [gridSort, setGridSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  // Per-column filter: op ∈ contains|equals|nequals|empty|notempty|range.
  const [colFilters, setColFilters] = useState<Record<number, { op: string; val: string; val2?: string }>>({});
  // Export dropdown (CSV / Excel / JSON) — replaces single-button CSV export.
  const [exportOpen, setExportOpen] = useState(false);
  // Multi-result-set: when the user runs multiple statements (separated by ;),
  // each result set is stored here and shown as a sub-tab (③ enhancement).
  const [multiResults, setMultiResults] = useState<QueryOutput[] | null>(null);
  const [multiResultIdx, setMultiResultIdx] = useState(0);

  // --- DBX-inspired enhancements ------------------------------------------
  // Transpose View state (row-column swap for wide records)
  const [isTransposed, setIsTransposed] = useState(false);
  const [transposeRowIdx, setTransposeRowIdx] = useState(0);
  const [transposeFilter, setTransposeFilter] = useState("");

  // Result Pane Collapse state (Floating pill affordance to restore)
  const [resultCollapsed, setResultCollapsed] = useState(false);

  // AI Chat Maximize Canvas state (fullscreen / focused reasoning mode)
  const [chatMaximized, setChatMaximized] = useState(false);

  // --- Inline AI Composer (Cmd+K) -----------------------------------------
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [inlineAiGenerating, setInlineAiGenerating] = useState(false);
  const [inlineAiThinking, setInlineAiThinking] = useState(false);
  const [inlineAiGenerated, setInlineAiGenerated] = useState(false);
  const [inlineAiSelectedSql, setInlineAiSelectedSql] = useState("");
  const inlineAiSnapshotRef = useRef<{
    from: number;
    to: number;
    currentEnd: number;
    origText: string;
    streamedText: string;
  } | null>(null);
  const handleOpenInlineAiRef = useRef<() => void>(() => {});

  // --- Bottom status bar / console (Phase 18) -----------------------------
  // Last operation feedback: timing, affected/returned rows, errors. Replaces
  // the old "run and hope" silence — DBeaver/TablePlus/DataGrip all have one.
  const [runInfo, setRunInfo] = useState<{ kind: "ok" | "err" | "warn" | "info"; text: string } | null>(null);
  const [running, setRunning] = useState(false);

  // --- Collapsible AI panel + theme (Phase 18) ----------------------------
  const [chatOpen, setChatOpen] = useState<boolean>(() => {
    const v = localStorage.getItem("cq_chat_open");
    return v === null ? true : v === "1";
  });
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const v = localStorage.getItem("cq_chat_width");
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 220 && n <= 600 ? n : 360;
  });
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const v = localStorage.getItem("cq_theme");
    return v === "light" ? "light" : "dark";
  });

  // --- Per-call query timeout (seconds) ----------------------------------
  // User preference mirrored from `getQueryTimeoutSecs()` in `api.ts`. The
  // setter also writes to localStorage; `api.executeQuery` always reads the
  // latest value on invoke, so a tweak in settings takes effect on the next
  // query without a reload. 2026-08-17.
  const [queryTimeoutSecs, setQueryTimeoutSecs] = useState<number>(
    () => {
      const raw = localStorage.getItem("cq_query_timeout_secs");
      const n = raw == null ? NaN : Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 300;
      return Math.min(1800, Math.max(1, Math.floor(n)));
    }
  );
  const [queryHistoryLimit, setQueryHistoryLimit] = useState<number>(() => {
    const raw = localStorage.getItem("cq_query_history_limit");
    const n = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 200;
    return Math.min(5000, Math.max(10, Math.floor(n)));
  });

  // --- Resizable chat panel -----------------------------------------------
  const appContainerRef = useRef<HTMLDivElement>(null);
  const isResizingChat = useRef(false);
  const startChatX = useRef(0);
  const startChatW = useRef(360);
  const chatRafId = useRef<number | null>(null);
  const latestChatW = useRef(chatWidth);
  const onChatResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizingChat.current) return;
    const delta = startChatX.current - e.clientX; // dragging left expands chat
    const next = Math.min(600, Math.max(220, startChatW.current + delta));
    latestChatW.current = next;
    if (chatRafId.current === null) {
      chatRafId.current = requestAnimationFrame(() => {
        if (appContainerRef.current) {
          appContainerRef.current.style.setProperty("--chat-width-val", `${latestChatW.current}px`);
        }
        chatRafId.current = null;
      });
    }
  }, []);
  const stopChatResize = useCallback(() => {
    if (isResizingChat.current) {
      isResizingChat.current = false;
      if (chatRafId.current !== null) cancelAnimationFrame(chatRafId.current);
      document.body.classList.remove("dragging-h");
      document.removeEventListener("mousemove", onChatResizeMove);
      document.removeEventListener("mouseup", stopChatResize);
      setChatWidth(latestChatW.current);
    }
  }, [onChatResizeMove]);
  const startChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingChat.current = true;
    startChatX.current = e.clientX;
    startChatW.current = chatWidth;
    latestChatW.current = chatWidth;
    document.body.classList.add("dragging-h");
    document.addEventListener("mousemove", onChatResizeMove);
    document.addEventListener("mouseup", stopChatResize);
  }, [chatWidth, onChatResizeMove, stopChatResize]);

  // Persist chat width when the drag ends.
  useEffect(() => {
    if (!isResizingChat.current) {
      localStorage.setItem("cq_chat_width", String(chatWidth));
    }
  }, [chatWidth]);

  // --- Editor vertical height splitter (高性能 rAF + CSS Variable 零延迟拖拽) ----------
  const [editorPercent, setEditorPercent] = useState<number>(() => {
    const saved = localStorage.getItem("cq_editor_percent");
    const parsed = saved ? parseFloat(saved) : 50;
    return isNaN(parsed) || parsed < 15 || parsed > 85 ? 50 : parsed;
  });
  const isResizingV = useRef(false);
  const startY = useRef(0);
  const startPercent = useRef(50);
  const appMainRef = useRef<HTMLElement>(null);

  const startVResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    isResizingV.current = true;
    startY.current = e.clientY;
    startPercent.current = editorPercent;
    let latestPercent = editorPercent;
    let rafId: number | null = null;

    document.body.classList.add("dragging-v");

    const onMove = (me: MouseEvent) => {
      if (!isResizingV.current || !appMainRef.current) return;
      const rect = appMainRef.current.getBoundingClientRect();
      const totalH = rect.height;
      if (totalH <= 0) return;
      const deltaY = me.clientY - startY.current;
      const deltaPercent = (deltaY / totalH) * 100;
      latestPercent = Math.min(85, Math.max(15, startPercent.current + deltaPercent));

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          if (appMainRef.current) {
            appMainRef.current.style.setProperty("--editor-flex", `${latestPercent}%`);
          }
          rafId = null;
        });
      }
    };

    const onUp = () => {
      if (isResizingV.current) {
        isResizingV.current = false;
        if (rafId !== null) cancelAnimationFrame(rafId);
        document.body.classList.remove("dragging-v");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setEditorPercent(latestPercent);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [editorPercent]);

  useEffect(() => {
    localStorage.setItem("cq_editor_percent", String(editorPercent));
  }, [editorPercent]);

  // --- LLM vendor/key/model settings (Phase 19) --------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings is a left-nav module switcher: each module opens its own config
  // page on the right. Keeping this as explicit buttons (not a <select>
  // dropdown) makes the module list scannable and easy to extend.
  const [settingsTab, setSettingsTab] = useState<
    "model" | "key" | "general" | "kb" | "assistant"
  >("model");
  const [presets, setPresets] = useState<VendorPreset[]>([]);
  const [llmCfg, setLlmCfg] = useState<LlmConfigDto | null>(null);
  const [vendorProfiles, setVendorProfiles] = useState<VendorProfileDto[]>([]);
  // Composer toolbar state — + menu, model dropdown.
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plusOpen && !modelOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (plusOpen && plusMenuRef.current && !plusMenuRef.current.contains(t) &&
          !(e.target as HTMLElement | null)?.closest?.(".composer-plus")) {
        setPlusOpen(false);
      }
      if (modelOpen && modelMenuRef.current && !modelMenuRef.current.contains(t) &&
          !(e.target as HTMLElement | null)?.closest?.(".composer-model")) {
        setModelOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPlusOpen(false);
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen, modelOpen]);

  // When the model dropdown opens, scroll the previously selected
  // model into view so the user can "continue choosing" from where
  // they left off (especially useful with a long vendor list). We
  // wait a microtask so the <ul> is actually in the DOM and laid
  // out before measuring.
  const modelMenuListRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!modelOpen) return;
    const id = window.setTimeout(() => {
      const list = modelMenuListRef.current;
      if (!list) return;
      const active = list.querySelector(".composer-model-item.active");
      if (active && "scrollIntoView" in active) {
        // `block: "nearest"` keeps the scroll minimal — only nudges
        // the list if the active item is actually off-screen.
        (active as HTMLElement).scrollIntoView({ block: "nearest" });
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [modelOpen, llmCfg?.vendor, llmCfg?.model]);
  // Display label for the current model: "<供应商名> · <model>" when
  // configured, "选择模型" otherwise. The supplier name is resolved
  // in this order:
  //   1. user vendor profile (vendorProfiles[].name) — the user-defined
  //      name like "腾讯 TokenHub"
  //   2. preset label (presets[].label) — the built-in "OpenAI" /
  //      "阿里云通义千问" / etc. (in case some legacy config still
  //      points at a preset id)
  //   3. raw llmCfg.provider or vendor id as a last-resort fallback
  // Previously this used `llmCfg.provider` (the protocol name like
  // "openai" / "anthropic") which gave a confusing label like
  // "openai · hy3" for a user vendor that's actually called 腾讯 TokenHub.
  const currentModelLabel = () => {
    if (!llmCfg?.model) return "选择模型";
    const userVendor = vendorProfiles.find((p) => p.id === llmCfg.vendor);
    if (userVendor) return `${userVendor.name} · ${llmCfg.model}`;
    const preset = presets.find((p) => p.id === llmCfg.vendor);
    if (preset) return `${preset.label || preset.provider} · ${llmCfg.model}`;
    return `${llmCfg.provider || llmCfg.vendor} · ${llmCfg.model}`;
  };
  // Vendor-profile management state. `editingVendor` is the id of the
  // currently selected profile in the settings list, or null when the
  // user is creating a new one. `vendorDraft` is the in-progress form.
  const [editingVendor, setEditingVendor] = useState<string | null>(null);
  // The auto-pick effect below would otherwise steal back the selection
  // every time the user clicks "+ 添加供应商" (which sets editingVendor to
  // null). This ref is the "I really want to create, don't auto-pick"
  // latch. It's reset to false whenever the user explicitly picks an
  // existing vendor from the list (or after a successful add / delete).
  const userWantsCreate = useRef(false);
  // When the user opens the model tab without a selection, auto-pick the
  // first vendor so the right pane is never blank after the list loads.
  useEffect(() => {
    if (userWantsCreate.current) return;
    if (editingVendor === null && vendorProfiles.length > 0) {
      setEditingVendor(vendorProfiles[0].id);
      setVendorDraft({
        name: vendorProfiles[0].name,
        base_url: vendorProfiles[0].base_url,
        api_key: "",
        api_format: (vendorProfiles[0].api_format as "openai" | "anthropic") || "openai",
        models: vendorProfiles[0].models.map((m) => ({ name: m.name })),
        newModel: "",
      });
    }
  }, [editingVendor, vendorProfiles]);
  const [vendorDraft, setVendorDraft] = useState<{
    name: string;
    base_url: string;
    api_key: string;
    api_format: "openai" | "anthropic";
    /** In-progress model list — the source of truth for the 模型列表
     * section in BOTH edit and create mode. In edit mode it's synced
     * from `vendorProfiles[i].models` on select; in create mode it
     * starts as `[]` and grows as the user types. Each add/delete
     * updates this list locally; in edit mode we also persist via
     * `saveModelAlias`; in create mode the list is included in the
     * final "添加供应商" save. */
    models: { name: string }[];
    /** Current value of the "添加 model" input. */
    newModel: string;
  }>({
    name: "",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    api_format: "openai",
    models: [],
    newModel: "",
  });
  // Preset popover open state — only used in CREATE mode. The presets are
  // loaded once when the settings dialog opens and live in `presets`.
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  // In-flight state for the "添加供应商" button — prevents double
  // submission and drives the "添加中…" label + spinner.
  const [creating, setCreating] = useState(false);
  // Close the preset popover when the user clicks outside of it.
  useEffect(() => {
    if (!presetMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".field-preset-trigger, .field-preset-menu")) return;
      setPresetMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [presetMenuOpen]);

  // --- Connection encryption key K (#0) ---
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ configured: false });
  const [keyField, setKeyField] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Configure or rotate the connection key K. An empty field resets K back to
  // the default KEK (behaves like a pre-#0 install).
  const saveKey = async () => {
    setKeyMsg(null);
    try {
      await api.setEncryptionKey(keyField);
      setKeyStatus(await api.getKeyStatus());
      setKeyField("");
      setKeyMsg({ ok: true, text: "密钥已保存，所有连接已重加密" });
    } catch (e) {
      setKeyMsg({ ok: false, text: String(e) });
    }
  };

  // Load vendor presets + current config when the settings dialog opens.
  // Sequencing: listModelAliases() FIRST because it may trigger a backend
  // "reconcile" that rewrites LlmConfig.vendor (legacy preset id → fresh
  // profile id). Only after that completes should we read the (now
  // aligned) LlmConfig. If we read in parallel, the frontend sees the
  // pre-reconcile LlmConfig and the auto-save apply check fails.
  const openSettings = useCallback(async () => {
    try {
      const profiles = await api.listModelAliases();
      setVendorProfiles(profiles);
      const [ps, cfg, ks] = await Promise.all([
        api.getVendorPresets(),
        api.getLlmConfig(),
        api.getKeyStatus(),
      ]);
      setPresets(ps);
      setLlmCfg(cfg);
      setKeyStatus(ks);
    } catch (e) {
      showToast("加载设置失败: " + String(e));
    }
    setSettingsTab("model");
    setSettingsOpen(true);
  }, []);

  /// Auto-save the current vendor draft. Only safe to call when an
  /// existing vendor is being edited (`editingVendor` truthy) — for new
  /// vendors the user must still click the explicit "添加供应商" button
  /// to provide a stable id. We deep-compare the draft against the stored
  /// vendor to avoid round-tripping on no-op onBlur.
  /// Auto-save the current vendor draft. Plain async function (NOT
  /// useCallback) because we read `vendorDraft` from closure on every
  /// call — a memoised callback with a stale `vendorDraft` dep would
  /// silently no-op the deep-compare (draft.base_url === current.base_url
  /// is always true for the cached closure) and the user would see "改
  /// 了地址 / 切回来原样" with no error. Recreating each render costs
  /// nothing here — no child component memos on it.
  ///
  /// If the saved vendor is the currently-active one (i.e. the one
  /// driving live LLM calls), we also re-apply it so the runtime
  /// LlmConfig picks up the new api_key / base_url immediately. Without
  /// this, the user has to go re-pick a model in the composer after
  /// every key change, which is the source of "加了 key 怎么还 401".
  const autoSaveVendor = async (
    overrides?: Partial<typeof vendorDraft>
  ): Promise<"saved" | "unchanged" | "error"> => {
    if (!editingVendor) return "unchanged";
    const current = vendorProfiles.find((p) => p.id === editingVendor);
    if (!current) return "unchanged";
    const draft = { ...vendorDraft, ...(overrides || {}) };
    if (
      draft.name === current.name &&
      draft.base_url === current.base_url &&
      draft.api_format === current.api_format &&
      // api_key is only "changed" if the user typed a non-empty value.
      // Empty = keep stored key.
      (draft.api_key === "" || draft.api_key === current.api_key_hint)
    ) {
      return "unchanged"; // nothing to save
    }
    try {
      const newKey = draft.api_key;
      const newBaseUrl = draft.base_url.trim();
      await api.saveModelAlias({
        id: current.id,
        name: draft.name.trim(),
        vendor: current.id,
        base_url: newBaseUrl,
        model: "",
        api_key: newKey,
        api_format: draft.api_format,
        models: current.models,
      });
      const fresh = await api.listModelAliases();
      setVendorProfiles(fresh);
      setVendorDraft({ ...draft, api_key: "" });
      // Re-apply the vendor to the runtime LlmConfig so any change
      // (key, base_url, api_format, even model list) takes effect
      // immediately. The user expectation is "改了就生效" — they
      // should not have to go back to the composer to re-pick a
      // model just to pick up a new key.
      //
      // We match the active LLM by id OR by base_url. The id match
      // is the fast path (after a successful backend reconcile,
      // LlmConfig.vendor is the profile id). The base_url match is
      // the safety net: if the user is mid-edit on a legacy install
      // where LlmConfig.vendor still holds the old preset id
      // ("tokenhub") while the profile uses a fresh "vXXX..." id,
      // the id check would skip the apply and the new key never
      // reaches runtime — every chat still 401s. base_url is a
      // unique-enough proxy because every vendor has its own
      // endpoint URL.
      const latestProfile = fresh.find((p) => p.id === current.id);
      if (latestProfile && llmCfg?.model) {
        const isActive =
          llmCfg.vendor === current.id ||
          (!!llmCfg.base_url && llmCfg.base_url === current.base_url);
        // eslint-disable-next-line no-console
        console.log("[vendor save] apply check", {
          editingId: current.id,
          editingName: current.name,
          llmCfgVendor: llmCfg?.vendor,
          llmCfgBaseUrl: llmCfg?.base_url,
          llmCfgModel: llmCfg?.model,
          isActive,
          newKeySet: newKey !== "",
        });
        if (isActive) {
          const stillHas = latestProfile.models.some((m) => m.name === llmCfg.model);
          if (stillHas) {
            try {
              await api.applyModelAlias(current.id, llmCfg.model);
              setLlmCfg(await api.getLlmConfig());
              // eslint-disable-next-line no-console
              console.log("[vendor save] apply ok, runtime updated");
            } catch (e) {
              showToast?.("已保存,但 runtime 未生效,需重选 model: " + String(e));
              // eslint-disable-next-line no-console
              console.error("[vendor save] apply failed", e);
            }
          } else {
            showToast?.(`已保存,当前 model「${llmCfg.model}」不在供应商里,记得去 composer 重选`);
          }
        }
      }
      // Refresh `status` so the header bar's "LLM 已配置/未配置"
      // text reflects the new state. Best-effort.
      try {
        setStatus(await api.getStatus());
      } catch {
        /* status refresh is best-effort */
      }
      return "saved";
    } catch (e) {
      showToast?.("保存失败: " + String(e));
      return "error";
    }
  };

  // -------------------------------------------------------------------
  // Add a model to the in-progress draft. In edit mode also persists
  // via saveModelAlias (the backend keeps the vendor's identity); in
  // create mode the list stays local until the "添加供应商" save.
  //
  // Race: if the user edited base_url / api_format and hasn't blurred
  // out of those fields yet, the SAVED profile (v.*) still has the old
  // base_url. We flush any pending vendor-level edits first so the
  // new model list is written with the *new* base_url, not a stale one.
  //
  // Plain function (not useCallback) for the same reason as
  // autoSaveVendor: the draft + autoSaveVendor closure must be fresh.
  // -------------------------------------------------------------------
  const addModel = (rawName: string) => {
    const newName = rawName.trim();
    if (!newName) return;
    if (vendorDraft.models.some((m) => m.name === newName)) return;
    const nextModels = [...vendorDraft.models, { name: newName }];
    setVendorDraft({ ...vendorDraft, models: nextModels, newModel: "" });
    if (!editingVendor) return; // create mode — no backend yet
    const v = vendorProfiles.find((p) => p.id === editingVendor);
    if (!v) return;
    // If the draft has unsaved base_url / api_format / name changes,
    // autoSaveVendor will bake them in first. After it resolves,
    // re-read vendorProfiles so `v` below is the post-save state.
    const needsFlush =
      vendorDraft.base_url !== v.base_url ||
      vendorDraft.name !== v.name ||
      vendorDraft.api_format !== v.api_format ||
      (vendorDraft.api_key !== "" && vendorDraft.api_key !== v.api_key_hint);
    const persist = (latest: typeof vendorProfiles) => {
      const cur = latest.find((p) => p.id === editingVendor);
      if (!cur) return;
      api
        .saveModelAlias({
          id: cur.id,
          name: cur.name,
          vendor: cur.id,
          base_url: cur.base_url,
          model: "",
          api_key: "",
          api_format: cur.api_format,
          models: nextModels,
        })
        .then(() => api.listModelAliases())
        .then((list) => setVendorProfiles(list))
        .catch((e) => showToast("添加 model 失败: " + String(e)));
    };
    if (needsFlush) {
      autoSaveVendor()
        .then(() => api.listModelAliases())
        .then((latest) => {
          setVendorProfiles(latest);
          persist(latest);
        })
        .catch((e) => showToast("添加 model 失败: " + String(e)));
    } else {
      persist(vendorProfiles);
    }
  };

  // -------------------------------------------------------------------
  // Remote model catalog — the "添加 model" input doubles as a combobox:
  // on first focus we fetch the vendor's /models catalog in the background,
  // then typing filters it and clicking a suggestion adds it. Manual typed
  // entry keeps working when the catalog is unavailable (offline, bad key).
  // -------------------------------------------------------------------
  const [modelsFetching, setModelsFetching] = useState(false);
  const [remoteCatalog, setRemoteCatalog] = useState<string[] | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // Close the suggestion dropdown on outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".alias-add")) return;
      setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelMenuOpen]);

  const ensureCatalog = async (forceToast = false) => {
    if (modelsFetching) return;
    const url = vendorDraft.base_url.trim();
    if (!url) {
      if (forceToast) showToast("请先填写接口地址");
      return;
    }
    const hasKey =
      !!vendorDraft.api_key.trim() ||
      !!(editingVendor && vendorProfiles.find((p) => p.id === editingVendor)?.enabled);
    if (!hasKey) {
      if (forceToast) showToast("请先在上方输入 API 密钥，再拉取远程模型");
      return;
    }
    setModelsFetching(true);
    try {
      const ids = await api.listRemoteModels(
        url,
        vendorDraft.api_key.trim(),
        vendorDraft.api_format,
        editingVendor
      );
      if (ids && ids.length > 0) {
        setRemoteCatalog(ids);
        setModelMenuOpen(true);
        if (forceToast) showToast(`成功获取 ${ids.length} 个模型，请选择或输入`);
      } else {
        if (forceToast) showToast("远程接口未返回可用模型列表，可手动输入模型名称添加");
      }
    } catch (err) {
      if (forceToast) {
        showToast("获取模型列表失败: " + String(err));
      }
    } finally {
      setModelsFetching(false);
    }
  };

  /// Clear all edit overlays (edits + deletes + inserts + active cell). Called
  /// on tab switch, re-query, page change, save, and undo.
  const clearEditState = useCallback(() => {
    setEdits({});
    setDeletes(new Set());
    setInserts([]);
    setEditing(null);
    setStructureView(null);
    setRelationshipView(null);
    setResultTab("data");
  }, []);

  // Apply the chosen theme to <html> (CSS variables) and the CodeMirror editor,
  // persisting it so a reload keeps the user's preference. Runs on mount too,
  // so the editor starts in the stored theme instead of flashing.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cq_theme", theme);
    editorRef.current?.setTheme(theme === "dark");
  }, [theme]);

  // Derived active-tab view of result + browse context (used by the pager and
  // the result renderer — keeps those unchanged).
  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const activeRef = useRef(active);
  activeRef.current = active;
  const result = active?.result ?? null;
  const browseCtx = active?.browseCtx ?? null;

  // Only a browse result over a table with a primary key is editable. Arbitrary
  // SQL output (no stable row identity) and Redis results are read-only.
  const editable =
    !!browseCtx &&
    result?.kind === "table" &&
    (result.primaryKeys?.length ?? 0) > 0;
  const hasEdits =
    Object.keys(edits).length > 0 || deletes.size > 0 || inserts.length > 0;

  // --- Row multi-select + copy menu (Phase 20) -----------------------------
  // Drop the selection whenever the result or the active tab changes.
  useEffect(() => {
    setSelRows(new Set());
    setSelCols(new Set());
    setSelCell(null);
    setCtxMenu(null);
  }, [active?.id, result]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 1800);
  };

  // Tauri's webview does NOT implement window.prompt / confirm / alert, so those
  // calls silently no-op in the desktop build (the "新建环境/组 点了没反应" bug).
  // We provide promise-based replacements rendered as an in-app modal.
  type DialogState =
    | { kind: "prompt"; title: string; def: string; resolve: (v: string | null) => void }
    | { kind: "confirm"; title: string; message: string; resolve: (v: boolean) => void }
    | {
        kind: "envType";
        title: string;
        resolve: (v: { name: string; dbType: "mysql" | "redis" } | null) => void;
      }
    | null;
  const [dlg, setDlg] = useState<DialogState>(null);
  // Local state for the envType dialog (name + db_type picker).
  const [envDlgName, setEnvDlgName] = useState("");
  const [envDlgType, setEnvDlgType] = useState<"mysql" | "redis">("mysql");
  const promptAsync = (title: string, def = ""): Promise<string | null> =>
    new Promise((res) => setDlg({ kind: "prompt", title, def, resolve: res }));
  const confirmAsync = (message: string, title = "请确认"): Promise<boolean> =>
    new Promise((res) => setDlg({ kind: "confirm", title, message, resolve: res }));

  /// Pre-execution guardrail (whole-table UPDATE/DELETE protection).
  /// Asks the backend to scan the SQL for UPDATE/DELETE statements lacking a
  /// top-level WHERE/LIMIT; when any are found, pops a confirm dialog listing
  /// them. `ok=false` means "user cancelled — do not execute"; `allowRisky`
  /// must be forwarded to the backend so it accepts the confirmed write.
  const guardWriteConfirm = async (
    sql: string
  ): Promise<{ ok: boolean; allowRisky: boolean }> => {
    try {
      const risks = await api.guardWriteSql(sql);
      if (risks.length === 0) return { ok: true, allowRisky: false };
      const lines = risks
        .map((r) => `• ${r.kind === "deleteAll" ? "DELETE" : "UPDATE"}：${r.preview}`)
        .join("\n");
      const ok = await confirmAsync(
        `检测到 ${risks.length} 条无 WHERE/LIMIT 条件的语句，将对整表执行更新/删除操作：\n\n${lines}\n\n确认继续执行？`,
        "⚠️ 危险操作确认"
      );
      return { ok, allowRisky: ok };
    } catch {
      // Guard check is best-effort; the backend still rejects risky writes.
      return { ok: true, allowRisky: false };
    }
  };
  const promptEnvType = (
    title: string
  ): Promise<{ name: string; dbType: "mysql" | "redis" } | null> => {
    setEnvDlgName("");
    setEnvDlgType("mysql");
    return new Promise((res) => setDlg({ kind: "envType", title, resolve: res }));
  };

  // --- Knowledge base (ADR-AI-6) -----------------------------------------
  // Docs are plain text / Markdown bound to connections (whole connection) or to
  // a specific database. A doc can bind to many connections / databases (1:N:N).
  const [kbDocs, setKbDocs] = useState<KbDocDto[]>([]);
  const [kbEditing, setKbEditing] = useState<KbDocDto | null>(null);
  const [kbName, setKbName] = useState("");
  const [kbContent, setKbContent] = useState("");
  const [kbBindings, setKbBindings] = useState<KbBindingDto[]>([]);
  const [kbMsg, setKbMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Distinguishes "list empty state" from "actively creating a new draft" — both
  // have kbEditing=null and empty name/content, so we need an explicit flag or
  // clicking 新建知识库 looks like a no-op (it resets to the same empty state).
  const [kbIsNew, setKbIsNew] = useState(false);
  // Caches DB lists per connection so the binding editor's database dropdown
  // is populated lazily (an 8000-DB instance should not freeze the UI).
  const [kbDbCache, setKbDbCache] = useState<Record<string, string[]>>({});
  const [kbLoadingDbs, setKbLoadingDbs] = useState<string | null>(null);
  // Controlled selects for the "add a binding" row.
  const [kbNewConn, setKbNewConn] = useState("");
  const [kbNewDb, setKbNewDb] = useState("");

  const loadKbDocs = useCallback(async () => {
    try {
      setKbDocs(await api.listKbDocs());
    } catch (e) {
      showToast("加载知识库失败: " + String(e));
    }
  }, []);

  const loadKbDbs = useCallback(
    async (connId: string) => {
      if (kbDbCache[connId] || kbLoadingDbs === connId) return;
      setKbLoadingDbs(connId);
      try {
        const dbs = await api.listDatabases(connId);
        setKbDbCache((c) => ({ ...c, [connId]: dbs }));
      } catch {
        setKbDbCache((c) => ({ ...c, [connId]: [] }));
      } finally {
        setKbLoadingDbs(null);
      }
    },
    [kbDbCache, kbLoadingDbs]
  );

  const refreshKbEditing = useCallback(async (id: string) => {
    const fresh = (await api.listKbDocs()).find((d) => d.id === id);
    if (fresh) {
      setKbEditing(fresh);
      setKbName(fresh.name);
      setKbContent(fresh.content);
      setKbBindings(fresh.bindings.map((b) => ({ ...b })));
    }
  }, []);

  const startNewKb = () => {
    setKbIsNew(true);
    setKbEditing(null);
    setKbName("");
    setKbContent("");
    setKbBindings([]);
    setKbMsg(null);
  };

  const editKb = (doc: KbDocDto) => {
    setKbIsNew(false);
    setKbEditing(doc);
    setKbName(doc.name);
    setKbContent(doc.content);
    setKbBindings(doc.bindings.map((b) => ({ ...b })));
    setKbMsg(null);
  };

  const saveKbDoc = async () => {
    setKbMsg(null);
    const name = kbName.trim();
    if (!name) {
      setKbMsg({ ok: false, text: "请填写知识库名称" });
      return;
    }
    try {
      if (kbEditing) {
        await api.updateKbDoc(kbEditing.id, name, kbContent);
        await api.setKbBindings(
          kbEditing.id,
          kbBindings.map((b) => ({ conn_id: b.conn_id, database: b.database }))
        );
        await refreshKbEditing(kbEditing.id);
      } else {
        const id = await api.addKbDoc(name, kbContent);
        if (kbBindings.length > 0) {
          try {
            await api.setKbBindings(
              id,
              kbBindings.map((b) => ({ conn_id: b.conn_id, database: b.database }))
            );
            setKbMsg({ ok: true, text: "已创建并绑定" });
          } catch (e) {
            setKbMsg({ ok: false, text: "文档已创建，但绑定失败：" + String(e) });
          }
        } else {
          setKbMsg({ ok: true, text: "已创建" });
        }
        await refreshKbEditing(id);
        setKbIsNew(false);
      }
      await loadKbDocs();
      setKbMsg({ ok: true, text: kbEditing ? "已保存" : "已创建" });
    } catch (e) {
      setKbMsg({ ok: false, text: String(e) });
    }
  };

  const deleteKb = async (doc: KbDocDto) => {
    if (
      !(await confirmAsync(
        `确定删除知识库「${doc.name}」？相关绑定关系也会一并删除，且不可恢复。`,
        "删除知识库"
      ))
    )
      return;
    try {
      await api.deleteKbDoc(doc.id);
      showToast("已删除知识库「" + doc.name + "」");
      if (kbEditing && kbEditing.id === doc.id) {
        setKbIsNew(false);
        setKbEditing(null);
        setKbName("");
        setKbContent("");
        setKbBindings([]);
        setKbMsg(null);
      }
      await loadKbDocs();
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  const addKbBinding = (connId: string, database: string | null) => {
    if (!connId) return;
    setKbBindings((bs) => {
      if (bs.some((b) => b.conn_id === connId && b.database === database)) {
        showToast("该连接 / 数据库绑定已存在");
        return bs;
      }
      return [...bs, { conn_id: connId, database }];
    });
  };
  const removeKbBinding = (idx: number) => {
    setKbBindings((bs) => bs.filter((_, i) => i !== idx));
  };

  // Load knowledge-base docs whenever the user switches to the KB tab.
  useEffect(() => {
    if (settingsTab === "kb") void loadKbDocs();
  }, [settingsTab]);

  // --- Data Assistants (数据助手) state & handlers ---
  const [assistants, setAssistants] = useState<DataAssistant[]>([]);
  const [activeAssistant, setActiveAssistant] = useState<DataAssistant | null>(null);
  const [astEditing, setAstEditing] = useState<DataAssistant | null>(null);
  const [astIsNew, setAstIsNew] = useState(false);

  const loadAssistants = useCallback(async () => {
    try {
      const list = await api.listDataAssistants();
      setAssistants(list);
    } catch (e) {
      console.error("加载数据助手失败:", e);
    }
  }, []);

  useEffect(() => {
    void loadAssistants();
  }, [loadAssistants]);

  useEffect(() => {
    if (settingsTab === "assistant") {
      void loadAssistants();
      void loadKbDocs();
    }
  }, [settingsTab, loadAssistants, loadKbDocs]);

  const startNewAssistant = () => {
    setAstIsNew(true);
    setAstEditing(null);
  };

  const editAssistant = (a: DataAssistant) => {
    setAstIsNew(false);
    setAstEditing(a);
  };

  const saveAssistant = async (payload: DataAssistantInput) => {
    const saved = await api.saveDataAssistant(payload);
    await loadAssistants();
    setAstEditing(saved);
    setAstIsNew(false);
    if (activeAssistant?.id === saved.id) {
      setActiveAssistant(saved);
    }
  };

  const deleteAssistant = async () => {
    if (!astEditing) return;
    if (!confirm(`确定要删除数据助手「${astEditing.name}」吗？`)) return;
    try {
      await api.deleteDataAssistant(astEditing.id);
      if (activeAssistant?.id === astEditing.id) {
        setActiveAssistant(null);
      }
      setAstEditing(null);
      setAstIsNew(false);
      await loadAssistants();
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  // `val` may be a string (prompt), boolean (confirm), the envType payload
  // ({name, dbType}), or null — kept loosely typed because each dialog variant
  // only ever receives its own shape at runtime.
  const closeDlg = (val: any) => {
    setDlg((cur) => {
      if (cur) (cur.resolve as (v: any) => void)(val);
      return null;
    });
  };

  const onRowClick = (ri: number, e: ReactMouseEvent) => {
    setSelCell(null);
    if (e.shiftKey && selRows.size > 0) {
      const [a, b] = [lastAnchorRef.current, ri].sort((x, y) => x - y);
      const next = new Set<number>();
      for (let k = a; k <= b; k++) next.add(k);
      setSelRows(next);
    } else if (e.metaKey || e.ctrlKey) {
      setSelRows((prev) => {
        const n = new Set(prev);
        if (n.has(ri)) n.delete(ri);
        else n.add(ri);
        return n;
      });
      lastAnchorRef.current = ri;
    } else {
      setSelRows(new Set([ri]));
      lastAnchorRef.current = ri;
    }
  };

  // Begin a marquee drag from this row (left button only). Selection is NOT
  // changed here yet — a plain click still falls through to onRowClick, while
  // moving across rows (onRowMouseEnter) extends the range. Clicks inside an
  // editor input or the row delete button are ignored so editing isn't hijacked.
  const onRowMouseDown = (ri: number, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".cell-edit") || t.closest(".row-del-btn")) return;
    dragRef.current = { anchor: ri };
    setDragging(true);
  };

  // While dragging, every row the pointer enters extends the selection to the
  // range between the anchor and the hovered row.
  const onRowMouseEnter = (ri: number) => {
    if (!dragRef.current) return;
    const a = dragRef.current.anchor;
    const [lo, hi] = a <= ri ? [a, ri] : [ri, a];
    const next = new Set<number>();
    for (let k = lo; k <= hi; k++) next.add(k);
    setSelRows(next);
    lastAnchorRef.current = ri;
  };

  const onRowCtx = (ri: number, e: ReactMouseEvent) => {
    e.preventDefault();
    const eff = selRows.has(ri)
      ? Array.from(selRows).sort((a, b) => a - b)
      : [ri];
    setSelRows(new Set(eff));
    lastAnchorRef.current = ri;
    // Clamp to viewport so the menu never overflows off-screen.
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: eff });
  };

  // Click top-left corner (#) to toggle select all / deselect all.
  const onSelectAllClick = (viewRowsList: { origRi: number }[]) => {
    setSelCols(new Set());
    setSelCell(null);
    if (viewRowsList.length === 0) return;
    const allVis = viewRowsList.map((r) => r.origRi);
    const isAllSelected = allVis.every((ri) => selRows.has(ri));
    if (isAllSelected) {
      setSelRows(new Set());
    } else {
      setSelRows(new Set(allVis));
    }
  };

  // Right-click top-left corner (#) to select all and open row copy context menu.
  const onSelectAllCtx = (viewRowsList: { origRi: number }[], e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (viewRowsList.length === 0) return;
    const allVis = viewRowsList.map((r) => r.origRi);
    setSelRows(new Set(allVis));
    setSelCols(new Set());
    setSelCell(null);
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: allVis });
  };

  const copyRowsAs = async (kind: "json" | "insert" | "update" | "wherein" | "csv") => {
    if (!result || result.kind !== "table") return;
    const eff = ctxMenu?.rows ?? Array.from(selRows);
    const rows = eff
      .map((ri) => result.rows[ri])
      .filter(Boolean) as string[][];
    if (rows.length === 0) return;
    // Table name: prefer browse context, then try to parse it from the SQL's
    // FROM clause. If neither yields one (JOIN/UNION/subquery), use a
    // placeholder so the user can still get a template to edit.
    const table =
      browseCtx?.table ??
      extractTableFromSql(active?.sql ?? "") ??
      "<table>";
    let pks = result.primaryKeys ?? [];
    if (pks.length === 0) {
      const idCol = result.columns.find((c) => {
        const low = c.toLowerCase();
        return low === "id" || low.endsWith("_id");
      });
      if (idCol) pks = [idCol];
    }

    let text = "";
    if (kind === "json") text = rowsToJson(result.columns, rows);
    else if (kind === "insert")
      text = rowsToInsert(table, result.columns, rows);
    else if (kind === "csv") text = toCsv(result.columns, rows);
    else if (kind === "wherein") {
      // Use the column from context menu (right-clicked column header) or the
      // first currently selected column. Fall back to first column.
      const ci = ctxMenu?.col ?? (selCols.size > 0 ? Math.min(...selCols) : 0);
      const colName = result.columns[ci] ?? `col${ci + 1}`;
      text = rowsToWhereIn(colName, ci, rows);
    } else if (kind === "update") {
      text = rowsToUpdate(table, result.columns, pks, rows);
    }
    const copied = await copyText(text);
    if (copied) {
      showToast(
        `已复制 ${rows.length} 行 · ${
          kind === "json" ? "JSON" : kind === "insert" ? "INSERT" : kind === "update" ? "UPDATE" : kind === "csv" ? "CSV" : "WHERE IN"
        }`
      );
    } else {
      showToast("复制失败，请检查剪贴板权限");
    }
    setCtxMenu(null);
  };

  // Copy a single cell's exact displayed value to the clipboard. Reads the
  // edit overlay first (so an in-progress edit is copied), then the DB snapshot.
  const copyCell = async (ri: number, ci: number) => {
    if (!result || result.kind !== "table") return;
    const row = result.rows[ri];
    if (!row) return;
    const raw = (edits[ri]?.[ci] ?? row[ci]) ?? "";
    const text = fmtCell(raw);
    await copyText(text);
    const colName = result.columns[ci] ?? `#${ci + 1}`;
    showToast(`已复制单元格 · ${colName}`);
    setCtxMenu(null);
  };

  // Open a stable modal showing the full cell value. Used when the hover
  // tooltip is unreachable (e.g. Chat panel covers the grid).
  const openCellView = (ri: number, ci: number) => {
    if (!result || result.kind !== "table") return;
    const row = result.rows[ri];
    if (!row) return;
    const text = fmtCell((edits[ri]?.[ci] ?? row[ci]) ?? "");
    if (text === "") return;
    setCellView({ ri, ci, text });
    setCtxMenu(null);
  };

  // Single left-click on a data cell: select ONLY that cell. Row/column
  // selections are cleared so the highlight is unambiguous.
  const onCellClick = (ri: number, ci: number) => {
    setSelRows(new Set());
    setSelCols(new Set());
    setSelCell({ ri, ci });
  };

  // Right-click a field: pin the column (for "copy as JSON") and keep the row
  // selection behaviour identical to before — if the row isn't already in the
  // selection it becomes the sole selected row, so the row menu stays useful.
  const onCellCtx = (ri: number, ci: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSelCell({ ri, ci });
    const eff = selRows.has(ri)
      ? Array.from(selRows).sort((a, b) => a - b)
      : [ri];
    setSelRows(new Set(eff));
    lastAnchorRef.current = ri;
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows: eff, cell: { ri, ci } });
  };

  // Right-click a column header: if the column is part of the current
  // multi-selection keep the whole set, otherwise collapse to just that column
  // (same convention as rows). Row selection is left untouched so the user can
  // still copy rows from the same menu if any are selected.
  const onColCtx = (ci: number, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const eff = selCols.has(ci)
      ? Array.from(selCols).sort((a, b) => a - b)
      : [ci];
    setSelCols(new Set(eff));
    lastColAnchorRef.current = ci;
    const rows =
      selRows.size > 0 ? Array.from(selRows).sort((a, b) => a - b) : [];
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    setCtxMenu({ x, y, rows, col: ci });
  };

  // Left-click a column header. Plain click selects this one column.
  // Ctrl/Cmd+click toggles the column in the multi-select set.
  // Shift+click selects the anchor..clicked range.
  // Sorting is decoupled into the dedicated sort button to prevent accidental misclicks.
  const onColClick = (ci: number, e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelRows(new Set());
      setSelCell(null);
      setSelCols((prev) => {
        const n = new Set(prev);
        if (n.has(ci)) n.delete(ci);
        else n.add(ci);
        return n;
      });
      lastColAnchorRef.current = ci;
      return;
    }
    if (e.shiftKey && selCols.size > 0) {
      setSelRows(new Set());
      setSelCell(null);
      const [a, b] = [lastColAnchorRef.current, ci].sort((x, y) => x - y);
      const next = new Set<number>();
      for (let k = a; k <= b; k++) next.add(k);
      setSelCols(next);
      return;
    }
    setSelCols(new Set([ci]));
    setSelRows(new Set());
    setSelCell(null);
    lastColAnchorRef.current = ci;
  };

  // Toggle sort on column `ci`: none → asc → desc → none (cancel sort).
  const toggleColSort = (ci: number, e: ReactMouseEvent) => {
    e.stopPropagation();
    setGridSort((s) => {
      if (s?.col === ci) {
        if (s.dir === "asc") {
          return { col: ci, dir: "desc" };
        } else {
          return null;
        }
      }
      return { col: ci, dir: "asc" };
    });
  };

  // Right-click on active sort button immediately cancels sorting.
  const cancelColSort = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setGridSort(null);
  };

  // --- Column filter actions (#3) -----------------------------------------
  const opLabel = (op: string) =>
    ({
      contains: "包含",
      equals: "等于",
      nequals: "不等于",
      empty: "为空",
      notempty: "非空",
      range: "数值范围",
    } as Record<string, string>)[op] ?? op;

  // Open a prompt (or two for a range) and store the filter for column `ci`.
  const filterColByPrompt = async (ci: number, op: string) => {
    setCtxMenu(null);
    if (op === "empty" || op === "notempty") {
      setColFilters((f) => ({ ...f, [ci]: { op, val: "" } }));
      return;
    }
    if (op === "range") {
      const min = await promptAsync("数值范围 - 最小值（留空表示不限）");
      if (min === null) return;
      const max = await promptAsync("数值范围 - 最大值（留空表示不限）");
      if (max === null) return;
      if (min.trim() === "" && max.trim() === "") return;
      setColFilters((f) => ({ ...f, [ci]: { op, val: min.trim(), val2: max.trim() } }));
      return;
    }
    const val = await promptAsync(`筛选（${opLabel(op)}）输入匹配值`);
    if (val === null) return;
    setColFilters((f) => ({ ...f, [ci]: { op, val } }));
  };

  const clearColFilter = (ci: number) => {
    setColFilters((f) => {
      const n = { ...f };
      delete n[ci];
      return n;
    });
  };

  // Whether a single cell value matches a column filter.
  const matchesColFilter = (
    op: string,
    val: string,
    cell: string,
    val2?: string
  ): boolean => {
    const c = gridCase ? cell : cell.toLowerCase();
    const v = gridCase ? val : val.toLowerCase();
    switch (op) {
      case "contains":
        return c.includes(v);
      case "equals":
        return c === v;
      case "nequals":
        return c !== v;
      case "empty":
        return cell === "" || cell === "NULL";
      case "notempty":
        return !(cell === "" || cell === "NULL");
      case "range": {
        const n = Number(cell);
        if (Number.isNaN(n)) return false;
        const lo = val === "" ? -Infinity : Number(val);
        const hi = val2 === "" || val2 === undefined ? Infinity : Number(val2);
        return n >= lo && n <= hi;
      }
      default:
        return true;
    }
  };

  // Whether a row passes ALL active column filters + the global search.
  const rowMatches = (row: string[]): boolean => {
    for (const [ci, f] of Object.entries(colFilters)) {
      const ciN = Number(ci);
      if (ciN >= row.length) continue;
      if (!matchesColFilter(f.op, f.val ?? "", row[ciN], f.val2)) return false;
    }
    const q = gridSearch.trim();
    if (q) {
      const needle = gridCase ? q : q.toLowerCase();
      const hit = row.some((cell) => {
        const c = gridCase ? cell : cell.toLowerCase();
        return c.includes(needle);
      });
      if (!hit) return false;
    }
    return true;
  };

  // Copy the selected columns (Ctrl/Cmd+click headers to multi-select) in the
  // given format. `cols` are sorted result-column indices. JSON keeps the old
  // single-column shape (a bare typed array) and switches to row objects once
  // more than one column is selected; CSV keeps the header; TSV is bare values
  // for pasting straight into Excel; "names" copies just the column names.
  const copyColsAs = async (kind: "json" | "csv" | "tsv" | "names") => {
    if (!result || result.kind !== "table") return;
    const cols = Array.from(selCols)
      .sort((a, b) => a - b)
      .filter((ci) => ci < result.columns.length);
    if (cols.length === 0) return;
    const names = cols.map((ci) => result.columns[ci] ?? `#${ci + 1}`);
    let text = "";
    if (kind === "names") {
      text = names.join(", ");
    } else if (kind === "tsv") {
      // Flatten tabs/newlines inside values so a cell never breaks the row.
      text = result.rows
        .map((r) =>
          cols
            .map((ci) => fmtCell(r[ci] ?? "").replace(/\t|\r?\n/g, " "))
            .join("\t")
        )
        .join("\n");
    } else {
      const projected = result.rows.map((r) =>
        cols.map((ci) => r[ci] ?? "")
      );
      if (kind === "csv") {
        text = toCsv(names, projected);
      } else if (cols.length === 1) {
        // Single column keeps the old bare typed-array shape.
        text = JSON.stringify(
          projected.map((r) => {
            const v = r[0];
            const low = v.toLowerCase();
            if (v === "NULL") return null;
            if (low === "true") return true;
            if (low === "false") return false;
            if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
            return v;
          }),
          null,
          2
        );
      } else {
        text = rowsToJson(names, projected);
      }
    }
    await copyText(text);
    showToast(
      kind === "names"
        ? `已复制 ${cols.length} 个列名`
        : `已复制 ${cols.length} 列 · ${result.rows.length} 行 · ${
            kind === "json" ? "JSON" : kind === "csv" ? "CSV" : "Tab 分隔"
          }`
    );
    setCtxMenu(null);
  };

  // Ctrl/Cmd+A in the result grid selects every row (unless focus is in the
  // editor, where it should select editor text instead).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        result?.kind === "table" &&
        !editing
      ) {
        const ae = document.activeElement as HTMLElement | null;
        const inEditor =
          !!ae && (!!ae.closest(".editor-host") || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
        if (!inEditor) {
          e.preventDefault();
          setSelRows(new Set(result.rows.map((_, i) => i)));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, editing]);

  // Flat lookup of connections across the tree model.
  const findConn = useCallback(
    (id: string): ConnSummary | undefined => {
      for (const env of tree.environments) {
        for (const g of env.groups) {
          const hit = g.connections.find((c) => c.id === id);
          if (hit) return hit;
        }
      }
      return undefined;
    },
    [tree]
  );

  /// Redis mode: when the active tab is connected to a Redis instance,
  /// the center area switches to a key-browser + console UI instead of
  /// the SQL editor + result grid (ADR-025 Phase A2).
  const isRedisConn = active?.connId
    ? findConn(active.connId)?.db_type === "redis"
    : false;

  /// Human labels for a SQL reference. Resolving the connection id here (not
  /// at capture time) means a renamed connection shows its new name, and a
  /// deleted one degrades to "未知连接" instead of a bare uuid.
  const refLabel = useCallback(
    (r: SqlReference) => {
      const c = findConn(r.conn_id);
      let scopeText = "单条语句";
      if (r.scope === "full") scopeText = "整个查询";
      else if (r.scope === "selection") scopeText = "选中语句";
      return {
        icon: c?.db_type === "redis" ? "🔴" : "🐬",
        name: c?.name ?? "未知连接",
        db: r.db || "默认库",
        scope: scopeText,
      };
    },
    [findConn],
  );

  // Flat connection list (for the history/snippet connection filter).
  const allConns = useMemo(() => {
    const out: ConnSummary[] = [];
    for (const env of tree.environments)
      for (const g of env.groups) out.push(...g.connections);
    return out;
  }, [tree]);

  const setActiveTab = (updater: (t: QueryTab) => QueryTab) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabIdRef.current ? updater(t) : t))
    );
  };

  const refresh = useCallback(async () => {
    const t = await api.listTree();
    setTree(t);
    if (!selId) {
      const first = t.environments[0]?.groups[0]?.connections[0];
      if (first) setSelId(first.id);
    }
  }, [selId]);

  const loadSchema = useCallback(
    async (id: string, db?: string | null) => {
      const conn = findConn(id);
      if (!conn || conn.db_type !== "mysql") {
        editorRef.current?.setSchemaContext(null, null);
        return;
      }
      // No eager full-schema fetch. Completion is fetched lazily by name
      // prefix (bounded) as the user types — see editor.ts schemaCompleter.
      // This is what stopped an 8000-table database from freezing the UI the
      // moment it was selected.
      editorRef.current?.setSchemaContext(id, db ?? null);
    },
    [findConn]
  );

  // Keep the editor's autocomplete schema in sync with the ACTIVE TAB's
  // connection and database (Phase 26: per-tab context). Re-runs whenever the
  // active tab's connection or database changes.
  const loadSchemaRef = useRef(loadSchema);
  loadSchemaRef.current = loadSchema;
  useEffect(() => {
    if (active?.connId) loadSchemaRef.current(active.connId, active.db);
  }, [active?.connId, active?.db]);

  // Build a status-bar entry from a finished query result + elapsed ms.
  // Errors arrive as a `redis` result with `note` set (errOut), so we detect
  // them by runtime shape, not by a separate type union.
  const runStatFor = (
    r: QueryOutput | null,
    ms: number
  ): { kind: "ok" | "err" | "warn" | "info"; text: string } => {
    if (!r) return { kind: "ok", text: `✓ ${ms}ms · 执行完成` };
    if ("rows" in r) {
      // Write statements (UPDATE/INSERT/DELETE/...): no result set, but the
      // backend reports rows_affected / last_insert_id — show that instead of
      // a misleading "返回 0 行".
      if (r.affected != null) {
        const id =
          r.lastInsertId != null && r.lastInsertId > 0 ? ` · 自增ID ${r.lastInsertId}` : "";
        return { kind: "ok", text: `✓ ${ms}ms · 影响 ${r.affected} 行${id}` };
      }
      const n = r.rows.length;
      const trunc = "truncated" in r && r.truncated;
      if (r.total != null && r.total > n) {
        return {
          kind: "ok",
          text: `✓ ${ms}ms · 第 ${(r.page ?? 0) + 1} 页 / 共 ${r.total} 行`,
        };
      }
      return {
        kind: trunc ? "warn" : "ok",
        text: `✓ ${ms}ms · 返回 ${n} 行${trunc ? " (已截断, 请加 LIMIT)" : ""}`,
      };
    }
    if (r.kind === "redis") {
      if (r.note) return { kind: "err", text: `✗ ${ms}ms · ${r.note}` };
      return { kind: "ok", text: `✓ ${ms}ms · Redis 结果` };
    }
    return { kind: "ok", text: `✓ ${ms}ms · 执行完成` };
  };

  const runQuery = useCallback(async (forceFull = false) => {
    const t = active;
    if (!t?.connId) {
      setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const fullDoc = editor.getDoc();
    const q = forceFull ? fullDoc : sel || fullDoc;
    if (!q.trim()) return;
    // 选中执行 = 实际执行的只是选中的片段。此时额外把编辑器完整内容也存
    // 一条版本，保证"一键还原完整脚本"始终可用。完整内容先记录（rowid 更
    // 小），实际执行的选中片段后记录，仍是组头显示的最新一条。
    const ranSelection = !!sel && q.trim() !== fullDoc.trim();
    // Whole-table UPDATE/DELETE guardrail: confirm before running.
    const g = await guardWriteConfirm(q);
    if (!g.ok) return;
    clearEditState();
    setResultTab("data");
    setRunInfo(null);
    setRunning(true);
    setMultiResults(null);
    setMultiResultIdx(0);
    const t0 = performance.now();
    try {
      // ③ Multi-result-set: split by `;` and execute each statement. If only
      // one statement is present, the behaviour is identical to before — no
      // sub-tabs, no overhead. Multiple statements run sequentially and each
      // result set gets its own sub-tab.
      const stmts = splitStatements(q);
      if (stmts.length > 1) {
        if (ranSelection) void api.logQuery(t.connId, t.db, fullDoc, t.qid);
        const results: QueryOutput[] = [];
        let lastError: string | null = null;
        for (let si = 0; si < stmts.length; si++) {
          const stmt = stmts[si];
          try {
            const r = await api.executeQuery(t.connId, stmt, t.db, 0, pageSize, g.allowRisky);
            results.push(r);
          } catch (e) {
            results.push(errOut(String(e)));
            lastError = String(e);
            // Continue to the next statement — one failure shouldn't abort
            // the whole batch. The user sees which statement failed in its
            // sub-tab.
          }
          void api.logQuery(t.connId, t.db, stmt, t.qid);
        }
        // 除逐条记录外，把整个查询脚本也作为一条历史存档——载入时能
        // 一键还原完整的多语句批次，而不用从历史里逐条拼回。
        void api.logQuery(t.connId, t.db, q, t.qid);
        const ms = Math.round(performance.now() - t0);
        const first = results[0];
        setActiveTab((tab) => ({ ...tab, sql: q, result: first, browseCtx: null }));
        setMultiResults(results);
        setMultiResultIdx(0);
        const affected = results.reduce<number>(
          (s, x) => s + ("affected" in x && x.affected ? x.affected : 0),
          0
        );
        const affText = affected > 0 ? ` · 共影响 ${affected} 行` : "";
        setRunInfo(
          lastError
            ? { kind: "warn", text: `⚠ ${ms}ms · ${results.length} 条语句 · 含错误` }
            : { kind: "ok", text: `✓ ${ms}ms · ${results.length} 条语句执行完成${affText}` }
        );
      } else {
        const r = await api.executeQuery(t.connId, q, t.db, 0, pageSize, g.allowRisky);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((tab) => ({ ...tab, sql: q, result: r, browseCtx: null }));
        if (ranSelection) void api.logQuery(t.connId, t.db, fullDoc, t.qid);
        void api.logQuery(t.connId, t.db, q, t.qid);
        setRunInfo(runStatFor(r, ms));
      }
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({
        ...tab,
        result: errOut(String(e)),
        browseCtx: null,
      }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active, pageSize]);

  // Re-run the *currently displayed* SQL at a given page (pager navigation for
  // ad-hoc query results). Uses the tab's stored `sql` — i.e. the last executed
  // statement — not the editor buffer, so paging never picks up unsaved edits.
  // `size` lets the page-size selector pass an explicit size; otherwise the
  // current `pageSize` state is used.
  const runQueryAt = useCallback(async (page: number, size?: number) => {
    const t = active;
    if (!t?.connId) return;
    const q = t.sql;
    if (!q.trim()) return;
    const sz = size ?? pageSize;
    setRunning(true);
    setRunInfo(null);
    setMultiResults(null);
    setMultiResultIdx(0);
    const t0 = performance.now();
    try {
      const r = await api.executeQuery(t.connId, q, t.db, page, sz);
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, result: r, browseCtx: null }));
      setRunInfo(runStatFor(r, ms));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setActiveTab((tab) => ({ ...tab, result: errOut(String(e)), browseCtx: null }));
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active, pageSize]);

  // Run an arbitrary SQL on an explicit connection/database and show the result
  // in the active tab's result pane. Powers "run this referenced SQL" from a
  // chat ref card (on the ref's OWN connection, not the panel-bound one) and
  // the "问 AI：运行并分析" editor action — reusing the same backend exec path
  // as `runQuery`.
  const runSqlExplicit = useCallback(
    async (connId: string, sql: string, db: string | null) => {
      if (!connId) {
        setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
        return;
      }
      if (!sql.trim()) return;
      // Whole-table UPDATE/DELETE guardrail: confirm before running.
      const g = await guardWriteConfirm(sql);
      if (!g.ok) return;
      clearEditState();
      setResultTab("data");
      setRunInfo(null);
      setRunning(true);
      setMultiResults(null);
      setMultiResultIdx(0);
      const t0 = performance.now();
      try {
        const r = await api.executeQuery(connId, sql, db, 0, pageSize, g.allowRisky);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((tab) => ({ ...tab, sql, result: r, browseCtx: null }));
        void api.logQuery(connId, db, sql, active?.qid ?? null);
        setRunInfo(runStatFor(r, ms));
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        setActiveTab((tab) => ({ ...tab, result: errOut(String(e)), browseCtx: null }));
        setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
      } finally {
        setRunning(false);
      }
    },
    [pageSize, active?.qid],
  );

  // 一键执行 AI 回复里的写语句（消息 SQL 代码块上的「执行」按钮）。走同一条
  // 护栏：整表 UPDATE/DELETE 先弹危险确认；执行成功 toast 影响行数并记入
  // 查询历史，失败 toast 错误并把按钮复位可重试。结果不入对话上下文——
  // AI 并不知道你手动执行了，需要它感知时继续对话说明即可。
  const execChatWriteSql = async (
    connId: string,
    db: string | null,
    sql: string
  ) => {
    if (!connId) {
      showToast("这条回复缺少连接信息，请导入查询后手动执行");
      return;
    }
    const g = await guardWriteConfirm(sql);
    if (!g.ok) return;
    try {
      const r = await api.executeQuery(connId, sql, db, 0, 50, g.allowRisky);
      const affected = "affected" in r && r.affected != null ? r.affected : null;
      showToast(
        affected != null ? `✓ 已执行 · 影响 ${affected} 行` : "✓ 已执行"
      );
      void api.logQuery(connId, db, sql);
    } catch (e) {
      showToast("✗ 执行失败: " + String(e));
      throw e;
    }
  };

  // Keep a live ref so the editor's run-key (registered once) always calls the
  // latest `runQuery` closure with the current selected connection.
  const runQueryRef = useRef<(forceFull?: boolean) => void>(() => {});
  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  /// Build the SQL-editor right-click menu (Navicat-style). `hasSel` reflects
  /// whether text is selected and gates the selection-only commands.
  /// Stage editor SQL on the chat composer (ADR: Chat 引用 SQL, 方案 B).
  ///
  /// `scope: "statement"` snaps to `;` boundaries so the model never receives
  /// half a statement; `"full"` takes the whole tab. The reference carries the
  /// *tab's* connection/db, which is deliberately not the chat panel's binding
  /// — asking about a prod query while the chat sits on staging must not
  /// silently retarget the SQL.
  ///
  /// `prompt` pre-fills the input only when it is empty, so a half-typed
  /// question is never clobbered.
  const attachSqlRef = (scope: "statement" | "selection" | "full", prompt?: string) => {
    const ed = editorRef.current;
    const t = active;
    if (!ed || !t) return;

    const sel = ed.getSelection().trim();
    let sql = "";
    let actualScope: "statement" | "selection" | "full" = scope;

    if (scope === "full") {
      sql = ed.getDoc().trim();
      actualScope = "full";
    } else if (scope === "selection") {
      sql = sel || ed.getStatement().trim();
      actualScope = sel ? "selection" : "statement";
    } else {
      // "statement"
      if (sel) {
        sql = sel;
        actualScope = "selection";
      } else {
        sql = ed.getStatement().trim();
        actualScope = "statement";
      }
    }

    if (!sql) {
      showToast("没有可引用的 SQL");
      return;
    }
    if (!t.connId) {
      showToast("请先为当前查询选择连接 / 数据库");
      return;
    }

    const ref: SqlReference = {
      conn_id: t.connId,
      tab_id: t.id,
      db: t.db ?? null,
      scope: actualScope,
      sql,
    };

    // 将编辑器的数据库与连接信息同步到 Chat 会话
    setChatConnId(t.connId);
    setChatDb(t.db ?? null);

    setPendingRefs((prev) =>
      prev.some(
        (r) =>
          r.sql === ref.sql &&
          r.conn_id === ref.conn_id &&
          r.db === ref.db &&
          r.scope === ref.scope,
      )
        ? prev
        : [...prev, ref],
    );
    setChatOpen(true);
    localStorage.setItem("cq_chat_open", "1");

    const connName = findConn(t.connId)?.name ?? "未知连接";
    const dbName = t.db || "默认库";
    const scopeDesc =
      actualScope === "full"
        ? "整个查询"
        : actualScope === "selection"
        ? "选中的单条 SQL"
        : "当前单条 SQL";
    showToast(`已将【${connName} · ${dbName}】的${scopeDesc}引用到 Chat`);

    // The panel may be mounting this same tick; reach for its textarea after.
    window.setTimeout(() => {
      const input = document.getElementById(
        "chat-input",
      ) as HTMLTextAreaElement | null;
      if (!input) return;
      if (prompt && !input.value.trim()) input.value = prompt;
      input.focus();
    }, 0);
  };

  const buildEditorMenu = (hasSel: boolean): MenuItem[] => {
    const ed = editorRef.current;
    return [
      // 运行类操作放最前：右键菜单的最高频动作。
      { type: "item", label: "运行已选择", disabled: !hasSel, onClick: () => runQueryRef.current() },
      { type: "item", label: "运行全部", onClick: () => runQueryRef.current(true) },
      { type: "sep" },
      { type: "item", label: "格式化 SQL", onClick: () => ed?.formatSql() },
      { type: "item", label: "注释 / 取消注释", onClick: () => ed?.toggleComment() },
      { type: "item", label: "转换为大写", disabled: !hasSel, onClick: () => ed?.changeCase(true) },
      { type: "item", label: "转换为小写", disabled: !hasSel, onClick: () => ed?.changeCase(false) },
      { type: "sep" },
      // "引用" only stages the SQL; the three verbs additionally pre-fill a
      // question. Both paths go through the same reference, so the chat log
      // always shows exactly what the model got.
      {
        type: "item",
        label: hasSel ? "💬 引用选中语句到 Chat" : "💬 引用当前语句到 Chat",
        onClick: () => attachSqlRef(hasSel ? "selection" : "statement"),
      },
      {
        type: "item",
        label: "💬 引用整个查询到 Chat",
        onClick: () => attachSqlRef("full"),
      },
      {
        type: "item",
        label: "💬 问 AI：解释这段 SQL",
        onClick: () =>
          attachSqlRef(
            hasSel ? "selection" : "statement",
            "请解释这段 SQL 的执行逻辑与潜在问题。",
          ),
      },
      {
        type: "item",
        label: "💬 问 AI：优化这段 SQL",
        onClick: () =>
          attachSqlRef(
            hasSel ? "selection" : "statement",
            "请分析这段 SQL 的性能瓶颈并给出优化建议（含索引建议）。",
          ),
      },
      {
        type: "item",
        label: "💬 问 AI：运行并分析这段 SQL",
        onClick: () => {
          const sql = (
            hasSel
              ? editorRef.current?.getSelection()
              : editorRef.current?.getStatement()
          )?.trim() ?? "";
          if (sql && active.connId) void runSqlExplicit(active.connId, sql, active.db);
          attachSqlRef(
            hasSel ? "selection" : "statement",
            "请分析这段 SQL 的执行计划与运行结果（结果已在右侧结果区展示），指出性能瓶颈与优化方向。",
          );
        },
      },
      { type: "sep" },
      // 剪贴板 / 编辑类低频操作归入末尾分组。
      { type: "item", label: "撤销", onClick: () => ed?.undo() },
      { type: "item", label: "重做", onClick: () => ed?.redo() },
      { type: "sep" },
      { type: "item", label: "剪切", disabled: !hasSel, onClick: () => ed?.cut() },
      { type: "item", label: "复制", disabled: !hasSel, onClick: () => ed?.copy() },
      { type: "item", label: "粘贴", onClick: () => void ed?.paste() },
      { type: "item", label: "删除", disabled: !hasSel, onClick: () => ed?.deleteSelection() },
      { type: "sep" },
      { type: "item", label: "全选", onClick: () => ed?.selectAll() },
    ];
  };

  const explainQuery = useCallback(async () => {
    const t = active;
    if (!t?.connId) {
      setRunInfo({ kind: "warn", text: "请先选择连接 / 数据库" });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection().trim();
    const q = sel || editor.getDoc();
    if (!q.trim()) return;
    clearEditState();
    setExplainView(null);
    setResultTab("explain");
    setRunInfo(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      const v = await api.explainVisual(t.connId, q, t.db);
      const ms = Math.round(performance.now() - t0);
      setExplainView(v);
      // Keep the raw plan also available as the textual result for reference.
      if (v.format === "legacy") {
        setActiveTab((tab) => ({
          ...tab,
          result: { kind: "redis", command: "EXPLAIN", lines: (v.raw ?? "").split("\n"), note: "EXPLAIN（legacy 文本）", truncated: false },
          browseCtx: null,
        }));
      }
      setRunInfo({ kind: "ok", text: `✓ ${ms}ms · 执行计划已生成（${v.format}）` });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setExplainView(null);
      setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [active]);

  const selectConn = (id: string) => {
    setSelId(id);
    setSelDb(null);
  };

  // Selecting a database node in the tree only records the "intended" context
  // (selDb / selId). It is inherited by freshly created queries, but it never
  // switches an existing query tab's connection/db (Phase 26). The editor
  // schema is driven by the ACTIVE TAB, not by this global state.
  const onSelectDb = useCallback((connId: string, db: string) => {
    setSelDb(db);
    setSelId((prev) => (prev === connId ? prev : connId));
  }, []);

  const browseTable = useCallback(
    async (
      connId: string,
      db: string,
      table: string,
      page: number = 0,
      pageSize: number = PAGE_SIZE
    ) => {
      clearEditState();
      setResultTab("data");
      setSelDb(db);
      setMultiResults(null);
      setMultiResultIdx(0);
      const t0 = performance.now();
      try {
        const r = await api.browseTable(connId, db, table, page, pageSize);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({
          ...t,
          result: r,
          browseCtx: { connId, db, table, page, pageSize },
        }));
        setRunInfo(runStatFor(r, ms));
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
        setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
      }
    },
    []
  );

  // Page-size selector in the pager. For ad-hoc results we re-run the displayed
  // SQL at page 0 with the new size; for table browse we re-browse with it.
  // The size is passed explicitly so we don't read the not-yet-updated
  // `pageSize` state via a stale closure.
  const changePageSize = (v: number) => {
    setPageSize(v);
    if (browseCtx) {
      void browseTable(browseCtx.connId, browseCtx.db, browseCtx.table, 0, v);
    } else {
      void runQueryAt(0, v);
    }
  };

  // Pager navigation: table browse uses browseTable, ad-hoc query results use
  // runQueryAt (re-runs the displayed SQL at the requested page).
  const goPage = (p: number) => {
    if (!result || result.kind !== "table" || result.total == null) return;
    const ps = browseCtx?.pageSize ?? pageSize;
    const totalPages = Math.max(1, Math.ceil(result.total / ps));
    const np = Math.min(Math.max(0, p), totalPages - 1);
    if (browseCtx) {
      void browseTable(browseCtx.connId, browseCtx.db, browseCtx.table, np, ps);
    } else {
      void runQueryAt(np);
    }
  };

  const pager =
    result && result.kind === "table" && result.total != null ? (
      (() => {
        const ps = browseCtx?.pageSize ?? pageSize;
        const totalPages = Math.max(1, Math.ceil(result.total / ps));
        const cur = result.page ?? 0;
        const doJump = () => {
          const n = parseInt(jumpPage, 10);
          if (!Number.isNaN(n)) goPage(n - 1);
          setJumpPage("");
        };
        return (
          <div className="pager">
            <button disabled={cur <= 0} onClick={() => goPage(cur - 1)}>
              上一页
            </button>
            <span className="pager-info">
              第 {cur + 1} / {totalPages} 页 · 共 {result.total} 行
            </span>
            <button disabled={cur + 1 >= totalPages} onClick={() => goPage(cur + 1)}>
              下一页
            </button>
            <span className="pager-sep" />
            <label className="pager-size">
              每页
              <select
                value={ps}
                onChange={(e) => changePageSize(Number(e.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              行
            </label>
            <span className="pager-jump">
              跳至
              <input
                type="number"
                min={1}
                max={totalPages}
                value={jumpPage}
                onChange={(e) => setJumpPage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doJump();
                }}
                className="pager-jump-input"
              />
              页
              <button onClick={doJump}>跳转</button>
            </span>
            {ps > 200 && (
              <span className="pager-warn">
                ⚠ 每页 {ps} 行：结果集较大，内存与渲染开销升高
              </span>
            )}
          </div>
        );
      })()
    ) : null;

  const browseRedisKey = useCallback(
    async (connId: string, db: number, key: string) => {
      clearEditState();
      setResultTab("data");
      setMultiResults(null);
      setMultiResultIdx(0);
      const t0 = performance.now();
      try {
        const r = await api.browseRedisKey(connId, db, key);
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: r, browseCtx: null }));
        setRunInfo(runStatFor(r, ms));
      } catch (e) {
        const ms = Math.round(performance.now() - t0);
        setActiveTab((t) => ({ ...t, result: errOut(String(e)), browseCtx: null }));
        setRunInfo({ kind: "err", text: `✗ ${ms}ms · ${String(e)}` });
      }
    },
    []
  );

  // Fetch and display the full table structure (columns, indexes, DDL) in
  // the result panel. Replaces the data grid view until the user navigates
  // away (browse/query/tab switch all clear it via clearEditState).
  const showStructure = useCallback(
    async (connId: string, db: string, table: string) => {
      clearEditState();
      try {
        const data = await api.describeTable(connId, db, table);
        setStructureView({ connId, db, table, data });
        setResultTab("structure");
      } catch (e) {
        // Keep the data grid; surface the failure in the status bar instead of
        // blowing away the result panel.
        setRunInfo({ kind: "err", text: "加载表结构失败: " + String(e) });
      }
    },
    []
  );

  // Fetch and display all FK relationships in a database (ADR-021). Shows a
  // table of child→parent column mappings grouped by constraint name.
  const showRelationships = useCallback(
    async (connId: string, db: string) => {
      clearEditState();
      try {
        const fks = await api.listRelationships(connId, db);
        setRelationshipView({ connId, db, fks });
        setResultTab("relation");
      } catch (e) {
        setRunInfo({ kind: "err", text: "加载表关系失败: " + String(e) });
      }
    },
    []
  );

  // Result-sub-tab navigation: switch to a view, fetching its data lazily from
  // the currently browsed table when the cached view is absent.
  const gotoStructure = () => {
    if (structureView) {
      setResultTab("structure");
      return;
    }
    if (browseCtx) void showStructure(browseCtx.connId, browseCtx.db, browseCtx.table);
  };
  const gotoRelation = () => {
    if (relationshipView) {
      setResultTab("relation");
      return;
    }
    if (browseCtx) void showRelationships(browseCtx.connId, browseCtx.db);
  };

  // --- Inline edit handlers (ADR-018) --------------------------------------
  // Commit the in-progress cell edit into the `edits` overlay. The displayed
  // value falls back to the DB snapshot when no overlay entry exists, so the
  // WHERE clause always uses original primary-key values.
  const commitCell = () => {
    if (!editing) return;
    setEdits((prev) => {
      const row = { ...(prev[editing.ri] ?? {}) };
      row[editing.ci] = draft;
      return { ...prev, [editing.ri]: row };
    });
    setEditing(null);
  };

  // Persist all pending changes: UPDATEs (edits minus deleted rows), INSERTs
  // (new rows), then DELETEs (marked rows). Order matters: skip edits on rows
  // that are also marked for deletion — there's no point updating a row we're
  // about to delete. Any failure stops and keeps the overlays so the user can
  // fix and retry.
  const handleSaveEdit = async () => {
    if (!browseCtx || !result || result.kind !== "table" || !result.primaryKeys) return;
    const pkIdx = result.primaryKeys
      .map((pk) => result.columns.indexOf(pk))
      .filter((i) => i >= 0);
    try {
      // 1. UPDATEs — skip rows also marked for deletion.
      for (const riStr of Object.keys(edits)) {
        const ri = Number(riStr);
        if (deletes.has(ri)) continue;
        const row = result.rows[ri];
        if (!row) continue;
        const pk = pkIdx.map((ci) => ({ col: result.columns[ci], val: row[ci] }));
        const set = Object.entries(edits[ri]).map(([ciStr, v]) => ({
          col: result.columns[Number(ciStr)],
          val: v,
        }));
        if (set.length === 0) continue;
        await api.applyEdit({
          connId: browseCtx.connId,
          database: browseCtx.db,
          table: browseCtx.table,
          pk,
          set,
        });
      }
      // 2. INSERTs — omit empty cells so DB defaults apply.
      for (const insertRow of inserts) {
        const values = Object.entries(insertRow)
          .map(([ciStr, v]) => ({ col: result.columns[Number(ciStr)], val: v }))
          .filter((v) => v.val !== "");
        if (values.length === 0) continue;
        await api.insertRow(
          browseCtx.connId,
          browseCtx.db,
          browseCtx.table,
          values
        );
      }
      // 3. DELETEs — locate by original PK snapshot.
      for (const ri of deletes) {
        const row = result.rows[ri];
        if (!row) continue;
        const pk = pkIdx.map((ci) => ({ col: result.columns[ci], val: row[ci] }));
        await api.deleteRow(browseCtx.connId, browseCtx.db, browseCtx.table, pk);
      }
      clearEditState();
      await browseTable(
        browseCtx.connId,
        browseCtx.db,
        browseCtx.table,
        browseCtx.page,
        browseCtx.pageSize
      );
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };

  const handleUndoEdit = () => clearEditState();

  // Toggle a row's deletion mark. A row marked for deletion is struck-through
  // and excluded from UPDATEs at save time.
  const toggleDelete = (ri: number) => {
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
  };

  // Append a blank insert row. The user fills in cells; empty cells are omitted
  // from the eventual INSERT so DB defaults (AUTO_INCREMENT etc) apply.
  const addInsertRow = () => {
    setInserts((prev) => [...prev, {}]);
  };

  // Remove a pending insert row (before it's committed).
  const removeInsertRow = (ii: number) => {
    setInserts((prev) => prev.filter((_, i) => i !== ii));
  };

  // Update a cell in a pending insert row.
  const setInsertCell = (ii: number, ci: number, val: string) => {
    setInserts((prev) => {
      const next = [...prev];
      next[ii] = { ...(next[ii] ?? {}), [ci]: val };
      return next;
    });
  };

  // Render the result grid. When `editable`, cells become double-click-to-edit
  // with dirty highlighting; rows get a delete toggle; and a "new row" is
  // appended at the bottom for INSERT. Otherwise it's a plain read-only table
  // (or Redis lines). Primary-key columns are tagged with a key glyph.
  const renderData = () => {
    const fmt = fmtCell;
    if (running) return <div className="empty">执行中…</div>;
    if (!result) return <div className="empty">执行查询以查看结果</div>;
    if (result.kind === "redis") {
      // ADR-025 Phase A1: when browsing a single key, `value` is populated with
      // a structured view — render a type-aware viewer.  Fall back to flat lines
      // for ad-hoc queries (backward-compatible).
      if (result.value) {
        return (
          <RedisValueViewer
            value={result.value}
            ttl={result.ttl}
            size={result.size}
          />
        );
      }
      return (
        <div className="redis-result">
          {result.lines.map((l, i) => (
            <div key={i} className="redis-line">
              {l}
            </div>
          ))}
          {result.note && (
            <div
              className={
                "redis-note" +
                (result.lines.length === 0 ? " redis-error" : "")
              }
            >
              <span>{result.note}</span>
              {result.lines.length === 0 && (
                <button
                  type="button"
                  className="btn-diagnose-fix"
                  onClick={() => diagnoseSqlError(active?.sql, result.note)}
                  title="让 AI 分析该报错原因并提供修复 SQL"
                >
                  💡 AI 诊断并修复
                </button>
              )}
            </div>
          )}
        </div>
      );
    }
    if (result.kind !== "table") {
      return (
        <div className="empty">未知结果类型：{String((result as any).kind)}</div>
      );
    }
    const cols = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const pkSet = new Set(
      Array.isArray(result.primaryKeys) ? result.primaryKeys : []
    );
    if (cols.length === 0) {
      // Write statement: no result set, but the backend reported
      // rows_affected / last_insert_id — render a completion card instead of
      // a bare "无结果集".
      if (result.affected != null) {
        const id =
          result.lastInsertId != null && result.lastInsertId > 0
            ? result.lastInsertId
            : null;
        return (
          <div className="write-done">
            <div className="write-icon">✓</div>
            <div className="write-title">写操作执行成功</div>
            <div className="write-detail">
              {id != null ? (
                <>
                  影响 <b>{result.affected}</b> 行 · 自增ID <b>{id}</b>
                </>
              ) : (
                <>
                  影响 <b>{result.affected}</b> 行
                </>
              )}
            </div>
            <div className="write-hint">语句已提交，可执行 SELECT 验证结果</div>
          </div>
        );
      }
      return <div className="empty">无结果集</div>;
    }

    // --- #3: filter / search / sort on the in-memory page only ----------
    // `viewRows` carries the ORIGINAL row index so edits/deletes still map to
    // the real row even after sorting/filtering.
    let viewRows: { origRi: number; row: string[] }[] = rows.map((row, ri) => ({
      origRi: ri,
      row,
    }));
    if (Object.keys(colFilters).length > 0 || gridSearch.trim()) {
      viewRows = viewRows.filter(({ row }) => rowMatches(row));
    }
    if (gridSort) {
      const ci = gridSort.col;
      const dir = gridSort.dir === "asc" ? 1 : -1;
      viewRows = [...viewRows].sort((a, b) => {
        const av = a.row[ci] ?? "";
        const bv = b.row[ci] ?? "";
        const an = Number(av);
        const bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn) && av !== "" && bv !== "") {
          return (an - bn) * dir;
        }
        const ad = Date.parse(av);
        const bd = Date.parse(bv);
        if (!Number.isNaN(ad) && !Number.isNaN(bd) && av !== "" && bv !== "") {
          return (ad - bd) * dir;
        }
        return av.localeCompare(bv) * dir;
      });
    }

    // --- Transpose View (inspired by DBX) ----------------------------------
    if (isTransposed && viewRows.length > 0) {
      const activeIdx = Math.min(Math.max(0, transposeRowIdx), viewRows.length - 1);
      const activeRowObj = viewRows[activeIdx];
      const activeRow = activeRowObj.row;
      const origRi = activeRowObj.origRi;

      const filteredCols = cols
        .map((c, i) => ({ colName: c, colIdx: i, val: activeRow[i] }))
        .filter(({ colName }) =>
          !transposeFilter.trim() || colName.toLowerCase().includes(transposeFilter.toLowerCase())
        );

      return (
        <div className="transpose-container">
          <div className="transpose-toolbar">
            <div className="transpose-nav">
              <button
                disabled={activeIdx <= 0}
                onClick={() => setTransposeRowIdx(activeIdx - 1)}
                title="查看上一条数据"
                className="transpose-nav-btn"
              >
                ◀ 上一条
              </button>
              <span className="transpose-pos">
                第 <b>{activeIdx + 1}</b> / {viewRows.length} 条
                <span className="transpose-orig-idx">（原始行 #{origRi + 1}）</span>
              </span>
              <button
                disabled={activeIdx >= viewRows.length - 1}
                onClick={() => setTransposeRowIdx(activeIdx + 1)}
                title="查看下一条数据"
                className="transpose-nav-btn"
              >
                下一条 ▶
              </button>
            </div>
            <div className="transpose-search">
              <input
                placeholder="筛选字段名…"
                value={transposeFilter}
                onChange={(e) => setTransposeFilter(e.target.value)}
                className="transpose-filter-input"
              />
              {transposeFilter && (
                <button
                  className="clear-filter"
                  onClick={() => setTransposeFilter("")}
                  title="清空字段过滤"
                  style={{ marginLeft: 4 }}
                >
                  ×
                </button>
              )}
            </div>
            <div className="transpose-hint">
              双击单元格查看完整内容 · 右键复制
            </div>
          </div>
          <div className="transpose-table-wrap">
            <table className="transpose-table">
              <thead>
                <tr>
                  <th style={{ width: "48px" }}>#</th>
                  <th style={{ width: "220px" }}>字段名</th>
                  <th>字段值</th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.map(({ colName, colIdx, val }, idx) => {
                  const isPk = pkSet.has(colName);
                  const ov = edits[origRi]?.[colIdx];
                  const rawVal = ov ?? val;
                  const text = fmt(rawVal);
                  const cls = getCellStyleClass(text, rawVal);
                  return (
                    <tr key={colIdx} className="transpose-row">
                      <td className="row-num">{idx + 1}</td>
                      <td className={"transpose-col-name" + (isPk ? " pk" : "")}>
                        <span>{colName}</span>
                        {isPk && <span className="th-pk-badge" title="主键">🔑</span>}
                      </td>
                      <td
                        className="transpose-col-val"
                        onDoubleClick={() => openCellView(origRi, colIdx)}
                        onContextMenu={(e) => onCellCtx(origRi, colIdx, e)}
                        title="双击查看完整内容 · 右键复制"
                      >
                        {cls ? <span className={cls}>{text}</span> : text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return (
      <>
      <table className={"result-table" + (dragging ? " selecting" : "")}>
        <thead>
          <tr>
            {(() => {
              const allVis = viewRows.map((r) => r.origRi);
              const isAllSelected = allVis.length > 0 && allVis.every((ri) => selRows.has(ri));
              return (
                <th
                  className={"row-num row-num-header" + (isAllSelected ? " all-selected" : "")}
                  onClick={() => onSelectAllClick(viewRows)}
                  onContextMenu={(e) => onSelectAllCtx(viewRows, e)}
                  title={
                    isAllSelected
                      ? "已全选表格 · 点击取消全选 · 右键复制所有行"
                      : "点击全选整个表格 · 右键复制所有行"
                  }
                >
                  {isAllSelected ? "✓" : "#"}
                </th>
              );
            })()}
            {editable && <th className="row-action-col" />}
            {cols.map((c, i) => {
              const isSorted = gridSort?.col === i;
              const sortDir = isSorted ? gridSort.dir : null;
              const sortTitle = !isSorted
                ? "点击按此列升序排序"
                : sortDir === "asc"
                ? "当前升序 · 点击切换为降序 (右键直接取消)"
                : "当前降序 · 点击取消排序";

              return (
                <th
                  key={i}
                  className={
                    (pkSet.has(c) ? "pk " : "") +
                    (selCols.has(i) ? "col-selected " : "") +
                    (isSorted ? "col-sorted " : "") +
                    (colFilters[i] ? "col-filtered " : "")
                  }
                  onClick={(e) => onColClick(i, e)}
                  onContextMenu={(e) => onColCtx(i, e)}
                  title="点击选中列 · Ctrl+点击多选 · Shift+点击范围选 · 右键列操作"
                >
                  <div className="th-cell">
                    <span className="th-text" title={c}>{c}</span>
                    {pkSet.has(c) ? <span className="th-pk-badge" title="主键">🔑</span> : null}
                    <button
                      type="button"
                      className={`th-sort-btn ${isSorted ? "active " + sortDir : ""}`}
                      onClick={(e) => toggleColSort(i, e)}
                      onContextMenu={(e) => {
                        if (isSorted) cancelColSort(e);
                      }}
                      title={sortTitle}
                      aria-label={sortTitle}
                    >
                      {sortDir === "asc" ? (
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                          <path d="M4 10.5L8 5.5l4 5H4z" />
                        </svg>
                      ) : sortDir === "desc" ? (
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                          <path d="M4 5.5L8 10.5l4-5H4z" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                          <path d="M4.5 6.5L8 3l3.5 3.5h-7zM11.5 9.5L8 13l-3.5-3.5h7z" />
                        </svg>
                      )}
                    </button>
                    {colFilters[i] ? <span className="filter-dot" title="已筛选">⚲</span> : null}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {viewRows.map(({ origRi: ri, row }, vi) => {
            const isDeleted = deletes.has(ri);
            return (
              <tr
                key={ri}
                className={
                  (isDeleted ? "row-deleted " : "") +
                  (selRows.has(ri) ? "row-selected" : "")
                }
              >
                <td
                  className="row-num"
                  onMouseDown={(e) => onRowMouseDown(ri, e)}
                  onMouseEnter={() => onRowMouseEnter(ri)}
                  onClick={(e) => onRowClick(ri, e)}
                  onContextMenu={(e) => onRowCtx(ri, e)}
                  title="当前显示顺序行号 · 点击选中整行 · 右键复制行"
                >
                  {vi + 1}
                </td>
                {editable && (
                  <td className="row-action-col">
                    <button
                      className="row-del-btn"
                      title={isDeleted ? "取消删除" : "标记删除"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDelete(ri);
                      }}
                    >
                      {isDeleted ? "↩" : "×"}
                    </button>
                  </td>
                )}
                {row.map((v, ci) => {
                  const ov = edits[ri]?.[ci];
                  const isEditing =
                    editing?.ri === ri && editing?.ci === ci && !isDeleted;
                  const isCellSel =
                    selCell?.ri === ri && selCell?.ci === ci;
                  return (
                    <td
                      key={ci}
                      className={
                        (ov !== undefined ? "dirty " : "") +
                        (editable && !isDeleted ? "editable " : "") +
                        (selCols.has(ci) ? "col-selected " : "") +
                        (isCellSel ? "cell-selected " : "")
                      }
                      title={
                        editable && !isDeleted
                          ? "单击选中单元格 · 双击编辑 · 右键复制 · 双击查看完整内容"
                          : "单击选中单元格 · 右键复制 · 双击查看完整内容"
                      }
                      onMouseEnter={(e) => {
                        const t = e.currentTarget as HTMLTableCellElement;
                        if (t.scrollWidth > t.clientWidth + 1) {
                          cancelCellTipHide();
                          const r = t.getBoundingClientRect();
                          // Anchor just below the cell so the tip is visible
                          // without the cursor having to leave the cell.
                          setCellTip({
                            text: String(ov ?? v ?? ""),
                            x: r.left,
                            y: r.bottom + 6,
                            maxW: r.width,
                          });
                        }
                      }}
                      onMouseLeave={() => scheduleCellTipHide()}
                      onClick={() => onCellClick(ri, ci)}
                      onContextMenu={(e) => onCellCtx(ri, ci, e)}
                      onDoubleClick={() => {
                        if (editable && !isDeleted) {
                          setCtxMenu(null);
                          setEditing({ ri, ci });
                          setDraft(v);
                        } else {
                          openCellView(ri, ci);
                        }
                      }}
                    >
                      {isEditing ? (
                        <input
                          className="cell-edit"
                          autoFocus
                          value={draft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitCell}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCell();
                            else if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (() => {
                        const raw = ov ?? v;
                        const text = fmt(raw);
                        const cls = getCellStyleClass(text, raw);
                        return cls ? <span className={cls}>{text}</span> : text;
                      })()}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {inserts.map((ins, ii) => (
            <tr key={"ins-" + ii} className="row-insert">
              <td className="row-num" title="新增行">·</td>
              <td className="row-action-col">
                <button
                  className="row-del-btn"
                  title="移除新增行"
                  onClick={() => removeInsertRow(ii)}
                >
                  ×
                </button>
              </td>
              {cols.map((_, ci) => (
                <td key={ci} className="insert-cell">
                  <input
                    className="cell-edit"
                    placeholder="—"
                    value={ins[ci] ?? ""}
                    onChange={(e) => setInsertCell(ii, ci, e.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid-status">
        显示 {viewRows.length} / 共 {rows.length} 行
        {Object.keys(colFilters).length > 0 && " · 已按列筛选"}
        {gridSort && (
          <span className="grid-status-sort">
            {" "}· 已按「{cols[gridSort.col]}」{gridSort.dir === "asc" ? "升序" : "降序"}
            <button
              type="button"
              className="clear-sort-btn"
              onClick={() => setGridSort(null)}
              title="取消排序并恢复原顺序"
            >
              取消排序
            </button>
          </span>
        )}
      </div>
      </>
    );
  };

  // Render the table structure view (ADR-020): a columns table (like
  // DESCRIBE), an indexes table (grouped by index name), and the DDL in a
  // scrollable <pre>. Shown in place of the data grid when `structureView`
  // is set.
  const renderStructure = () => {
    if (!structureView) return null;
    const { data, db, table } = structureView;

    // Group index entries by index name — SHOW INDEX returns one row per
    // (index, column), so we aggregate columns and preserve uniqueness.
    const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
    for (const idx of data.indexes) {
      const e = idxMap.get(idx.name) ?? { columns: [], unique: idx.unique };
      e.columns.push(idx.column);
      idxMap.set(idx.name, e);
    }

    return (
      <div className="structure-view">
        <table className="result-table struct-table">
          <caption>{db}.{table} — 列结构</caption>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Null</th>
              <th>Key</th>
              <th>Default</th>
              <th>Extra</th>
            </tr>
          </thead>
          <tbody>
            {data.columns.map((c, i) => (
              <tr key={i}>
                <td className="col-name">{c.name}</td>
                <td className="col-type">{c.column_type}</td>
                <td>{c.nullable ? "YES" : "NO"}</td>
                <td>{c.key || "—"}</td>
                <td>{c.default ?? "—"}</td>
                <td>{c.extra || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {idxMap.size > 0 && (
          <table className="result-table struct-table">
            <caption>索引</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
              </tr>
            </thead>
            <tbody>
              {[...idxMap.entries()].map(([name, e]) => (
                <tr key={name}>
                  <td className="col-name">{name}</td>
                  <td>{e.columns.join(", ")}</td>
                  <td>{e.unique ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="ddl-section">
          <div className="ddl-head">DDL — SHOW CREATE TABLE</div>
          <pre className="ddl-block">{data.create_sql}</pre>
        </div>
      </div>
    );
  };

  // Render the ER / table-relationship view (ADR-021): a table of all FK
  // constraints in the database, showing child table.column → parent
  // table.column. Grouped by constraint name for readability.
  const renderRelationships = () => {
    if (!relationshipView) return null;
    const { db, fks } = relationshipView;
    if (fks.length === 0) {
      return (
        <div className="structure-view">
          <div className="empty">{db} 中没有外键关系</div>
        </div>
      );
    }
    // Group by constraint name to show composite FKs together.
    const grouped = new Map<string, ForeignKeyInfo[]>();
    for (const fk of fks) {
      const arr = grouped.get(fk.constraint_name) ?? [];
      arr.push(fk);
      grouped.set(fk.constraint_name, arr);
    }
    return (
      <div className="structure-view">
        <table className="result-table struct-table">
          <caption>{db} — 外键关系 ({fks.length} 条)</caption>
          <thead>
            <tr>
              <th>Constraint</th>
              <th>子表</th>
              <th>子列</th>
              <th>→</th>
              <th>父表</th>
              <th>父列</th>
            </tr>
          </thead>
          <tbody>
            {fks.map((fk, i) => (
              <tr key={i}>
                <td className="col-name">{fk.constraint_name}</td>
                <td>{fk.table_name}</td>
                <td>{fk.column_name}</td>
                <td className="fk-arrow">→</td>
                <td>{fk.referenced_table}</td>
                <td>{fk.referenced_column}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  // Render the EXPLAIN execution-plan tree (#6): a nested tree of table accesses
  // coloured by scan type, plus a flame-style horizontal bar per node by cost.
  const renderExplain = (v: ExplainVisual) => {
    // Colour a node by its access type (ALL / index / range / ref / const ...).
    const scanClass = (t: string) => {
      switch (t) {
        case "ALL":
          return "scan-all";
        case "index":
          return "scan-index";
        case "range":
        case "index_merge":
          return "scan-range";
        case "ref":
        case "ref_or_null":
        case "unique_subquery":
        case "index_subquery":
          return "scan-ref";
        case "eq_ref":
          return "scan-eqref";
        case "const":
        case "system":
          return "scan-const";
        default:
          return "scan-other";
      }
    };
    // Maximum cost across the whole tree, to scale the flame bars.
    const maxCost = (() => {
      let m = 0;
      const walk = (ns: ExplainNode[]) => {
        for (const n of ns) {
          if (n.cost > m) m = n.cost;
          walk(n.children);
        }
      };
      walk(v.nodes);
      return m || 1;
    })();
    const renderNode = (n: ExplainNode, depth: number): JSX.Element => (
      <div key={n.name + depth + (n.key || "")} className="explain-node">
        <div className="explain-row">
          <span className={"explain-scan " + scanClass(n.access_type)}>
            {n.access_type || "—"}
          </span>
          <span className="explain-name">{n.name}</span>
          {n.key && <span className="explain-key">key={n.key}</span>}
          <span className="explain-meta">rows={n.rows}</span>
          <span className="explain-meta">cost={Number(n.cost).toFixed(2)}</span>
          {n.extra && <span className="explain-extra">{n.extra}</span>}
          {/* Flame bar: width proportional to this node's cost. */}
          <span className="explain-flame">
            <span
              className={"explain-flame-bar " + scanClass(n.access_type)}
              style={{ width: `${Math.max(2, (n.cost / maxCost) * 100)}%` }}
            />
          </span>
        </div>
        {n.children.length > 0 && (
          <div className="explain-children">
            {n.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
    return (
      <div className="explain-view">
        {v.nodes.length === 0 && (
          <div className="empty">解析到的执行计划为空（可能是非 SELECT 语句）</div>
        )}
        {v.nodes.map((n) => renderNode(n, 0))}
        {v.format === "legacy" && v.raw && (
          <pre className="explain-raw">{v.raw}</pre>
        )}
      </div>
    );
  };

  const insertColumn = useCallback((name: string) => {
    editorRef.current?.insert(name);
  }, []);

  const insertText = useCallback((text: string) => {
    editorRef.current?.insert(text);
  }, []);

  // --- Tab management -------------------------------------------------------
  const switchTab = (id: string) => {
    if (id === activeTabId) return;
    activeTabIdRef.current = id;
    setActiveTabId(id);
    clearEditState();
    const t = tabs.find((x) => x.id === id);
    if (t) editorRef.current?.replaceValue(t.sql);
  };

  // `newTab` accepts an explicit connection/database so a "new query" spawned
  // from a tree node binds to that exact context (Phase 26). Called with no
  // args it inherits the current tree selection (selId / selDb).
  const newTab = (connId?: string, db?: string | null) => {
    const id = genTabId();
    const n = tabs.length + 1;
    const cid = connId ?? selId;
    const cdb = db !== undefined ? db : selDb;
    setTabs((prev) => [
      ...prev,
      {
        id,
        name: "查询 " + n,
        sql: "",
        result: null,
        browseCtx: null,
        connId: cid,
        db: cdb,
        qid: genQid(),
      },
    ]);
    activeTabIdRef.current = id;
    setActiveTabId(id);
    clearEditState();
    editorRef.current?.replaceValue("");
    editorRef.current?.view.focus();
  };

  // "New query" spawned from a tree node: select that connection and open a
  // fresh tab bound to the node's connection + database.
  const onNewQuery = (connId: string, db: string | null) => {
    setSelId(connId);
    newTab(connId, db);
  };

  // Open the database-switch popup for the active tab. The popup shows the
  // connection hierarchy (env → group → conn) and fetches a connection's
  // database list only when the connection is expanded — nothing is cached
  // globally.
  const openDbPicker = (onSelect?: (connId: string, db: string | null) => void) => {
    setDbPickerCallback(() => onSelect ?? null);
    setDbPickerOpen(true);
  };
  const changeTabContext = (connId: string, db: string | null) => {
    setActiveTab((t) => ({ ...t, connId, db }));
    setDbPickerOpen(false);
  };
  // Chat's own conn / db context, independent of the active SQL tab.
  // The composer + menu's "选择数据库" updates this state without
  // touching the SQL tab's context at all (the original behaviour
  // routed the picker's onSelect through changeTabContext, which made
  // the SQL tab's title bar / status bar jump on every pick).
  // Initialized lazily from `selId` on first render so the chat starts
  // pointed at the same connection the user has in the tree.
  const [chatConnId, setChatConnId] = useState<string | null>(null);
  const [chatDb, setChatDb] = useState<string | null>(null);
  /// Files attached to the next chat turn (.md / .txt / .json / .csv / .log
  /// — anything readTextFile can swallow). Read once on attach, kept in
  /// memory for the lifetime of the session, cleared the moment we send the
  /// turn (same lifecycle as `pendingRefs` and `pendingConvRefs`).
  const [chatAttachments, setChatAttachments] = useState<
    { id: string; name: string; content: string; size: number }[]
  >([]);
  const onChatConnChange = (connId: string, db: string | null) => {
    setChatConnId(connId);
    setChatDb(db);
    setDbPickerOpen(false);
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (id === activeTabId) {
      const next = tabs[idx === 0 ? 1 : idx - 1];
      activeTabIdRef.current = next.id;
      setActiveTabId(next.id);
      clearEditState();
      editorRef.current?.replaceValue(next.sql);
    }
  };

  /// 将代码块中的 SQL 一键导入到查询中（相同数据库实例追加在末尾，否则新建查询）。
  /// `binding` 是消息上记录的库上下文（AI 回复时用的连接/库）——优先于当前
  /// Chat 绑定，这样重开应用后从历史消息导入 SQL 仍能直接定位到当初的库。
  const handleImportToEditor = useCallback(
    (sqlText: string, binding?: ChatDbBinding) => {
      if (!sqlText || !sqlText.trim()) {
        showToast("代码块内容为空");
        return;
      }
      const sql = sqlText.trim();
      const targetConnId = binding?.conn_id || chatConnId || active?.connId || selId || "";
      const targetDb = binding
        ? binding.db
        : chatDb !== undefined
        ? chatDb
        : (active?.db ?? selDb ?? null);

      // 寻找相同数据库实例的已有查询标签页
      // 优先级：
      // 1. 当前 active 标签页连接与库均匹配
      // 2. 其他标签页中连接与库完全匹配
      // 3. 当前 active 标签页连接匹配
      // 4. 其他标签页中相同连接匹配
      let targetTab: QueryTab | null = null;
      if (targetConnId) {
        if (active && active.connId === targetConnId && (!targetDb || active.db === targetDb)) {
          targetTab = active;
        } else {
          const exactMatch = tabs.find(
            (t) => t.connId === targetConnId && (targetDb ? t.db === targetDb : true)
          );
          if (exactMatch) {
            targetTab = exactMatch;
          } else if (active && active.connId === targetConnId) {
            targetTab = active;
          } else {
            targetTab = tabs.find((t) => t.connId === targetConnId) || null;
          }
        }
      }

      if (targetTab) {
        // 存在相同数据库实例的查询：在最后追加
        const currentSql =
          targetTab.id === activeTabIdRef.current
            ? (editorRef.current?.getDoc() ?? targetTab.sql)
            : targetTab.sql;
        const trimmed = currentSql.trim();
        const newDoc = trimmed ? `${trimmed}\n\n${sql}\n` : `${sql}\n`;

        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTab.id
              ? { ...t, sql: newDoc, db: t.db || targetDb }
              : t
          )
        );

        if (targetTab.id !== activeTabIdRef.current) {
          activeTabIdRef.current = targetTab.id;
          setActiveTabId(targetTab.id);
          clearEditState();
        }

        editorRef.current?.replaceValue(newDoc);
        editorRef.current?.view.focus();

        if (editorRef.current?.scrollToBottom) {
          editorRef.current.scrollToBottom();
        } else {
          const ed = editorRef.current?.editor;
          if (ed && typeof ed.getModel === "function") {
            const model = ed.getModel();
            if (model) {
              const lineCount = model.getLineCount();
              ed.revealLine(lineCount);
              ed.setPosition({
                lineNumber: lineCount,
                column: model.getLineMaxColumn(lineCount),
              });
            }
          }
        }

        showToast(`已追加到「${targetTab.name}」末尾`);
      } else {
        // 不存在相同实例的查询：建一个新的，包含数据库连接和 SQL
        const id = genTabId();
        const n = tabs.length + 1;
        const newDoc = `${sql}\n`;
        const newTabObj: QueryTab = {
          id,
          name: "查询 " + n,
          sql: newDoc,
          result: null,
          browseCtx: null,
          connId: targetConnId,
          db: targetDb,
          qid: genQid(),
        };

        setTabs((prev) => [...prev, newTabObj]);
        activeTabIdRef.current = id;
        setActiveTabId(id);
        clearEditState();
        editorRef.current?.replaceValue(newDoc);
        editorRef.current?.view.focus();

        showToast(
          targetConnId
            ? `已新建「${newTabObj.name}」并导入 SQL`
            : `已新建「${newTabObj.name}」并导入 SQL（未指定连接）`
        );
      }
    },
    [chatConnId, chatDb, active, selId, selDb, tabs, showToast, clearEditState]
  );

  /// 将代码块中的 SQL 在新标签页打开（不覆盖或追加到已有编辑器草稿中，保持独立）。
  const handleOpenInNewTab = useCallback(
    (sqlText: string, binding?: ChatDbBinding) => {
      if (!sqlText || !sqlText.trim()) {
        showToast("代码块内容为空");
        return;
      }
      const sql = sqlText.trim();
      const targetConnId = binding?.conn_id || chatConnId || active?.connId || selId || "";
      const targetDb = binding
        ? binding.db
        : chatDb !== undefined
        ? chatDb
        : (active?.db ?? selDb ?? null);

      const id = genTabId();
      const n = tabs.length + 1;
      const newDoc = `${sql}\n`;
      const newTabObj: QueryTab = {
        id,
        name: "查询 " + n,
        sql: newDoc,
        result: null,
        browseCtx: null,
        connId: targetConnId,
        db: targetDb,
        qid: genQid(),
      };

      setTabs((prev) => [...prev, newTabObj]);
      activeTabIdRef.current = id;
      setActiveTabId(id);
      clearEditState();
      setTimeout(() => {
        editorRef.current?.replaceValue(newDoc);
        editorRef.current?.view.focus();
      }, 30);

      showToast(
        targetConnId
          ? `已在新标签页「${newTabObj.name}」打开 SQL`
          : `已在新标签页「${newTabObj.name}」打开 SQL（未绑定连接）`
      );
    },
    [chatConnId, chatDb, active, selId, selDb, tabs, showToast, clearEditState]
  );

  // --- Inline AI Composer (Cmd+K) handlers --------------------------------
  const handleOpenInlineAi = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    const range = ed.getSelectionRange ? ed.getSelectionRange() : { from: 0, to: 0 };
    const cursor = ed.getCursorPosition ? ed.getCursorPosition() : 0;
    const from = range.from !== range.to ? range.from : cursor;
    const to = range.from !== range.to ? range.to : cursor;

    inlineAiSnapshotRef.current = {
      from,
      to,
      currentEnd: to,
      origText: sel,
      streamedText: "",
    };
    setInlineAiSelectedSql(sel);
    setInlineAiGenerated(false);
    setInlineAiGenerating(false);
    setInlineAiOpen(true);
  }, []);

  handleOpenInlineAiRef.current = handleOpenInlineAi;

  const handleInlineAiSubmit = async (promptText: string) => {
    const ed = editorRef.current;
    const snap = inlineAiSnapshotRef.current;
    if (!ed || !snap) return;

    setInlineAiGenerating(true);
    setInlineAiThinking(false);
    snap.streamedText = "";
    let rawBuffer = "";
    let curLen = 0;

    const targetConnId = active?.connId || chatConnId;
    const targetDb = active?.db ?? chatDb ?? null;

    try {
      await api.inlineGenerateSql(
        promptText,
        snap.origText,
        targetConnId,
        targetDb,
        (delta) => {
          rawBuffer += delta;
          const parsed = splitThinkContent(rawBuffer);
          setInlineAiThinking(parsed.isThinking);

          // 纯净 SQL 处理：彻底剥离可能存在的 ```sql 或 ``` 代码围栏
          let cleanSql = parsed.content.trimStart();
          if (cleanSql.startsWith("```")) {
            cleanSql = cleanSql.replace(/^```[a-zA-Z]*\r?\n?/, "");
          }
          if (cleanSql.endsWith("```")) {
            cleanSql = cleanSql.replace(/\r?\n?```$/, "");
          }

          // 只有真正产生 SQL 正文时，才往编辑器中写入（思考过程绝对不写入编辑器）
          if (cleanSql !== snap.streamedText) {
            snap.streamedText = cleanSql;
            ed.replaceRange(snap.from, snap.from + curLen, cleanSql);
            curLen = cleanSql.length;
            snap.currentEnd = snap.from + curLen;
          }
        }
      );
      setInlineAiGenerated(true);
    } catch (e) {
      showToast("生成失败: " + String(e));
    } finally {
      setInlineAiGenerating(false);
      setInlineAiThinking(false);
    }
  };

  const handleInlineAiAccept = () => {
    setInlineAiOpen(false);
    setInlineAiGenerated(false);
    inlineAiSnapshotRef.current = null;
    editorRef.current?.view.focus();
    showToast("✓ 已采纳生成的 SQL");
  };

  const handleInlineAiReject = () => {
    const ed = editorRef.current;
    const snap = inlineAiSnapshotRef.current;
    if (ed && snap) {
      ed.replaceRange(snap.from, snap.currentEnd, snap.origText);
    }
    setInlineAiOpen(false);
    setInlineAiGenerated(false);
    inlineAiSnapshotRef.current = null;
    editorRef.current?.view.focus();
    showToast("已撤销并恢复原始代码");
  };

  // --- SQL Error AI Quick Fix ---------------------------------------------
  const diagnoseSqlError = (failedSql?: string, errMsg?: string) => {
    const sql =
      failedSql ||
      editorRef.current?.getSelection().trim() ||
      editorRef.current?.getStatement().trim() ||
      active?.sql ||
      "";
    const err =
      errMsg ||
      (runInfo?.kind === "err" ? runInfo.text : "") ||
      (active?.result?.kind === "redis" ? active.result.note : "") ||
      "执行失败";

    if (!active?.connId) {
      showToast("请先选择数据库连接");
      return;
    }

    const ref: SqlReference = {
      conn_id: active.connId,
      tab_id: active.id,
      db: active.db ?? null,
      scope: "statement",
      sql: sql.trim(),
    };

    setChatConnId(active.connId);
    setChatDb(active.db ?? null);
    setPendingRefs([ref]);
    setChatOpen(true);
    localStorage.setItem("cq_chat_open", "1");

    const promptMsg = `执行这段 SQL 报错：\n\`\`\`\n${err}\n\`\`\`\n请帮我排查具体原因（比如列名拼写错误、表不存在、字段约束或语法问题），并直接给出修复后的完整 SQL。`;

    setTimeout(() => {
      const input = document.getElementById("chat-input") as HTMLTextAreaElement | null;
      if (input) {
        input.value = promptMsg;
        input.focus();
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 180) + "px";
      }
    }, 50);

    showToast("已将报错与 SQL 装配至 AI 诊断");
  };

  // --- Query history / saved snippets --------------------------------------
  const openHistory = async () => {
    try {
      setHistory(await api.listQueries());
      setHistoryOpen(true);
    } catch (e) {
      showToast("读取历史失败: " + String(e));
    }
  };

  const loadQuery = (item: QueryItem) => {
    // Restore the connection + database the query was logged under, so the
    // user lands back in the same context they ran it from. If the connection
    // has been deleted, fall back to loading only the SQL into the current tab.
    const conn = item.conn_id ? findConn(item.conn_id) : undefined;
    if (conn) setSelId(conn.id);
    setActiveTab((t) => ({
      ...t,
      sql: item.sql,
      connId: conn ? conn.id : t.connId,
      db: conn ? (item.db ?? "") : t.db,
      // Carry a snippet's name onto the tab so the title stays meaningful.
      ...(item.name ? { name: item.name } : {}),
    }));
    editorRef.current?.replaceValue(item.sql);
    editorRef.current?.view.focus();
    setHistoryOpen(false);
  };

  const saveSnippetFromItem = async (item: QueryItem) => {
    const name = await promptAsync("片段名称", item.name ?? "我的查询");
    if (!name || !name.trim()) return;
    try {
      // 已是片段 → 原地重命名；历史条目 → 复制为片段（新插命名行，不改
      // 原行）。原地提升会让该行脱离版本组，组头一走整组的版本展示就散了。
      await api.saveQuery(
        item.name ? item.id : null,
        name.trim(),
        item.sql,
        item.conn_id,
        item.db
      );
      setHistory(await api.listQueries());
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };

  const saveCurrentAsSnippet = async () => {
    const sql = editorRef.current?.getDoc() ?? "";
    if (!sql.trim()) return;
    const name = await promptAsync("片段名称", "我的查询");
    if (!name || !name.trim()) return;
    try {
      await api.saveQuery(null, name.trim(), sql, active.connId || selId || null, active.db);
      showToast("已保存为片段");
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };

  const deleteQueryItem = async (item: QueryItem) => {
    const hasVersions = (item.versions?.length ?? 0) > 0;
    if (
      !(await confirmAsync(
        hasVersions
          ? `删除该记录及其全部 ${item.versions!.length} 个历史版本？`
          : "删除该记录？"
      ))
    )
      return;
    try {
      await api.deleteQuery(item.id, item.group_id ?? null);
      setHistory(await api.listQueries());
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  /// Open the write-guardrail audit trail. Loaded on demand rather than kept
  /// in state: it's a rarely-opened forensic view, and the table only grows.
  const openAudit = async () => {
    setAuditOpen(true);
    try {
      setAuditRows(await api.listAuditLogs(200));
    } catch (e) {
      setAuditRows([]);
      showToast("读取审计日志失败: " + String(e));
    }
  };

  // --- Conversations (docs/chat-conversation-design.md) ----------------------

  /// Persisted messages -> transcript. Plan/ref cards carry their structured
  /// data in `meta` on the wire and are reconstructed for display here.
  const storedToChat = (msgs: StoredChatMessage[]): ChatItem[] =>
    msgs.map((m) => {
      if (m.role === "plan") {
        const meta = m.meta as { steps?: string[] } | null;
        return { role: "plan", content: m.content, steps: meta?.steps ?? [] };
      }
      if (m.role === "ref") {
        const meta = m.meta as { refs?: SqlReference[] } | null;
        return { role: "ref", content: m.content, refs: meta?.refs ?? [] };
      }
      if (m.role === "assistant") {
        const meta = m.meta as {
          usage?: TokenUsage;
          db_binding?: ChatDbBinding;
          plan?: string[];
          tools?: string[];
        } | null;
        return {
          role: "assistant",
          content: m.content,
          usage: meta?.usage,
          dbBinding: meta?.db_binding,
          plan: meta?.plan,
          tools: meta?.tools,
        };
      }
      return { role: m.role as ChatMessage["role"], content: m.content };
    });

  /// Refresh the selector list. With zero conversations (fresh install / all
  /// deleted) this creates the first "默认会话" so the UI always has a current
  /// one (§5.3). On the very first load (no active id yet) the most recent
  /// conversation's transcript is also fetched so the panel isn't empty.
  const loadConvs = useCallback(async () => {
    let list = await api.listConversations();
    if (list.length === 0) {
      await api.createConversation(selId || null);
      list = await api.listConversations();
    }
    setConvs(list);
    // Keep the active id valid: after a delete the first (most recently
    // updated) conversation becomes current; a fresh install gets the default.
    const cur = convIdRef.current;
    const next = cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null);
    const firstEver = cur === null && next !== null;
    setConvId(next);
    if (firstEver) {
      // Cold start: replay the default conversation so history survives a
      // window reload (§5.2 回放).
      try {
        const d = await api.getConversation(next, 0, 200);
        setChat(storedToChat(d.messages));
      } catch {
        // Fall through with an empty panel; the selector still works.
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  /// Load one conversation's transcript into the chat panel.
  const switchConv = useCallback(
    async (id: string) => {
      try {
        convIdRef.current = id;
        setConvId(id);
        setConvOpen(false);
        // A turn still streaming belongs to its old conversation; dropping the
        // snapshot here prevents it from being persisted under the new one.
        turnItemsRef.current = { convId: null, items: [] };
        setChat([]);
        const d = await api.getConversation(id, 0, 200);
        setChat(storedToChat(d.messages));
      } catch (e) {
        showToast("加载会话失败: " + String(e));
      }
    },
    [showToast],
  );

  /// Create a fresh conversation bound to the current connection and switch to
  /// it. The user can rename it later (hover 重命名).
  const newConv = async () => {
    try {
      const id = await api.createConversation(selId || null);
      // Update the ref *before* loadConvs: setState is async, and loadConvs'
      // validity check reads convIdRef — a stale value would switch right back
      // to the old conversation.
      convIdRef.current = id;
      setConvId(id);
      setConvOpen(false);
      turnItemsRef.current = { convId: null, items: [] };
      setChat([]);
      setPendingConvRefs([]);
      await loadConvs();
    } catch (e) {
      showToast("新建会话失败: " + String(e));
    }
  };

  const renameConv = async (c: ConversationSummary) => {
    const t = await promptAsync("会话标题", c.title || "新会话");
    if (t == null || !t.trim() || t.trim() === c.title) return;
    try {
      await api.renameConversation(c.id, t.trim());
      await loadConvs();
    } catch (e) {
      showToast("重命名失败: " + String(e));
    }
  };

  const deleteConv = async (c: ConversationSummary) => {
    if (!(await confirmAsync(`删除会话「${c.title}」？消息将一并删除。`))) return;
    try {
      const wasCurrent = convId === c.id;
      await api.deleteConversation(c.id);
      setConvOpen(false);
      if (wasCurrent) {
        turnItemsRef.current = { convId: null, items: [] };
        setChat([]);
        setPendingConvRefs([]);
      }
      const list = await loadConvs();
      // §5.1: deleting the current conversation falls back to the most recent
      // one — load its transcript so the panel isn't left empty.
      if (wasCurrent && list[0]) await switchConv(list[0].id);
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  /// First user message of a fresh conversation → auto title from its head
  /// (§5.2). Only fires for the default "新会话" title so user renames stick.
  const maybeAutoTitle = async (text: string) => {
    if (!convId) return;
    const c = convs.find((x) => x.id === convId);
    if (!c || c.title !== "新会话" || c.msg_count > 0) return;
    const head = text.trim().replace(/\s+/g, " ").slice(0, 24);
    if (!head) return;
    try {
      await api.renameConversation(convId, head);
      await loadConvs();
    } catch {
      // Best-effort: the conversation still works untitled.
    }
  };

  /// Display title of the active conversation for the selector button.
  const currentConvTitle = () => {
    if (!convId) return "—";
    return convs.find((c) => c.id === convId)?.title ?? "新会话";
  };

  /// Relative time for the selector rows (e.g. "5 分钟前" / "3 天前").
  const relTime = (ts: number) => {
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  };

  // Close the conversation selector on outside click / Escape.
  useEffect(() => {
    if (!convOpen) return;
    const onDown = (e: MouseEvent) => {
      if (convWrapRef.current && !convWrapRef.current.contains(e.target as Node)) {
        setConvOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConvOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [convOpen]);

  // Load the conversation list. Runs on mount (fresh install → auto-creates
  // the default conversation, §5.3) and again when the active connection
  // changes so new conversations bind to the newly selected one.
  useEffect(() => {
    loadConvs().catch((e) => showToast("加载会话失败: " + String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  // Load the user's vendor profiles + active LlmConfig on mount so the
  // composer's model dropdown is populated on first launch and the
  // active highlight survives restart. We sequence the two calls:
  // listModelAliases() may trigger a backend "reconcile" that rewrites
  // LlmConfig.vendor (e.g. from a legacy preset id to the migrated
  // profile id) — only after that completes should we read the (now
  // aligned) LlmConfig. If we read in parallel, the frontend sees the
  // pre-reconcile LlmConfig and the auto-save apply check
  // (`llmCfg.vendor === current.id`) keeps failing.
  useEffect(() => {
    (async () => {
      try {
        const list = await api.listModelAliases();
        setVendorProfiles(list);
        const cfg = await api.getLlmConfig();
        setLlmCfg(cfg);
      } catch (e) {
        showToast("加载模型配置失败: " + String(e));
      }
    })();
  }, []);

  /// Pick a conversation for an @-mention. `whole` = reference the session
  /// tail; otherwise open the message drill-down.
  const pickConvRef = (c: ConversationSummary, whole: boolean) => {
    setAtOpen(false);
    setConvMsgPick(null);
    const ta = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    if (ta) {
      const m = /@([^\s@]*)$/.exec(ta.value);
      if (m) {
        ta.value = ta.value.slice(0, m.index);
      }
    }
    if (whole) {
      setPendingConvRefs((prev) => [
        ...prev,
        {
          conv_id: c.id,
          scope: "session",
          message_id: null,
          title: c.title,
          preview: c.last_preview || c.title,
        },
      ]);
      return;
    }
    // Drill into the conversation's messages to pick one.
    setConvMsgPick(c);
    setConvMsgList([]);
    api
      .getConversation(c.id, 0, 100)
      .then((d) => setConvMsgList(d.messages))
      .catch((e) => showToast("加载消息失败: " + String(e)));
  };

  /// Stage a message-level reference card.
  const pickMsgRef = (c: ConversationSummary, m: StoredChatMessage) => {
    setConvMsgPick(null);
    setPendingConvRefs((prev) => [
      ...prev,
      {
        conv_id: c.id,
        scope: "message",
        message_id: m.id,
        title: c.title,
        preview:
          (m.role === "user" ? "用户: " : "AI: ") +
          (splitThinkContent(m.content || "").content || m.content || "").slice(0, 40),
      },
    ]);
  };

  /// Remove an @-mention card.
  const dropConvRef = (i: number) =>
    setPendingConvRefs((prev) => prev.filter((_, j) => j !== i));

  /// Selector rows: search-filtered, newest-first.
  const convFiltered = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const base = q
      ? convs.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.conn_name ?? "").toLowerCase().includes(q),
        )
      : convs;
    return [...base].sort((a, b) => b.updated - a.updated);
  }, [convs, convSearch]);

  /// @-mention candidates:
  /// 1. 数据助手 (Data Assistants)
  /// 2. 历史会话 (Conversations)
  const atAssistants = useMemo(() => {
    const f = atFilter.trim().toLowerCase();
    return assistants
      .filter((a) => !f || a.name.toLowerCase().includes(f) || a.description.toLowerCase().includes(f))
      .slice(0, 5);
  }, [assistants, atFilter]);

  const atConvs = useMemo(
    () =>
      convs
        .filter((c) => !atFilter || c.title.toLowerCase().includes(atFilter))
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 6),
    [convs, atFilter],
  );

  type AtCombinedItem =
    | { kind: "assistant"; item: DataAssistant }
    | { kind: "conv"; item: ConversationSummary };

  const atCombined = useMemo<AtCombinedItem[]>(() => {
    const out: AtCombinedItem[] = [];
    for (const a of atAssistants) {
      out.push({ kind: "assistant", item: a });
    }
    for (const c of atConvs) {
      out.push({ kind: "conv", item: c });
    }
    return out;
  }, [atAssistants, atConvs]);

  /// Composer typing: open the @-picker when "@" is typed at the end.
  const onChatInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const m = /@([^\s@]*)$/.exec(v);
    if (m) {
      setAtFilter(m[1].toLowerCase());
      setAtOpen(true);
      setAtIdx(0);
    } else {
      setAtOpen(false);
    }
  };
  /// Toolbar "+ → 引用会话": append "@" to the composer and focus it, so the
  /// existing onChatInput regex opens the at-picker. Avoids re-implementing
  /// the picker UI in the + menu.
  const triggerAtPicker = () => {
    const ta = document.getElementById("chat-input") as HTMLTextAreaElement | null;
    if (!ta) return;
    const needsSpace = ta.value.length > 0 && !ta.value.endsWith(" ") && !ta.value.endsWith("\n");
    const next = ta.value + (needsSpace ? " @" : "@");
    // Mutate the native input value, then fire React's onInput so its
    // onChatInput regex picks up the new trailing "@".
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(ta, next);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  };

  /// Composer keys:
  /// - While @-picker is open: arrows move, Enter picks, Escape closes.
  /// - Normal typing: Enter sends message directly, Shift+Enter inserts newline.
  ///   (IME composition events are ignored to prevent accidental sends during Chinese pinyin input).
  const onChatKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (atOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => Math.min(i + 1, Math.max(atCombined.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const sel = atCombined[atIdx];
        if (!sel) return;
        e.preventDefault();
        if (sel.kind === "assistant") {
          setActiveAssistant(sel.item);
        } else {
          pickConvRef(sel.item, true);
        }
        const ta = e.currentTarget;
        const m = /(?:^|\s)@[^\s@]*$/.exec(ta.value);
        if (m) ta.value = ta.value.slice(0, m.index);
        setAtOpen(false);
        setAtFilter("");
      } else if (e.key === "Escape") {
        e.preventDefault();
        setAtOpen(false);
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      void sendChat();
    }
  };

  const sendChat = async () => {
    const input = document.getElementById("chat-input") as HTMLTextAreaElement;
    const text = input.value;
    if (!text.trim() || streaming || sendingRef.current) return;

    // 数据库连接解析与降级检查：
    // 1. 若激活了数据助手且助手配置了关联数据库，优先使用助手绑定的数据库连接与具体库；
    // 2. 若数据助手未配置连接，则继承会话当前选择的连接与库 (chatConnId ?? selId, chatDb)；
    // 3. 若会话也尚未选择数据库连接，则拦截发送并友好提示！
    let targetConnId = chatConnId ?? selId;
    let targetDb = chatDb;
    if (activeAssistant && activeAssistant.bound_databases && activeAssistant.bound_databases.length > 0) {
      targetConnId = activeAssistant.bound_databases[0].conn_id;
      if (activeAssistant.bound_databases[0].database) {
        targetDb = activeAssistant.bound_databases[0].database;
      }
    }
    if (!targetConnId) {
      showToast(
        activeAssistant
          ? `「${activeAssistant.name}」未关联数据库，且当前会话尚未指定数据库。请先在会话指定数据库或在助手设置中关联数据库。`
          : "当前会话尚未指定数据库连接，请先在上方指定数据库。"
      );
      return;
    }

    sendingRef.current = true;
    // Snapshot the staged references and clear them immediately: they belong to
    // this turn only. Leaving them on the composer would silently re-attach the
    // same SQL to the next question.
    const refs = pendingRefs;
    setPendingRefs([]);
    // Same for @-mentions (P1): they travel with this turn's `conv_refs` and
    // are never replayed from history.
    const convRefs = pendingConvRefs;
    setPendingConvRefs([]);
    // Same for attachments: prepend the file contents to the user message
    // (the model sees it as part of the turn's context), then drop them
    // from the composer so the next question starts clean.
    const attachments = chatAttachments;
    setChatAttachments([]);
    const attText =
      attachments.length > 0
        ? attachments
            .map((a) => `--- 附件: ${a.name} ---\n${a.content}`)
            .join("\n\n") + "\n\n"
        : "";
    const finalText = attText + text;
    // First user message of a fresh conversation → auto title (§5.2).
    void maybeAutoTitle(text);
    // The reference card is display-only (`role: "ref"` has no Rust
    // counterpart) and is filtered out of the replayed history below — it
    // exists so the transcript shows what the model actually received.
    const next: ChatItem[] = [
      ...chat,
      ...(refs.length > 0
        ? [{ role: "ref" as const, content: "", refs }]
        : []),
      { role: "user" as const, content: finalText },
    ];
    setChat(next);
    input.value = "";
    setStreaming(true);
    setChat((prev) => [...prev, { role: "assistant", content: "" }]);
    // Stamp the conn/db this turn runs against — chat-done attaches it to the
    // final assistant message so the reply remembers its database context.
    turnBindingRef.current = { conn_id: targetConnId, db: targetDb };
    // §5.2 snapshot: everything this turn will append to the store. Plan cards
    // and token-streamed assistant text extend it via the event listeners.
    turnItemsRef.current = { convId, items: [...next, { role: "assistant", content: "" }] };
    try {
      // The chat log is a human transcript, not the model's context. Plan and
      // ref cards and tool breadcrumbs are display-only: neither `plan` nor
      // `ref` has a Rust `ChatRole`, and a `tool` message without its
      // originating `tool_call_id` makes the OpenAI API reject the whole
      // request. The model already saw the real tool results inside its own
      // turn, so only user/assistant text is replayed. Empty assistant
      // placeholders (the streaming bubble) are dropped too.
      const history: ChatMessage[] = [];
      for (const m of next) {
        if (m.role === "user") {
          history.push({ role: "user", content: m.content });
        } else if (m.role === "assistant") {
          const content = m.content.trim();
          if (content !== "") {
            history.push({ role: "assistant", content: m.content });
          } else if ((m.plan && m.plan.length > 0) || (m.tools && m.tools.length > 0)) {
            // 被取消或仅有执行步骤的 assistant 消息补充占位，保持严格交替并告知模型前置动作被中止
            history.push({ role: "assistant", content: "[该任务在执行步骤期间被用户中止或取消]" });
          }
        }
      }
      // The chat's conn context lives in `targetConnId` (inherited from assistant or session).
      turnIdRef.current = await chatTurn(
        targetConnId,
        targetDb,
        history,
        refs,
        convId,
        convRefs,
        activeAssistant?.id ?? null
      );
    } catch (e) {
      setStreaming(false);
      sendingRef.current = false;
      turnIdRef.current = null;
      // Hand the references back so the user can retry without re-selecting.
      setPendingRefs((prev) => (prev.length > 0 ? prev : refs));
      setPendingConvRefs((prev) => (prev.length > 0 ? prev : convRefs));
      setChatAttachments((prev) => (prev.length > 0 ? prev : attachments));
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + String(e) }]);
    }
  };

  /// Stop the running turn. Best-effort: the backend flips a flag, the agent
  /// abandons its stream at the next chunk, and `chat-done` still arrives —
  /// so we don't clear `streaming` here.
  const stopChat = async () => {
    const id = turnIdRef.current;
    if (!id) return;
    try {
      await cancelTurn(id);
    } catch {
      // Already finished — nothing to stop.
    }
  };

  /// Answer the head of the confirmation queue.
  const answerConfirm = async (approved: boolean) => {
    const req = confirmQueue[0];
    if (!req) return;
    setConfirmQueue((prev) => prev.slice(1));
    try {
      await resolveConfirm(req.turn_id, req.id, approved);
    } catch (e) {
      setChat((prev) => [
        ...prev,
        { role: "tool", content: "确认失败: " + String(e) },
      ]);
    }
  };

  // The "+" dropdown creates real empty containers (ADR-016) or opens the
  // connection form. 新建环境/新建组 persist a first-class container
  // immediately, so it shows in the tree even with no connections under it.
  const selectedEnvId = (): string | undefined => {
    const c = findConn(selId);
    if (!c || !c.group_id) return undefined;
    for (const env of tree.environments) {
      for (const g of env.groups) {
        if (g.id === c.group_id) return env.id;
      }
    }
    return undefined;
  };

  const newEnvironment = async () => {
    setAddOpen(false);
    const r = await promptEnvType("新建环境");
    if (!r || !r.name.trim()) return;
    try {
      await api.createEnvironment(r.name.trim(), r.dbType);
      await refresh();
    } catch (e) {
      showToast("创建环境失败: " + String(e));
    }
  };

  const newGroup = async () => {
    setAddOpen(false);
    // Parent env: the selected connection's env if known, else the first
    // environment, else auto-create a default one.
    let envId = selectedEnvId();
    if (!envId) {
      const envs = tree.environments.filter((e) => e.id !== "__ungrouped");
      if (envs.length === 0) {
        try {
          envId = await api.createEnvironment("默认环境");
        } catch (e) {
          showToast("创建环境失败: " + String(e));
          return;
        }
      } else {
        envId = envs[0].id;
      }
    }
    const name = await promptAsync("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      showToast("创建分组失败: " + String(e));
    }
  };

  // Create a group under an explicit environment (right-click "新建组" on an env).
  const newGroupUnder = async (envId: string) => {
    const name = await promptAsync("分组名称", "新分组");
    if (!name || !name.trim()) return;
    try {
      await api.createGroup(envId, name.trim());
      await refresh();
    } catch (e) {
      showToast("创建分组失败: " + String(e));
    }
  };

  const renameContainer = async (id: string, oldName: string) => {
    const name = await promptAsync("重命名", oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    try {
      await api.renameContainer(id, name.trim());
      await refresh();
    } catch (e) {
      showToast("重命名失败: " + String(e));
    }
  };

  const removeContainer = async (id: string) => {
    if (!await confirmAsync("确认删除该容器？若其中还有分组或连接将无法删除。")) return;
    try {
      await api.deleteContainer(id);
      await refresh();
    } catch (e) {
      showToast("删除失败: " + String(e));
    }
  };

  const openAddSeed = (seed: Partial<ConnInput>, lockDbType = false) => {
    setAddOpen(false);
    setFormTab("basic");
    setForm({
      open: true,
      editing: false,
      cfg: { ...emptyForm(), ...seed },
      lockDbType,
    });
  };

  const openEditFor = (id: string) => {
    const c = findConn(id);
    if (!c) return;
    setFormTab("basic");
    setForm({
      open: true,
      editing: true,
      cfg: { ...emptyForm(), ...c, password: "" },
      lockDbType: false,
    });
  };

  /// db_type of the environment a group belongs to (groups don't carry their
  /// own type — the environment binds it, ADR-022).
  const envTypeOfGroup = (groupId: string): "mysql" | "redis" | undefined =>
    tree.environments.find((e) => e.groups.some((g) => g.id === groupId))?.db_type;
  const saveForm = async () => {
    try {
      if (form.editing) await api.updateConnection(form.cfg);
      else await api.addConnection(form.cfg);
      setForm({ ...form, open: false });
      await refresh();
      if (form.editing) await loadSchema(form.cfg.id);
    } catch (e) {
      showToast("保存失败: " + String(e));
    }
  };
  const delConnFor = async (id: string) => {
    if (!id) return;
    if (!await confirmAsync("确认删除该连接？")) return;
    await api.deleteConnection(id);
    if (id === selId) setSelId("");
    await refresh();
  };
  const testForm = async () => {
    try {
      const ok = await api.testConnection(form.cfg);
      showToast(ok ? "连接成功" : "连接失败");
    } catch (e) {
      showToast("连接失败: " + String(e));
    }
  };

  // Close the "+" dropdown on outside click or Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target as Node)) {
        setAddOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  // Initial load: connections + LLM/mask status.
  useEffect(() => {
    (async () => {
      await refresh();
      setStatus(await api.getStatus());
    })();
  }, [refresh]);

  // Mount the editor once. The change listener writes back to the active tab;
  // tab switches call `replaceValue`, which re-fires this listener (writing the
  // same text) — idempotent by design.
  useEffect(() => {
    const el = document.getElementById("editor");
    if (!el) return;
    const editor = createEditor(
      el,
      (doc) => {
        const id = activeTabIdRef.current;
        setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, sql: doc } : t)));
      },
      () => runQueryRef.current(),
      () => handleOpenInlineAiRef.current()
    );
    editorRef.current = editor;
    const init = tabs.find((t) => t.id === activeTabId);
    if (init) editor.replaceValue(init.sql);

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handleOpenInlineAiRef.current();
      }
    };
    window.addEventListener("keydown", onGlobalKeyDown);

    return () => {
      window.removeEventListener("keydown", onGlobalKeyDown);
      editor.view.destroy();
    };
  }, []);

  // Streaming chat event listeners.
  useEffect(() => {
    // Tauri's `listen` resolves its unlisten fn asynchronously. If the effect
    // is torn down first (StrictMode double-mount in dev, HMR), the unlisten
    // would land in a dead array and the listener leaks — every subsequent
    // chat token then gets appended once per leaked listener ("你好你好你好…"),
    // and a leaked chat-done handler re-saves the turn's messages. `disposed`
    // makes a late-resolving unlisten unregister itself immediately. 2026-08-12.
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const safe = (u: () => void) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    onChatToken((t) => {
      // 严格追加到当前正在进行的本轮 assistant 消息，绝不向历史轮次逆向匹配
      setChat((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx].role === "assistant") {
          const last = next[lastIdx];
          next[lastIdx] = { ...last, content: last.content + t };
        } else {
          next.push({ role: "assistant", content: t, plan: undefined, tools: [] });
        }
        return next;
      });
      // Keep the persistence snapshot in step so chat-done writes the full text.
      const snap = turnItemsRef.current;
      const items = [...snap.items];
      const lastIdx = items.length - 1;
      if (lastIdx >= 0 && items[lastIdx].role === "assistant") {
        const last = items[lastIdx];
        items[lastIdx] = { ...last, content: (last as any).content + t };
      } else {
        items.push({ role: "assistant", content: t });
      }
      turnItemsRef.current = { convId: snap.convId, items };
    }).then(safe);

    onChatTool((t) => {
      // 动态矫正本轮实际执行的数据库上下文（智能多库路由动态感知）
      const m = /^execute_query「[\s\S]+?」→\s*([^·:]+?)(?:\s*·\s*([^:]+?))?:\s*(.*)$/.exec(t);
      if (m) {
        const connName = m[1].trim();
        const dbName = m[2] ? m[2].trim() : null;
        const matched = allConns.find((c) => c.name === connName);
        if (matched) {
          turnBindingRef.current = { conn_id: matched.id, db: dbName };
        }
      }

      // 工具调用直接挂载到当前本轮 assistant 消息的 tools 数组，物理隔离步骤与正文
      setChat((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx].role === "assistant") {
          const last = next[lastIdx];
          const tools = [...(last.tools || []), t];
          next[lastIdx] = { ...last, tools };
        }
        return next;
      });
      const snap = turnItemsRef.current;
      const items = [...snap.items];
      const lastIdx = items.length - 1;
      if (lastIdx >= 0 && items[lastIdx].role === "assistant") {
        const last = items[lastIdx];
        const tools = [...((last as any).tools || []), t];
        items[lastIdx] = { ...(last as any), tools };
      }
      turnItemsRef.current = { convId: snap.convId, items };
    }).then(safe);

    // 计划步骤直接挂载到当前本轮 assistant 消息的 plan 数组
    onChatPlan((steps) => {
      setChat((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx].role === "assistant") {
          const last = next[lastIdx];
          next[lastIdx] = { ...last, plan: steps };
        }
        return next;
      });
      const snap = turnItemsRef.current;
      const items = [...snap.items];
      const lastIdx = items.length - 1;
      if (lastIdx >= 0 && items[lastIdx].role === "assistant") {
        const last = items[lastIdx];
        items[lastIdx] = { ...last, plan: steps } as any;
      }
      turnItemsRef.current = { convId: snap.convId, items };
    }).then(safe);
    onChatConfirm((req) => {
      setConfirmQueue((prev) => [...prev, req]);
    }).then(safe);
    let latestUsage: TokenUsage | null = null;
    onChatUsage((u) => {
      if (!u.total_tokens) return;
      latestUsage = u;
      setChat((prev) => {
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (lastIdx >= 0 && next[lastIdx].role === "assistant") {
          next[lastIdx] = { ...next[lastIdx], usage: u };
        }
        return next;
      });
      const snap = turnItemsRef.current;
      const items = snap.items.map((m, i, arr) => {
        if (i === arr.length - 1 && m.role === "assistant") {
          return { ...m, usage: u };
        }
        return m;
      });
      turnItemsRef.current = { convId: snap.convId, items };
    }).then(safe);
    onChatDone(() => {
      setStreaming(false);
      sendingRef.current = false;
      turnIdRef.current = null;
      setConfirmQueue([]);

      // If provider never reported usage, estimate from text
      let finalUsage = latestUsage;
      const snap = turnItemsRef.current;
      if (!finalUsage) {
        const inText = snap.items
          .filter(
            (m) => m.role === "user" || m.role === "plan" || m.role === "ref",
          )
          .map((m) => {
            if (m.role === "plan") return ((m as any).steps || []).join("\n");
            if (m.role === "ref") return ((m as any).refs || []).map((r: any) => r.sql).join("\n");
            return m.content;
          })
          .join("\n");
        const outText = snap.items
          .filter((m) => m.role === "assistant")
          .map((m) => m.content)
          .join("\n");
        if (inText.trim() || outText.trim()) {
          const p = estimateTokens(inText);
          const c = estimateTokens(outText);
          finalUsage = {
            prompt_tokens: p,
            completion_tokens: c,
            total_tokens: p + c,
            cached_tokens: 0,
          };
        }
      }
      latestUsage = null;

      // Stamp this turn's conn/db context onto the final assistant reply, so
      // the message remembers which database its SQL targets (shown as a chip
      // under the message and used by SQL import to locate the connection).
      // 优先从本轮真实执行的 execute_query 工具调用中提取目标连接与数据库
      let executedBinding: ChatDbBinding | null = null;
      const lastAssistant = snap.items[snap.items.length - 1];
      const toolsList = (lastAssistant as any)?.tools as string[] | undefined;
      if (toolsList && toolsList.length > 0) {
        for (let i = toolsList.length - 1; i >= 0; i--) {
          const m = /^execute_query「[\s\S]+?」→\s*([^·:]+?)(?:\s*·\s*([^:]+?))?:\s*(.*)$/.exec(toolsList[i]);
          if (m) {
            const connName = m[1].trim();
            const dbName = m[2] ? m[2].trim() : null;
            const matched = allConns.find((c) => c.name === connName);
            if (matched) {
              executedBinding = { conn_id: matched.id, db: dbName };
              break;
            }
          }
        }
      }

      const turnBinding = executedBinding || turnBindingRef.current;
      turnBindingRef.current = null;

      // Front-end fallback: ensure assistant message has content and usage attached
      setChat((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const lastIdx = next.length - 1;
        if (next[lastIdx].role === "assistant") {
          const item = next[lastIdx];
          const content = item.content.trim() === "" ? "（操作完成，未生成额外说明）" : item.content;
          const usage = ("usage" in item && item.usage) || finalUsage || undefined;
          const dbBinding = ("dbBinding" in item && item.dbBinding) || turnBinding || undefined;
          next[lastIdx] = { ...item, content, usage, dbBinding };
        }
        return next;
      });

      const convId_ = snap.convId;
      turnItemsRef.current = { convId: null, items: [] };
      const patchedItems = snap.items.map((m, i, arr) => {
        if (i === arr.length - 1 && m.role === "assistant") {
          const content = m.content.trim() === "" ? "（操作完成，未生成额外说明）" : m.content;
          const usage = (m as any).usage || finalUsage || undefined;
          const dbBinding = (m as any).dbBinding || turnBinding || undefined;
          return { ...m, content, usage, dbBinding };
        }
        return m;
      });
      const patchedSnap = {
        convId: snap.convId,
        items: patchedItems,
      };

      if (convId_) {
        const msgs: NewChatMessage[] = patchedSnap.items
          .filter((m) => !(m.role === "assistant" && m.content.trim() === ""))
          .map((m) => {
            if (m.role === "ref") {
              return { role: "ref", content: m.content, meta: { refs: (m as any).refs } };
            }
            if (m.role === "assistant") {
              const u = (m as any).usage;
              const b = (m as any).dbBinding;
              const plan = (m as any).plan;
              const tools = (m as any).tools;
              const metaObj =
                u || b || plan || tools
                  ? {
                      ...(u ? { usage: u } : {}),
                      ...(b ? { db_binding: b } : {}),
                      ...(plan ? { plan } : {}),
                      ...(tools ? { tools } : {}),
                    }
                  : undefined;
              return { role: "assistant", content: m.content, meta: metaObj };
            }
            return { role: m.role, content: m.content };
          });
        if (msgs.length > 0) {
          api
            .appendChatMessages(convId_, msgs)
            .then(() => loadConvs())
            .catch((e) => showToast("消息保存失败: " + String(e)));
        }
      }
    }).then(safe);
    onChatError((t) => {
      setStreaming(false);
      sendingRef.current = false;
      turnIdRef.current = null;
      turnBindingRef.current = null;
      setChat((prev) => [...prev, { role: "tool", content: "错误: " + t }]);
    }).then(safe);
    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  return (
    <div className="root">
      <div className="titlebar" data-tauri-drag-region>
        {/* 窗口标题由系统原生渲染（tauri.conf.json 的 title），这里只保留
            拖拽区，避免与原生标题叠加显示成两份文字。 */}
      </div>
      <div
        ref={appContainerRef}
        className={"app" + (chatOpen ? "" : " chat-collapsed")}
        style={
          chatOpen
            ? ({
                "--chat-width-val": `${chatWidth}px`,
                gridTemplateColumns: `var(--sidebar-w) 1fr var(--chat-width-val, ${chatWidth}px)`,
              } as React.CSSProperties)
            : undefined
        }
      >
      <aside className="sidebar">
        <div className="sidebar-head">
          <span>连接</span>
          <div className="head-actions">
            <button
              className="icon-btn"
              title="LLM 模型设置"
              onClick={() => void openSettings()}
            >
              ⚙
            </button>
            <button
              className="icon-btn"
              title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "☀" : "🌙"}
            </button>
            <div className="add-wrap" ref={addWrapRef}>
            <button
              className="add-btn"
              title="新建"
              onClick={() => setAddOpen((v) => !v)}
            >
              ＋
            </button>
            {addOpen && (
              <div className="add-menu">
                <button className="add-item" onClick={() => openAddSeed({})}>
                  新建连接
                </button>
                <button className="add-item" onClick={() => void newGroup()}>
                  新建组
                </button>
                <button className="add-item" onClick={() => void newEnvironment()}>
                  新建环境
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
        <Tree
          tree={tree}
          selectedConnId={selId}
          selectedDb={selDb}
          onSelectConn={selectConn}
          onBrowseTable={browseTable}
          onBrowseRedisKey={browseRedisKey}
          onInsertColumn={insertColumn}
          onEditConn={openEditFor}
          onDeleteConn={delConnFor}
          onInsertText={insertText}
          onRefreshConns={refresh}
          onNewGroup={(envId) => void newGroupUnder(envId)}
          onNewConnection={(groupId) => {
            const t = envTypeOfGroup(groupId) ?? "mysql";
            openAddSeed({ group_id: groupId, db_type: t }, true);
          }}
          onRenameContainer={(id, name) => void renameContainer(id, name)}
          onDeleteContainer={(id) => void removeContainer(id)}
          onShowStructure={showStructure}
          onShowRelationships={showRelationships}
          onSelectDb={onSelectDb}
          onNewQuery={onNewQuery}
        />
      </aside>

      <main className="app-main" ref={appMainRef}>
        <div className="tab-bar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={"tab" + (t.id === activeTabId ? " active" : "")}
                onClick={() => switchTab(t.id)}
                title={t.name}
              >
                <span className="tab-name">{t.name}</span>
                {tabs.length > 1 && (
                  <button
                    className="tab-close"
                    title="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button className="tab-new" title="新建查询" onClick={() => newTab()}>
              ＋
            </button>
          </div>
          {isRedisConn ? (
            <Suspense fallback={<div className="pane-head">加载 Redis 面板…</div>}>
              <RedisBrowser connId={active!.connId} db={parseInt(active!.db || "0", 10)} showToast={showToast} />
            </Suspense>
          ) : (
          <>
          <div
            className={"editor-pane" + (resultCollapsed ? " expanded" : "")}
            style={resultCollapsed ? undefined : { flex: "0 0 var(--editor-flex, 50%)" }}
          >
          <div className="pane-head">
            <span className="ctx-conn-wrap">
              查询编辑器
              {active?.connId ? (
                <button
                  className="ctx-db-btn"
                  onClick={() => void openDbPicker()}
                  title={
                    (() => {
                      const c = findConn(active.connId);
                      return c
                        ? `连接「${c.name}」 · ${c.host}:${c.port} · 用户 ${c.user} · 库 ${active.db || "默认"}\n点击切换连接 / 数据库（每个查询独立）`
                        : "点击切换连接 / 数据库（每个查询独立）";
                    })()
                  }
                >
                  {(() => {
                    const c = findConn(active.connId);
                    if (!c) return "未知连接";
                    const icon = c.db_type === "redis" ? "🔴" : "🐬";
                    return (
                      <>
                        <span className="conn-icon">{icon}</span>
                        <span className="conn-name">{c.name}</span>
                        <span className="conn-sep">·</span>
                        <span className="conn-addr">
                          {c.host}:{c.port}
                        </span>
                        <span className="conn-sep">·</span>
                        <span className="conn-user">{c.user}</span>
                        <span className="conn-sep">·</span>
                        <span
                          className={
                            active.db ? "conn-db" : "conn-db conn-db-default"
                          }
                        >
                          库: {active.db || "默认"}
                        </span>
                      </>
                    );
                  })()}
                </button>
              ) : (
                <button
                  className="ctx-db-btn"
                  onClick={() => void openDbPicker()}
                  title="点击选择连接 / 数据库（每个查询独立）"
                >
                  未选择连接
                </button>
              )}
              <span className="hint"> (Ctrl/Cmd+Enter 执行)</span>
            </span>
            <div className="pane-actions">
              <div className="menu-anchor" ref={refMenuRef}>
                <button
                  type="button"
                  className="ref-chat-btn"
                  aria-haspopup="menu"
                  aria-expanded={refMenuOpen}
                  onClick={() => setRefMenuOpen((v) => !v)}
                  title="引用当前编辑器 SQL 到 Chat（附带数据库与连接信息）"
                >
                  💬 引用到 Chat ▾
                </button>
                {refMenuOpen && (
                  <ul className="menu-pop" role="menu">
                    <li
                      role="menuitem"
                      className={
                        "menu-item" +
                        (active?.connId ? "" : " disabled")
                      }
                      aria-disabled={!active?.connId}
                      title={
                        active?.connId
                          ? "将当前查询的连接 / 数据库绑定为 Chat 的默认上下文"
                          : "请先为当前查询选择连接 / 数据库"
                      }
                      onClick={() => {
                        if (!active?.connId) return;
                        setRefMenuOpen(false);
                        setChatConnId(active.connId);
                        setChatDb(active.db ?? null);
                        const connName = findConn(active.connId)?.name ?? "未知连接";
                        showToast(
                          `已将【${connName} · ${active.db || "默认库"}】引入到 Chat`,
                        );
                      }}
                    >
                      🗄 引入数据库到 Chat
                    </li>
                    <li className="ai-menu-sep" />
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setRefMenuOpen(false);
                        attachSqlRef("statement");
                      }}
                    >
                      💬 引用单条 / 选中 SQL
                    </li>
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setRefMenuOpen(false);
                        attachSqlRef("full");
                      }}
                    >
                      💬 引用整个查询 SQL
                    </li>
                    <li className="ai-menu-sep" />
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setRefMenuOpen(false);
                        attachSqlRef(
                          "statement",
                          "请解释这段 SQL 的执行逻辑与潜在问题。",
                        );
                      }}
                    >
                      💡 解释这段 SQL
                    </li>
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setRefMenuOpen(false);
                        attachSqlRef(
                          "statement",
                          "请分析这段 SQL 的性能瓶颈并给出优化建议（含索引建议）。",
                        );
                      }}
                    >
                      ⚡ 优化这段 SQL
                    </li>
                  </ul>
                )}
              </div>
              <button
                type="button"
                className="btn-open-inline-ai"
                onClick={handleOpenInlineAi}
                title="呼出 AI 原地编写 / 改写 (Cmd+K)"
              >
                ✨ AI 编写
              </button>
              <button className="primary" onClick={() => void runQuery()} title="执行查询 (Ctrl/Cmd+Enter)">
                执行
              </button>
              <div className="menu-anchor" ref={moreRef}>
                <button
                  className="menu-trigger"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title="更多操作"
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  <span aria-hidden="true">⋯</span>
                </button>
                {moreOpen && (
                  <ul className="menu-pop" role="menu">
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => { setMoreOpen(false); editorRef.current?.formatSql(); }}
                    >
                      格式化
                    </li>
                    <li
                      role="menuitem"
                      className={"menu-item" + (active?.connId ? "" : " disabled")}
                      aria-disabled={!active?.connId}
                      title="把光标所在单条（或选中的）SQL 引用到 Chat（带数据库信息）"
                      onClick={() => { if (!active?.connId) return; setMoreOpen(false); attachSqlRef("statement"); }}
                    >
                      💬 引用单条 SQL 到 Chat
                    </li>
                    <li
                      role="menuitem"
                      className={"menu-item" + (active?.connId ? "" : " disabled")}
                      aria-disabled={!active?.connId}
                      title="把当前标签页的整个查询 SQL 引用到 Chat（带数据库信息）"
                      onClick={() => { if (!active?.connId) return; setMoreOpen(false); attachSqlRef("full"); }}
                    >
                      💬 引用整个查询到 Chat
                    </li>
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => { setMoreOpen(false); saveCurrentAsSnippet(); }}
                    >
                      存为片段
                    </li>
                    <li
                      role="menuitem"
                      className="menu-item"
                      onClick={() => { setMoreOpen(false); openHistory(); }}
                    >
                      历史
                    </li>
                    <li
                      role="menuitem"
                      className={"menu-item" + (active?.connId ? "" : " disabled")}
                      aria-disabled={!active?.connId}
                      onClick={() => { if (!active?.connId) return; setMoreOpen(false); explainQuery(); }}
                    >
                      执行计划
                    </li>
                  </ul>
                )}
              </div>
            </div>
          </div>
          <div
            id="editor"
            className="editor"
            onContextMenu={(e) => {
              e.preventDefault();
              const sel = editorRef.current?.getSelection().trim() ?? "";
              setEditorMenu({
                x: e.clientX,
                y: e.clientY,
                hasSel: sel.length > 0,
              });
            }}
          />
          <InlineAiBar
            visible={inlineAiOpen}
            selectedSql={inlineAiSelectedSql}
            dbName={active?.db ?? chatDb ?? null}
            isGenerating={inlineAiGenerating}
            isThinking={inlineAiThinking}
            hasGenerated={inlineAiGenerated}
            onClose={() => setInlineAiOpen(false)}
            onSubmit={handleInlineAiSubmit}
            onAccept={handleInlineAiAccept}
            onReject={handleInlineAiReject}
          />
          {resultCollapsed && (
            <button
              className="floating-restore-pill"
              onClick={() => setResultCollapsed(false)}
              title="点击展开查询结果面板"
            >
              📊 展开查询结果 {result?.kind === "table" && Array.isArray(result.rows) ? `(${result.rows.length}行)` : ""} ↑
            </button>
          )}
        </div>
        {!resultCollapsed && (
          <div
            className="pane-splitter-v"
            onMouseDown={startVResize}
            title="拖动调整编辑器与结果面板高度"
          >
            <div className="splitter-handle" />
          </div>
        )}
        {!resultCollapsed && (
        <div
          className="result-pane"
          style={{ flex: "1 1 calc(100% - var(--editor-flex, 50%) - 5px)" }}
        >
          <div className="pane-head">
            <div className="result-tabs">
              <button
                className={"rtab" + (resultTab === "data" ? " active" : "")}
                onClick={() => setResultTab("data")}
              >
                数据
              </button>
              <span className="result-status">
                [{result?.kind ?? "null"} rows={result?.kind === "table" && Array.isArray(result.rows) ? result.rows.length : "-"}]
              </span>
              <button
                className={"rtab" + (resultTab === "structure" ? " active" : "")}
                disabled={!structureView && !browseCtx}
                onClick={gotoStructure}
              >
                表结构
              </button>
              <button
                className={"rtab" + (resultTab === "relation" ? " active" : "")}
                disabled={!relationshipView && !browseCtx}
                onClick={gotoRelation}
              >
                表关系
              </button>
              <button
                className={"rtab" + (resultTab === "explain" ? " active" : "")}
                disabled={!explainView}
                onClick={() => setResultTab("explain")}
              >
                执行计划
              </button>
            </div>
            <div className="pane-actions">
              {resultTab === "data" ? (
                <>
                  {editable && hasEdits && (
                    <>
                      <button className="primary" onClick={handleSaveEdit}>
                        保存修改
                      </button>
                      <button onClick={handleUndoEdit}>撤销修改</button>
                    </>
                  )}
                  {editable && <button onClick={addInsertRow}>新增行</button>}
                  {editable && !hasEdits && (
                    <span className="hint">双击单元格可编辑</span>
                  )}
                  {/* #3: grid search + per-column filters */}
                  <span className="grid-search">
                    <input
                      placeholder="搜索当前页…"
                      value={gridSearch}
                      onChange={(e) => setGridSearch(e.target.value)}
                    />
                    <label
                      className="case-toggle"
                      title="区分大小写：勾选后「搜索当前页」和列筛选（包含/等于/不等于）区分大小写，不勾选则忽略大小写"
                    >
                      <input
                        type="checkbox"
                        title="区分大小写"
                        checked={gridCase}
                        onChange={(e) => setGridCase(e.target.checked)}
                      />
                      Aa
                    </label>
                    {(Object.keys(colFilters).length > 0 || gridSearch.trim() || gridSort !== null) && (
                      <button
                        className="clear-filter"
                        onClick={() => {
                          setColFilters({});
                          setGridSearch("");
                          setGridSort(null);
                        }}
                        title="清除全部筛选/排序/搜索"
                      >
                        清除
                      </button>
                    )}
                  </span>
                  {result && result.kind === "table" && Array.isArray(result.rows) && result.rows.length > 0 && (
                    <button
                      className={"transpose-toggle-btn" + (isTransposed ? " active" : "")}
                      onClick={() => setIsTransposed((v) => !v)}
                      title={isTransposed ? "切换回表格视图" : "切换为单行转置视图（行列互换，适合宽表排查）"}
                    >
                      {isTransposed ? "⊞ 表格视图" : "⇄ 转置视图"}
                    </button>
                  )}
                  {result && result.kind === "table" && Array.isArray(result.columns) && result.columns.length > 0 && (
                    <div className="export-dropdown">
                      <button
                        className="export-btn"
                        onClick={() => setExportOpen((v) => !v)}
                        title="导出结果"
                      >
                        导出 ▾
                      </button>
                      {exportOpen && (
                        <>
                          <div className="export-mask" onClick={() => setExportOpen(false)} />
                          <div className="export-menu">
                            <button onClick={() => { exportCsv(result, browseCtx); setExportOpen(false); }}>
                              CSV (.csv)
                            </button>
                            <button onClick={() => { exportExcel(result, browseCtx); setExportOpen(false); }}>
                              Excel (.xlsx)
                            </button>
                            <button onClick={() => { exportJsonFile(result, browseCtx); setExportOpen(false); }}>
                              JSON (.json)
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {result && "truncated" in result && result.truncated && (
                    <span className="warn">已截断，请加 LIMIT</span>
                  )}
                  <button
                    className="pane-collapse-btn"
                    onClick={() => setResultCollapsed(true)}
                    title="收起结果面板（编辑器将全屏展开，右下角提供悬浮胶囊恢复）"
                  >
                    ⌄ 收起
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setResultTab("data")}>返回数据</button>
                  <button
                    className="pane-collapse-btn"
                    onClick={() => setResultCollapsed(true)}
                    title="收起结果面板（编辑器将全屏展开，右下角提供悬浮胶囊恢复）"
                  >
                    ⌄ 收起
                  </button>
                </>
              )}
            </div>
          </div>
          {runInfo && (
            <div className={"run-banner run-" + runInfo.kind}>
              <span className="run-banner-text">{runInfo.text}</span>
              {runInfo.kind === "err" && (
                <button
                  type="button"
                  className="btn-diagnose-fix"
                  onClick={() => diagnoseSqlError()}
                  title="让 AI 分析该报错原因并提供修复 SQL"
                >
                  💡 AI 诊断并修复
                </button>
              )}
            </div>
          )}
          {multiResults && multiResults.length > 1 && resultTab === "data" && (
            <div className="multi-result-tabs">
              {multiResults.map((r, i) => {
                const label = r.kind === "table"
                  ? `${i + 1} · ${r.columns.length > 0 ? `${r.columns.length} 列` : "无列"}`
                  : `${i + 1} · Redis`;
                const isErr = r.kind === "table" && r.columns.length === 1 &&
                  r.columns[0] === "Error";
                return (
                  <button
                    key={i}
                    className={"multi-result-tab" + (i === multiResultIdx ? " active" : "") + (isErr ? " err" : "")}
                    onClick={() => {
                      setMultiResultIdx(i);
                      setActiveTab((tab) => ({ ...tab, result: r }));
                    }}
                    title={`结果集 ${i + 1}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <ErrorBoundary>
          <div className="result-body">
            {resultTab === "structure" ? (
              structureView ? (
                renderStructure()
              ) : (
                <div className="empty">加载表结构…</div>
              )
            ) : resultTab === "relation" ? (
              relationshipView ? (
                renderRelationships()
              ) : (
                <div className="empty">加载表关系…</div>
              )
            ) : resultTab === "explain" ? (
              explainView ? (
                renderExplain(explainView)
              ) : (
                <div className="empty">点击「执行计划」按钮生成可视化</div>
              )
            ) : (
              renderData()
            )}
          </div>
          </ErrorBoundary>
          {resultTab === "data" && pager}
        </div>
        )}
        <div className={"status-bar" + (runInfo ? " " + runInfo.kind : "")}>
          <span className="status-dot" />
          <span className="status-text">{running ? "执行中…" : runInfo ? runInfo.text : "就绪"}</span>
          {active?.connId && findConn(active.connId) && (
            <span className="status-conn">● {findConn(active.connId)!.name}</span>
          )}
          {active?.connId && active?.db && (
            <span className="status-db">▦ {active.db}</span>
          )}
        </div>
        </>
        )}
      </main>

      {chatOpen ? (
        <section className={"chat" + (chatMaximized ? " maximized" : "")}>
          <div
            className="chat-splitter"
            onMouseDown={startChatResize}
            onDoubleClick={() => {
              setChatOpen(false);
              localStorage.setItem("cq_chat_open", "0");
            }}
            title="拖动调整宽度 · 双击收起 Chat"
          />
          <div className="pane-head">
            <div className="conv-select" ref={convWrapRef}>
              <button
                className="conv-btn"
                title="切换会话"
                onClick={() => setConvOpen((v) => !v)}
              >
                <span className="conv-title">{currentConvTitle()}</span>
                <span className="conv-caret">▾</span>
              </button>
              <button
                className="conv-new"
                title="新建会话"
                onClick={() => void newConv()}
              >
                ＋
              </button>
              {convOpen && (
                <div className="conv-pop">
                  <input
                    className="conv-search"
                    placeholder="搜索会话…"
                    value={convSearch}
                    autoFocus
                    onChange={(e) => setConvSearch(e.target.value)}
                  />
                  <div className="conv-list">
                    {convFiltered.map((c) => (
                      <div
                        key={c.id}
                        className={"conv-item" + (c.id === convId ? " active" : "")}
                        onClick={() => void switchConv(c.id)}
                      >
                        <div className="conv-item-main">
                          <span className="conv-item-title">{c.title}</span>
                          <span className="conv-item-sub">
                            {c.conn_name ?? "全部"} · {relTime(c.updated)} ·{" "}
                            {c.msg_count} 条
                          </span>
                        </div>
                        <span className="conv-item-ops">
                          <button
                            type="button"
                            title="重命名"
                            onClick={(e) => {
                              e.stopPropagation();
                              void renameConv(c);
                            }}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            title="删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteConv(c);
                            }}
                          >
                            🗑
                          </button>
                        </span>
                      </div>
                    ))}
                    {convFiltered.length === 0 && (
                      <div className="dim conv-empty">无匹配会话</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <span className="chat-status">
            {llmCfg?.enabled ? "LLM 已配置" : "LLM 未配置"} · 脱敏:
            {status.mask_enabled ? "开" : "关"}
          </span>
          <button
            className="icon-btn"
            title="写操作审计日志"
            onClick={() => void openAudit()}
          >
            🛡
          </button>
          <button
            className="icon-btn"
            title={chatMaximized ? "还原侧边栏宽度" : "最大化 AI 画布（专注深度分析）"}
            onClick={() => setChatMaximized((v) => !v)}
          >
            {chatMaximized ? "⤡" : "⤢"}
          </button>
          <button
            className="icon-btn"
            title="收起 Chat"
            onClick={() => {
              setChatOpen(false);
              localStorage.setItem("cq_chat_open", "0");
            }}
          >
            ⟩
          </button>
        </div>
        <div className="chat-log">
          {chat.map((m, i) =>
            m.role === "plan" || m.role === "tool" ? null :
            m.role === "ref" ? (
              <div key={i} className="chat-ref">
                <div className="chat-ref-head">已引用 SQL</div>
                {m.refs.map((r, j) => {
                  const l = refLabel(r);
                  return (
                    <div
                      key={j}
                      className="ref-chip in-log"
                      title={r.tab_id ? "点击跳回来源标签页" : "点击查看完整 SQL"}
                      onClick={() => {
                        if (r.tab_id) switchTab(r.tab_id);
                        else setRefView(r);
                      }}
                    >
                      <span className="ref-icon">{l.icon}</span>
                      <span className="ref-conn">{l.name}</span>
                      <span className="ref-sep">·</span>
                      <span className="ref-db">{l.db}</span>
                      <span className="ref-scope">{l.scope}</span>
                      <span className="ref-sql">{refPreview(r.sql)}</span>
                      <button
                        type="button"
                        className="ref-jump"
                        title="运行这段 SQL"
                        onClick={(e) => {
                          e.stopPropagation();
                          void runSqlExplicit(r.conn_id, r.sql, r.db);
                        }}
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        className="ref-jump"
                        title="查看完整 SQL"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRefView(r);
                        }}
                      >
                        👁
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div key={i} className={"msg " + m.role}>
                <div className="msg-actions">
                  <button
                    type="button"
                    className={"msg-copy" + (copiedIdx === i ? " copied" : "")}
                    title="复制消息"
                    onClick={async () => {
                      const parsed = splitThinkContent(m.content || "");
                      const toCopy = parsed.content || m.content || "";
                      const ok = await copyText(toCopy);
                      if (ok) {
                        setCopiedIdx(i);
                        setTimeout(() => setCopiedIdx((p) => (p === i ? null : p)), 1500);
                      }
                    }}
                  >
                    {copiedIdx === i ? "✓" : <CopyIcon />}
                  </button>
                </div>
                {m.role === "user" ? (
                  <div className="msg-body">{m.content || "…"}</div>
                ) : (
                  <div className="msg-bubble">
                    <div className="msg-role">{roleLabel(m.role)}</div>
                    {m.role === "assistant" && ("plan" in m || "tools" in m) && (
                      <ExecutionBlock
                        plan={(m as any).plan}
                        tools={(m as any).tools}
                        isRunning={streaming && i === chat.length - 1}
                        onImportSql={(sql) => handleImportToEditor(sql, undefined)}
                        onOpenNewTab={(sql) => handleOpenInNewTab(sql, undefined)}
                      />
                    )}
                    <div className="msg-body">
                      {streaming && i === chat.length - 1 && !m.content ? (
                        <div className="msg-streaming-indicator">
                          <span className="pulse-dot" /> 正在分析并执行任务…
                        </div>
                      ) : (
                        <MarkdownMessage
                          content={m.content || "…"}
                          onImportSql={(sql) =>
                            handleImportToEditor(sql, "dbBinding" in m ? m.dbBinding : undefined)
                          }
                          onOpenNewTab={(sql) =>
                            handleOpenInNewTab(sql, "dbBinding" in m ? m.dbBinding : undefined)
                          }
                          onExecuteSql={async (sql) => {
                            // 多级精准解析目标连接与数据库
                            let resolvedConnId = "";
                            let resolvedDb: string | null = null;

                            // 1. 优先从本条消息自身的 dbBinding 解析
                            if ("dbBinding" in m && m.dbBinding && m.dbBinding.conn_id) {
                              resolvedConnId = m.dbBinding.conn_id;
                              resolvedDb = m.dbBinding.db ?? null;
                            }

                            // 2. 若消息自带执行记录 (tools)，提取最近一次实际执行的连接与库名
                            if (!resolvedConnId && "tools" in m && Array.isArray((m as any).tools)) {
                              const tools = (m as any).tools as string[];
                              for (let ti = tools.length - 1; ti >= 0; ti--) {
                                const toolMatch = /^execute_query「[\s\S]+?」→\s*([^·:]+?)(?:\s*·\s*([^:]+?))?:\s*(.*)$/.exec(tools[ti]);
                                if (toolMatch) {
                                  const cName = toolMatch[1].trim();
                                  const dName = toolMatch[2] ? toolMatch[2].trim() : null;
                                  const matched = allConns.find((c) => c.name === cName);
                                  if (matched) {
                                    resolvedConnId = matched.id;
                                    resolvedDb = dName;
                                    break;
                                  }
                                }
                              }
                            }

                            // 3. 若当前激活了数据助手，取数据助手绑定的数据库
                            if (!resolvedConnId && activeAssistant && activeAssistant.bound_databases && activeAssistant.bound_databases.length > 0) {
                              resolvedConnId = activeAssistant.bound_databases[0].conn_id;
                              resolvedDb = activeAssistant.bound_databases[0].database ?? null;
                            }

                            // 4. 回退使用当前会话选择的连接或全局树选中连接
                            if (!resolvedConnId) {
                              resolvedConnId = chatConnId || active?.connId || selId || "";
                              resolvedDb = chatDb || active?.db || selDb || null;
                            }

                            if (!resolvedConnId) {
                              showToast("请先选择数据库连接");
                              return;
                            }
                            const connObj = findConn(resolvedConnId);
                            const connName = connObj ? connObj.name : resolvedConnId;
                            const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);

                            // 二次弹窗确认，避免误触
                            const confirmed = await new Promise<boolean>((resolve) => {
                              setChatSqlConfirm({
                                sql,
                                connId: resolvedConnId,
                                db: resolvedDb,
                                connName,
                                isWrite,
                                resolve,
                              });
                            });
                            if (!confirmed) return;

                            if (isWrite) {
                              await execChatWriteSql(resolvedConnId, resolvedDb, sql);
                            } else {
                              await runSqlExplicit(resolvedConnId, sql, resolvedDb);
                              setResultCollapsed(false);
                            }
                          }}
                        />
                      )}
                    </div>
                    {m.role === "assistant" && "dbBinding" in m && m.dbBinding && (
                      <button
                        type="button"
                        className="msg-db-chip"
                        title={
                          "本条回复使用的数据库上下文 · 点击将 Chat 切换到该库 · 从本条消息导入 SQL 会直接定位到此库"
                        }
                        onClick={() => {
                          setChatConnId(m.dbBinding!.conn_id);
                          setChatDb(m.dbBinding!.db);
                          showToast(
                            `已切换到【${findConn(m.dbBinding!.conn_id)?.name ?? "未知连接"} · ${m.dbBinding!.db || "默认库"}】`,
                          );
                        }}
                      >
                        <span className="ref-chip-kind db">DB</span>
                        <span className="msg-db-conn">
                          {findConn(m.dbBinding.conn_id)?.name ?? "未知连接"}
                        </span>
                        <span className="msg-db-dot">·</span>
                        <span className="msg-db-name">{m.dbBinding.db || "默认库"}</span>
                      </button>
                    )}
                    {m.role === "assistant" && "usage" in m && m.usage && m.usage.total_tokens > 0 && (
                      <div className="msg-usage-strip" title="Token 消耗明细">
                        <span className="msg-usage-icon">⚡</span>
                        <span className="msg-usage-item">
                          输入 <span className="msg-usage-val">{fmtNum(m.usage.prompt_tokens)}</span>
                        </span>
                        <span className="msg-usage-dot">·</span>
                        <span className="msg-usage-item">
                          输出 <span className="msg-usage-val">{fmtNum(m.usage.completion_tokens)}</span>
                        </span>
                        <span className="msg-usage-dot">·</span>
                        <span className="msg-usage-item">
                          缓存 <span className="msg-usage-val">{fmtNum(m.usage.cached_tokens ?? 0)}</span>
                        </span>
                        <span className="msg-usage-dot">·</span>
                        <span className="msg-usage-total">
                          总计 <span className="msg-usage-val">{fmtNum(m.usage.total_tokens)}</span>
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          <div ref={chatEndRef} />
        </div>
        {/* Unified "本轮引用" tray — renders a single rounded container
         * only when at least one of the four reference types is present.
         * The 4 categories (database / file attachment / SQL statement /
         * cross-conversation mention) share the same chip visual so the
         * user sees them as one "what I'm sending" group, not four
         * independent blocks. Type colour cue lives in a small left-edge
         * tag so each chip is still scannable. */}
        {(activeAssistant !== null ||
          chatConnId ||
          chatDb ||
          chatAttachments.length > 0 ||
          pendingRefs.length > 0 ||
          pendingConvRefs.length > 0) && (
          <div className="refs-tray" aria-label="本轮引用">
            {/* 数据助手 Chip */}
            {activeAssistant && (
              <span
                className="ref-chip ast-chip"
                style={{ borderColor: "rgba(121, 82, 214, 0.4)", background: "rgba(121, 82, 214, 0.08)" }}
                title={`数据助手: ${activeAssistant.name}\n${activeAssistant.description || ""}\n点击前往助手设置`}
                onClick={() => {
                  editAssistant(activeAssistant);
                  setSettingsTab("assistant");
                  setSettingsOpen(true);
                }}
              >
                <span className="ref-chip-kind ast" style={{ background: "#7952d6", color: "#fff", fontWeight: "bold" }}>
                  {activeAssistant.avatar || "🤖"}
                </span>
                <span className="ref-conn" style={{ fontWeight: 600, maxWidth: "120px" }}>{activeAssistant.name}</span>
                {activeAssistant.bound_databases && activeAssistant.bound_databases.length > 0 && (
                  <>
                    <span className="ref-sep">·</span>
                    <span className="ref-db" style={{ maxWidth: "110px", color: "#93c5fd" }}>
                      {activeAssistant.bound_databases.length === 1
                        ? `${activeAssistant.bound_databases[0].database || allConns.find((x) => x.id === activeAssistant.bound_databases[0].conn_id)?.name || "默认库"}`
                        : `${activeAssistant.bound_databases.length}库`}
                    </span>
                  </>
                )}
                {activeAssistant.bound_knowledge_base_ids.length > 0 && (
                  <>
                    <span className="ref-sep">·</span>
                    <span className="ref-scope">📚 {activeAssistant.bound_knowledge_base_ids.length}</span>
                  </>
                )}
                <button
                  type="button"
                  className="ref-chip-x"
                  title="移除数据助手"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveAssistant(null);
                  }}
                >
                  ×
                </button>
              </span>
            )}
            {/* Database chip — 当未激活助手或助手未绑定具体库时，才展示全局会话的连接/库 */}
            {(!activeAssistant || !activeAssistant.bound_databases || activeAssistant.bound_databases.length === 0) && (chatConnId || chatDb) && (
              <span className="ref-chip" title="当前 Chat 会话绑定的连接 / 库（持续生效）">
                <span className="ref-chip-kind db">DB</span>
                <Icon name="cylinder" size={11} />
                <span className="ref-conn">
                  {chatConnId ? findConn(chatConnId)?.name ?? "未知连接" : "无连接"}
                </span>
                <span className="ref-sep">·</span>
                <span className="ref-db">{chatDb ?? "默认库"}</span>
                <button
                  type="button"
                  className="ref-chip-x"
                  title="解绑此数据库连接"
                  onClick={() => {
                    setChatConnId(null);
                    setChatDb(null);
                  }}
                >
                  ×
                </button>
              </span>
            )}
            {/* Attachment chips — plain text files attached via the +
             * menu. Prepended to the user message on send, cleared
             * after (same lifecycle as the other reference types). */}
            {chatAttachments.map((a) => (
              <span
                key={a.id}
                className="ref-chip"
                title={`${a.name} · ${(a.size / 1024).toFixed(1)} KB`}
              >
                <span className="ref-chip-kind file">FILE</span>
                <Icon name="file" size={11} />
                <span className="ref-name">{a.name}</span>
                <span className="ref-size">{(a.size / 1024).toFixed(1)}K</span>
                <button
                  type="button"
                  className="ref-chip-x"
                  title="移除附件"
                  onClick={() =>
                    setChatAttachments((prev) => prev.filter((x) => x.id !== a.id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            {/* SQL refs (existing) — re-skinned to share the unified chip
             * visual; mismatch warning still kept on the chip itself. */}
            {pendingRefs.map((r, i) => {
              const l = refLabel(r);
              const mismatch = r.conn_id !== selId;
              return (
                <span
                  key={`sql-${i}`}
                  className={"ref-chip" + (mismatch ? " mismatch" : "")}
                  title={
                    (mismatch
                      ? "该 SQL 来自另一个连接，AI 会按引用标注的连接处理\n"
                      : "") + "点击查看完整 SQL"
                  }
                >
                  <span className="ref-chip-kind sql">SQL</span>
                  <button
                    type="button"
                    className="ref-chip-main"
                    onClick={() => setRefView(r)}
                  >
                    <span className="ref-icon">{l.icon}</span>
                    <span className="ref-conn">{l.name}</span>
                    <span className="ref-sep">·</span>
                    <span className="ref-db">{l.db}</span>
                    <span className="ref-scope">{l.scope}</span>
                    <span className="ref-sql">{refPreview(r.sql)}</span>
                  </button>
                  <button
                    type="button"
                    className="ref-chip-x"
                    title="移除引用"
                    onClick={() =>
                      setPendingRefs((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {/* Conversation refs (existing) — same unified chip visual. */}
            {pendingConvRefs.map((r, i) => (
              <span
                key={`conv-${i}`}
                className="ref-chip"
                title={r.preview}
                onClick={() =>
                  pickConvRef(
                    convs.find((c) => c.id === r.conv_id) ?? {
                      id: r.conv_id,
                      title: r.title,
                      conn_id: null,
                      conn_name: null,
                      created: 0,
                      updated: 0,
                      pinned: false,
                      last_preview: "",
                      msg_count: 0,
                    },
                    r.scope === "message",
                  )
                }
              >
                <span className="ref-chip-kind conv">@</span>
                <span className="convref-title" style={{ maxWidth: 120 }}>{r.title}</span>
                <span
                  className={
                    "convref-scope " + (r.scope === "session" ? "whole" : "single")
                  }
                >
                  {r.scope === "session" ? "整段" : "单条"}
                </span>
                <button
                  type="button"
                  className="ref-chip-x"
                  title="移除引用"
                  onClick={(e) => {
                    e.stopPropagation();
                    dropConvRef(i);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {/* 清空所有引用按钮 */}
            <button
              type="button"
              className="refs-tray-clear"
              title="清空所有引用"
              aria-label="清空所有引用"
              onClick={() => {
                setActiveAssistant(null);
                setChatConnId(null);
                setChatDb(null);
                setChatAttachments([]);
                setPendingRefs([]);
                setPendingConvRefs([]);
              }}
            >
              <Icon name="trash" size={10} />
              <span>清空</span>
            </button>
          </div>
        )}
        <div className="chat-composer">
          {/* @-mention picker: floats above the composer, filtered by what was
              typed after "@". Enter picks the highlighted conversation (whole
              tail); clicking an item opens the message drill-down instead. */}
          {atOpen && (
            <div className="at-pop">
              {atCombined.length > 0 ? (
                atCombined.map((cand, i) => {
                  const isAst = cand.kind === "assistant";
                  const a = isAst ? cand.item : null;
                  const c = !isAst ? cand.item : null;
                  return (
                    <div
                      key={cand.kind + "-" + (a ? a.id : c?.id)}
                      className={"at-item" + (i === atIdx ? " active" : "")}
                      onMouseEnter={() => setAtIdx(i)}
                      onClick={() => {
                        if (a) {
                          setActiveAssistant(a);
                        } else if (c) {
                          pickConvRef(c, true);
                        }
                        const ta = document.getElementById("chat-input") as HTMLTextAreaElement | null;
                        if (ta) {
                          const m = /(?:^|\s)@[^\s@]*$/.exec(ta.value);
                          if (m) ta.value = ta.value.slice(0, m.index);
                        }
                        setAtOpen(false);
                        setAtFilter("");
                      }}
                    >
                      <span className="at-title">
                        {isAst ? `${a?.avatar || "🤖"} ${a?.name}` : `💬 ${c?.title}`}
                      </span>
                      <span className="at-sub">
                        {isAst
                          ? (a?.description
                              ? a.description
                              : a?.bound_databases && a.bound_databases.length > 0
                                ? `绑定 ${a.bound_databases.length} 个库`
                                : "继承会话库")
                          : `${c?.conn_name ?? "全部"} · ${relTime(c?.updated ?? 0)}`}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="at-empty">暂无匹配的数据助手或历史会话</div>
              )}
            </div>
          )}
          {convMsgPick && (
            <div className="conv-msg-pop">
              <div className="conv-msg-head">
                <span className="conv-msg-name">{convMsgPick.title}</span>
                <span className="conv-msg-hint">选择引用哪条消息</span>
                <button
                  type="button"
                  className="conv-msg-whole"
                  title="引用整段对话（最近 8 条）"
                  onClick={() => pickConvRef(convMsgPick, true)}
                >
                  整段对话
                </button>
                <button
                  type="button"
                  className="ref-chip-x"
                  title="取消"
                  onClick={() => setConvMsgPick(null)}
                >
                  ×
                </button>
              </div>
              <div className="conv-msg-list">
                {convMsgList.map((m, i) => (
                  <div
                    key={m.id ?? i}
                    className="conv-msg-item"
                    onClick={() => pickMsgRef(convMsgPick, m)}
                  >
                    <span className={"conv-msg-role " + m.role}>{m.role}</span>
                    <span className="conv-msg-text">
                      {(splitThinkContent(m.content || "").content || m.content || "").slice(0, 80) || "…"}
                    </span>
                  </div>
                ))}
                {convMsgList.length === 0 && (
                  <div className="dim conv-msg-empty">加载中…</div>
                )}
              </div>
            </div>
          )}
          {/* 仅在未激活助手且无挂载引用时展示通用快捷提问胶囊，避免过多元素层叠挤压输入区 */}
          {!activeAssistant && pendingRefs.length === 0 && pendingConvRefs.length === 0 && (
            <div className="prompt-pills-bar">
              {[
                { icon: "⚡", label: "慢查询诊断", prompt: "请帮我分析这段 SQL 的执行计划与潜在性能瓶颈，并给出具体的索引与改写优化建议。" },
                { icon: "📊", label: "数据统计总览", prompt: "请帮我统计当前数据库中核心业务表的记录行数、数据体量与重要字段分布。" },
                { icon: "🔍", label: "缺失索引排查", prompt: "请检查当前业务表的索引覆盖情况，指出是否存在全表扫描隐患或需要补充的复合索引。" },
                { icon: "📝", label: "生成字典文档", prompt: "请根据当前表结构、字段类型与注释，生成一份结构清晰规范的 Markdown 数据字典文档。" },
              ].map((item, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="prompt-pill"
                  title={`点击填入提示词：${item.prompt}`}
                  onClick={() => {
                    const input = document.getElementById("chat-input") as HTMLTextAreaElement | null;
                    if (!input) return;
                    const current = input.value.trim();
                    const next = current ? `${current}\n${item.prompt}` : item.prompt;
                    input.value = next;
                    input.focus();
                    input.setSelectionRange(next.length, next.length);
                    input.style.height = "auto";
                    input.style.height = Math.min(input.scrollHeight, 180) + "px";
                  }}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="chat-composer-input">
            <textarea
              id="chat-input"
              placeholder={
                pendingRefs.length > 0 || pendingConvRefs.length > 0
                  ? "就引用的内容提问，输入 @ 可引用其他会话"
                  : "问点什么，输入 @ 可引用其他会话，例如：统计 users 表行数"
              }
              disabled={streaming}
              onInput={onChatInput}
              onChange={onChatInput}
              onKeyDown={onChatKeyDown}
            />
          </div>
          <div className="chat-toolbar">
            <button
              className="composer-plus"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              title="添加引用 / 选库 / 附加文件"
              onClick={() => setPlusOpen((v) => !v)}
            >
              <Icon name="plus" size={14} />
            </button>
            {plusOpen && (
              <div className="composer-plus-menu" ref={plusMenuRef} role="menu">
                <button
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    attachSqlRef("statement");
                  }}
                >
                  <span className="composer-plus-item-title">💬 引用单条 / 选中 SQL</span>
                  <span className="composer-plus-item-sub">将编辑器单条或选中的 SQL 及数据库带入 Chat</span>
                </button>
                <button
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    attachSqlRef("full");
                  }}
                >
                  <span className="composer-plus-item-title">💬 引用整个查询 SQL</span>
                  <span className="composer-plus-item-sub">将编辑器全部 SQL 及数据库带入 Chat</span>
                </button>
                <button
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    triggerAtPicker();
                  }}
                >
                  <span className="composer-plus-item-title">🤖 @ 数据助手 / 引用会话</span>
                  <span className="composer-plus-item-sub">输入 @ 唤出专属业务助手或引用历史会话</span>
                </button>
                <button
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    setSettingsTab("assistant");
                    setSettingsOpen(true);
                  }}
                >
                  <span className="composer-plus-item-title">⚙️ 数据助手管理</span>
                  <span className="composer-plus-item-sub">创建、编辑专属数据助手并绑定多库/知识库</span>
                </button>
                <button
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    // Open the same db picker but route the selection
                    // to the chat's own conn/db state — NOT the SQL
                    // tab. The original behaviour made the SQL tab's
                    // title / status bar jump every time the user
                    // picked something from here, which is misleading
                    // since the chat's LLM context actually came from
                    // `selId`, not the SQL tab.
                    openDbPicker(onChatConnChange);
                  }}
                  disabled={!selId}
                >
                  <span className="composer-plus-item-title">选择数据库</span>
                  <span className="composer-plus-item-sub">切到当前连接的另一个库</span>
                </button>
                <button
                  className="composer-plus-item"
                  onClick={async () => {
                    setPlusOpen(false);
                    try {
                      const selected = await open({
                        multiple: true,
                        directory: false,
                        filters: [
                          {
                            name: "文本文件",
                            extensions: ["md", "txt", "json", "csv", "log", "tsv", "yaml", "yml", "xml"],
                          },
                        ],
                      });
                      if (!selected) return;
                      const paths = Array.isArray(selected) ? selected : [selected];
                      // Cap per-file size to keep the message payload sane.
                      // 200KB is a reasonable ceiling — a Markdown doc or
                      // JSON dump of that size is ~50k tokens which is still
                      // well within most model context windows. Larger files
                      // would be better served by the KB loader.
                      const MAX_BYTES = 200 * 1024;
                      for (const p of paths) {
                        try {
                          const content = await readTextFile(p);
                          if (content.length > MAX_BYTES) {
                            showToast?.(
                              `${p} 太大 (${(content.length / 1024).toFixed(0)}KB)，已跳过；建议 ≤ 200KB`
                            );
                            continue;
                          }
                          const name = p.split(/[\\/]/).pop() ?? p;
                          setChatAttachments((prev) => [
                            ...prev,
                            {
                              id:
                                (typeof crypto !== "undefined" &&
                                  "randomUUID" in crypto
                                  ? crypto.randomUUID()
                                  : `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
                              name,
                              content,
                              size: content.length,
                            },
                          ]);
                        } catch (e) {
                          showToast?.(`读 ${p} 失败: ${String(e)}`);
                        }
                      }
                    } catch (e) {
                      showToast?.("选文件失败: " + String(e));
                    }
                  }}
                >
                  <span className="composer-plus-item-title">附加文件</span>
                  <span className="composer-plus-item-sub">.md / .txt / .json / .csv 等</span>
                </button>
              </div>
            )}
            <div className="chat-toolbar-spacer" />
            <div className="model-anchor" ref={modelMenuRef}>
              <button
                className="composer-model"
                aria-haspopup="menu"
                aria-expanded={modelOpen}
                title="选择模型"
                onClick={() => setModelOpen((v) => !v)}
              >
                <span className="composer-model-name">{currentModelLabel()}</span>
                <span className="composer-caret" aria-hidden="true">▾</span>
              </button>
              {modelOpen && (
                <ul className="composer-model-menu" role="menu" ref={modelMenuListRef}>
                  {vendorProfiles.length === 0 && (
                    <li className="composer-model-empty">
                      还没配置模型 — 去「设置 → 模型」添加
                    </li>
                  )}
                  {vendorProfiles.length > 0 && (
                    <li className="composer-model-section">我的供应商</li>
                  )}
                  {vendorProfiles.flatMap((p) =>
                    p.models.length === 0
                      ? [
                          <li
                            key={"p:" + p.id + ":bare"}
                            className="composer-model-item composer-model-bare"
                            role="menuitem"
                            onClick={() => setModelOpen(false)}
                          >
                            <span className="composer-model-item-name">{p.name}</span>
                            <span className="composer-model-item-vendor">该供应商还没有 model，去设置添加</span>
                          </li>,
                        ]
                      : p.models.map((m) => {
                          const active = p.id === llmCfg?.vendor && m.name === llmCfg?.model;
                          return (
                            <li
                              key={"p:" + p.id + ":" + m.name}
                              className={"composer-model-item" + (active ? " active" : "")}
                              role="menuitem"
                              onClick={async () => {
                                setModelOpen(false);
                                try {
                                  await api.applyModelAlias(p.id, m.name);
                                  setLlmCfg(await api.getLlmConfig());
                                  // `status` is a separate cache that
                                  // drives other UI bits (header bar,
                                  // tooltip copy); keep it in sync with
                                  // the new LlmConfig so future reads
                                  // don't see the stale value.
                                  try {
                                    setStatus(await api.getStatus());
                                  } catch {
                                    /* best-effort */
                                  }
                                  showToast?.("已切到 " + p.name + " · " + m.name);
                                } catch (e) {
                                  showToast?.("切换失败: " + String(e));
                                }
                              }}
                            >
                              <span className="composer-model-item-name">{m.name}</span>
                              <span className="composer-model-item-vendor">{p.name} · {p.api_format}</span>
                            </li>
                          );
                        })
                  )}
                  {/* Presets are intentionally NOT shown here. They live
                   * in `src/config.rs` as quick-select templates for the
                   * "添加供应商" form's [预设] button (they auto-fill
                   * name + base_url when the user picks one) — they are
                   * NOT pre-wired LLM endpoints and cannot be used
                   * directly. Showing them in the composer dropdown made
                   * it look like they were selectable models, which they
                   * aren't. */}
                  <li
                    className="composer-model-item composer-model-manage"
                    role="menuitem"
                    onClick={() => {
                      setModelOpen(false);
                      // Jump straight to the 模型 tab (the parent
                      // `openSettings` re-loads the latest vendor /
                      // preset data and lands on that tab by default).
                      void openSettings();
                    }}
                  >
                    <span>管理供应商…</span>
                    <span className="composer-model-item-sub">在「设置 → 模型」配置</span>
                  </li>
                </ul>
              )}
            </div>
            {streaming ? (
              <button className="danger composer-send" onClick={stopChat} title="停止本轮">
                停止
              </button>
            ) : (
              <button
                className="primary composer-send"
                onClick={sendChat}
                // Simple: enable whenever the user has picked a
                // model. Don't gate on LlmConfig.enabled() / api_key
                // presence — if the key is missing the backend will
                // 401 and the error surfaces in the chat; better
                // than a mysteriously-grayed button that forces a
                // re-pick dance after every settings edit.
                disabled={streaming || !llmCfg?.model}
                title={
                  streaming
                    ? "正在发送..."
                    : llmCfg?.model
                      ? "发送 (Enter / Cmd+Enter)"
                      : "请先在右上角选一个 model"
                }
              >
                发送
              </button>
            )}
          </div>
        </div>
        </section>
      ) : (
        <div className="chat-rail">
          <button
            className="rail-btn"
            title="展开 Chat"
            onClick={() => {
              setChatOpen(true);
              localStorage.setItem("cq_chat_open", "1");
            }}
          >
            💬
          </button>
        </div>
      )}

      {form.open && (
        <div className="modal-mask">
          <div className="modal conn-modal">
            <h3>{form.editing ? "编辑连接" : "新增连接"}</h3>

            {/* Tab navigation: 基础 / SSL / SSH (#4, #5) */}
            <div className="conn-tabs">
              <button
                type="button"
                className={"conn-tab" + (formTab === "basic" ? " active" : "")}
                onClick={() => setFormTab("basic")}
              >
                🔌 基础
              </button>
              <button
                type="button"
                className={"conn-tab" + (formTab === "ssl" ? " active" : "")}
                onClick={() => setFormTab("ssl")}
              >
                🔒 SSL / TLS
              </button>
              <button
                type="button"
                className={"conn-tab" + (formTab === "ssh" ? " active" : "")}
                onClick={() => setFormTab("ssh")}
              >
                🖥 SSH 隧道
              </button>
            </div>

            <div className="conn-tab-body">
              {formTab === "basic" && (
                <>
                  <label>
                    名称
                    <input
                      value={form.cfg.name}
                      onChange={(e) =>
                        setForm({ ...form, cfg: { ...form.cfg, name: e.target.value } })
                      }
                    />
                  </label>
                  <DropdownSelect
                    label="类型"
                    value={form.cfg.db_type}
                    options={[
                      { value: "mysql", label: "mysql" },
                      { value: "redis", label: "redis" },
                    ]}
                    disabled={form.lockDbType}
                    onChange={(v) => {
                      const port = v === "redis" ? 6379 : 3306;
                      // 跨引擎类型切换时自动重置分组，防止 MySQL/Redis 串组
                      const currentGid = form.cfg.group_id;
                      const gType = currentGid ? envTypeOfGroup(currentGid) : undefined;
                      const newGroupId = gType && gType !== v ? null : currentGid;
                      setForm({
                        ...form,
                        cfg: { ...form.cfg, db_type: v, port, group_id: newGroupId },
                      });
                    }}
                  />
                  {form.lockDbType && (
                    <span className="conn-type-lock">
                      🔒 跟随所属环境（{form.cfg.db_type === "redis" ? "redis" : "mysql"}）
                    </span>
                  )}
                  <div className="form-row">
                    <label>
                      主机
                      <input
                        value={form.cfg.host}
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, host: e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      端口
                      <input
                        type="number"
                        value={form.cfg.port}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cfg: { ...form.cfg, port: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      用户
                      <input
                        value={form.cfg.user}
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, user: e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      密码
                      <input
                        type="password"
                        value={form.cfg.password}
                        placeholder={form.editing ? "(留空保持不变)" : ""}
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, password: e.target.value } })
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      数据库
                      <input
                        value={form.cfg.database}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cfg: { ...form.cfg, database: e.target.value },
                          })
                        }
                      />
                    </label>
                    <DropdownSelect
                      label="分组"
                      value={form.cfg.group_id ?? ""}
                      options={[
                        { value: "", label: "（不分组）" },
                        ...tree.environments
                          .filter((e) => {
                            if (e.id === "__ungrouped") return false;
                            // 严格按当前连接的 db_type 过滤环境分组，防止 MySQL 和 Redis 串组
                            const currentType = form.cfg.db_type || "mysql";
                            const envType = e.db_type || "mysql";
                            return envType === currentType;
                          })
                          .flatMap((e) =>
                            e.groups.map((g) => ({
                              value: g.id,
                              label: `[${(e.db_type || "mysql").toUpperCase()}] ${e.name} / ${g.name || "(未命名)"}`,
                            }))
                          ),
                      ]}
                      onChange={(v) => {
                        const gid = v || null;
                        setForm({
                          ...form,
                          cfg: { ...form.cfg, group_id: gid },
                        });
                      }}
                    />
                  </div>
                </>
              )}

              {formTab === "ssl" && (
                <div className="form-section in-tab">
                  <div className="form-section-title">SSL / TLS 加密</div>
                  <DropdownSelect
                    label="模式"
                    value={form.cfg.ssl_mode}
                    options={[
                      { value: "", label: "（不使用）" },
                      { value: "preferred", label: "preferred" },
                      { value: "required", label: "required" },
                      { value: "verify_ca", label: "verify_ca" },
                      { value: "verify_identity", label: "verify_identity" },
                    ]}
                    onChange={(v) =>
                      setForm({ ...form, cfg: { ...form.cfg, ssl_mode: v } })
                    }
                  />
                  <div className="form-row">
                    <label>
                      CA 证书
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.ssl_ca}
                          placeholder="PEM 文本或路径，可选"
                          onChange={(e) =>
                            setForm({ ...form, cfg: { ...form.cfg, ssl_ca: e.target.value } })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.crt,.cer,.ca,.key,.txt"
                          onPick={(t) =>
                            setForm({ ...form, cfg: { ...form.cfg, ssl_ca: t } })
                          }
                        />
                      </div>
                    </label>
                    <label>
                      客户端证书
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.client_cert}
                          placeholder="PEM 文本或路径，可选"
                          onChange={(e) =>
                            setForm({ ...form, cfg: { ...form.cfg, client_cert: e.target.value } })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.crt,.cer,.ca,.key,.txt"
                          onPick={(t) =>
                            setForm({ ...form, cfg: { ...form.cfg, client_cert: t } })
                          }
                        />
                      </div>
                    </label>
                  </div>
                  <label>
                    客户端私钥
                    <div className="input-with-btn">
                      <input
                        value={form.cfg.client_key}
                        placeholder="PEM 文本或路径，可选"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, client_key: e.target.value } })
                        }
                      />
                      <CertPickButton
                        accept=".pem,.key,.txt"
                        onPick={(t) =>
                          setForm({ ...form, cfg: { ...form.cfg, client_key: t } })
                        }
                      />
                    </div>
                  </label>
                </div>
              )}

              {formTab === "ssh" && (
                <div className="form-section in-tab">
                  <div className="form-section-title">SSH 隧道（跳板机，可选）</div>
                  <div className="form-row">
                    <label>
                      跳板机主机
                      <input
                        value={form.cfg.ssh_host}
                        placeholder="留空表示直连"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, ssh_host: e.target.value } })
                        }
                      />
                    </label>
                    <label>
                      跳板机端口
                      <input
                        type="number"
                        value={form.cfg.ssh_port}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            cfg: { ...form.cfg, ssh_port: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    跳板机用户
                    <input
                      value={form.cfg.ssh_user}
                      onChange={(e) =>
                        setForm({ ...form, cfg: { ...form.cfg, ssh_user: e.target.value } })
                      }
                    />
                  </label>
                  <DropdownSelect
                    label="认证方式"
                    value={form.cfg.ssh_auth_kind}
                    options={[
                      { value: "password", label: "密码" },
                      { value: "private_key", label: "私钥" },
                    ]}
                    onChange={(v) =>
                      setForm({ ...form, cfg: { ...form.cfg, ssh_auth_kind: v } })
                    }
                  />
                  {form.cfg.ssh_auth_kind === "password" ? (
                    <label>
                      跳板机密码
                      <input
                        type="password"
                        value={form.cfg.ssh_password}
                        placeholder="可选"
                        onChange={(e) =>
                          setForm({ ...form, cfg: { ...form.cfg, ssh_password: e.target.value } })
                        }
                      />
                    </label>
                  ) : (
                    <label>
                      私钥（PEM 文本或文件路径）
                      <div className="input-with-btn">
                        <input
                          value={form.cfg.ssh_private_key}
                          placeholder="可选"
                          onChange={(e) =>
                            setForm({
                              ...form,
                              cfg: { ...form.cfg, ssh_private_key: e.target.value },
                            })
                          }
                        />
                        <CertPickButton
                          accept=".pem,.key,.txt,id_rsa,id_ed25519"
                          onPick={(t) =>
                            setForm({
                              ...form,
                              cfg: { ...form.cfg, ssh_private_key: t },
                            })
                          }
                        />
                      </div>
                    </label>
                  )}
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button onClick={testForm}>测试连接</button>
              <span className="spacer" />
              <button onClick={() => setForm({ ...form, open: false })}>取消</button>
              <button className="primary" onClick={saveForm}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (() => {
        const kw = historySearch.trim().toLowerCase();
        const visible = history.filter((h) => {
          const isSnippet = !!h.name;
          if (historyTab === "snippet" ? !isSnippet : isSnippet) return false;
          if (historyConn && h.conn_id !== historyConn) return false;
          if (
            kw &&
            !h.sql.toLowerCase().includes(kw) &&
            !(h.db ?? "").toLowerCase().includes(kw) &&
            !(h.name ?? "").toLowerCase().includes(kw)
          )
            return false;
          return true;
        });
        return (
        <div className="modal-mask" onClick={() => setHistoryOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>
              查询历史 / 片段
              {historyTab === "history" && (
                <span
                  className="dim"
                  style={{
                    fontSize: "var(--fs-xs)",
                    fontWeight: "normal",
                    marginLeft: 8,
                  }}
                >
                  （保留上限: {queryHistoryLimit} 条）
                </span>
              )}
            </h3>
            <div className="seg">
              <button
                className={historyTab === "history" ? "seg-on" : ""}
                onClick={() => setHistoryTab("history")}
              >
                历史
              </button>
              <button
                className={historyTab === "snippet" ? "seg-on" : ""}
                onClick={() => setHistoryTab("snippet")}
              >
                片段
              </button>
            </div>
            <div className="history-toolbar">
              <input
                className="history-search"
                placeholder="搜索 SQL 或库名…"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              <div className="history-conn">
                <DropdownSelect
                  value={historyConn}
                  options={[
                    { value: "", label: "全部连接" },
                    ...allConns.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                  onChange={(v) => setHistoryConn(v)}
                />
              </div>
            </div>
            <div className="history-list">
              {visible.length === 0 && <div className="empty">暂无记录</div>}
              {visible.map((h) => {
                const multi = !h.name && splitStatements(h.sql).length > 1;
                const versions = h.versions ?? [];
                const expanded = expandedGroups.has(h.id);
                return (
                <div key={h.id} className="history-item">
                  {h.name && <div className="history-title">{h.name}</div>}
                  <div className="history-meta">
                    {h.name ? <span className="snippet-badge">片段</span> : null}
                    {multi && (
                      <span
                        className="snippet-badge multi"
                        title="本次执行的完整多语句脚本存档"
                      >
                        多语句
                      </span>
                    )}
                    {versions.length > 0 && (
                      <button
                        className="snippet-badge multi"
                        style={{ cursor: "pointer" }}
                        onClick={() => toggleGroup(h.id)}
                        title="展开 / 收起该查询的历史版本"
                      >
                        {expanded ? "▾" : "▸"} {versions.length} 个版本
                      </button>
                    )}
                    <span>{findConn(h.conn_id ?? "")?.name ?? "—"}</span>
                    {h.db ? <span className="history-db">▦ {h.db}</span> : null}
                    <span className="history-time">{fmtTime(h.created)}</span>
                  </div>
                  <pre className="history-sql">{h.sql}</pre>
                  <div className="history-actions">
                    <button onClick={() => loadQuery(h)}>载入</button>
                    <button onClick={() => void saveSnippetFromItem(h)}>
                      {h.name ? "重命名" : "存为片段"}
                    </button>
                    <button onClick={() => void deleteQueryItem(h)}>删除</button>
                  </div>
                  {expanded &&
                    versions.map((v) => (
                      <div
                        key={v.id}
                        className="history-item"
                        style={{ marginTop: 6, opacity: 0.75 }}
                      >
                        <div className="history-meta">
                          <span className="snippet-badge">版本</span>
                          <span>{findConn(v.conn_id ?? "")?.name ?? "—"}</span>
                          {v.db ? <span className="history-db">▦ {v.db}</span> : null}
                          <span className="history-time">{fmtTime(v.created)}</span>
                        </div>
                        <pre
                          className="history-sql"
                          style={{ cursor: "pointer" }}
                          title="点击载入此版本到编辑器"
                          onClick={() => loadQuery(v)}
                        >
                          {v.sql}
                        </pre>
                      </div>
                    ))}
                </div>
                );
              })}
            </div>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setHistoryOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
        );
      })()}

      {auditOpen && (
        <div className="modal-mask" onClick={() => setAuditOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>写操作审计日志</h3>
            <p className="hint">
              所有写语句都会留痕（AI 与手动）：手动执行、AI 批准、拒绝、超时、直接阻断（DDL /
              破坏性语句）。只读查询不记录。最近 200 条，新的在前。
            </p>
            <div className="audit-list">
              {auditRows.length === 0 && <div className="empty">暂无记录</div>}
              {auditRows.map(([conn, db, sql, decision, result, ts], i) => (
                <div key={i} className="audit-item">
                  <div className="audit-meta">
                    <span className={"audit-tag audit-" + decision}>
                      {auditLabel(decision)}
                    </span>
                    <span>{conn}</span>
                    {db ? <span className="history-db">▦ {db}</span> : null}
                    <span className="history-time">{fmtTime(ts)}</span>
                  </div>
                  <pre className="history-sql">{sql}</pre>
                  {/* 执行结果状态条 */}
                  <div className="audit-result-bar">
                    <span className="audit-result-label">执行结果：</span>
                    {result ? (
                      <span className={"audit-result-val " + (result.includes("失败") || result.includes("错误") ? "err" : result.includes("拒绝") || result.includes("拦截") || result.includes("超时") ? "warn" : "ok")}>
                        {result.includes("影响") || result.includes("成功") ? "✓ " : ""}{result}
                      </span>
                    ) : (
                      <span className="audit-result-val dim">
                        {decision === "manual" || decision === "write-approved" ? "✓ 执行完成" : "未执行"}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <span className="spacer" />
              <button onClick={() => setAuditOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="modal-mask"
          onClick={() => {
            // Force-save any in-progress edits before the modal
            // unmounts, so things like the api_key (which auto-saves
            // on onBlur) don't get lost when the user closes the
            // modal by clicking outside. The function no-ops for
            // create-mode (`editingVendor === null`) and for drafts
            // that haven't actually changed.
            void autoSaveVendor();
            setSettingsOpen(false);
          }}
        >
          <div
            className="modal settings-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-nav">
              <div className="settings-nav-title">设置</div>
              <button
                className={"nav-item" + (settingsTab === "model" ? " active" : "")}
                onClick={() => setSettingsTab("model")}
              >
                模型设置
              </button>
              <button
                className={"nav-item" + (settingsTab === "key" ? " active" : "")}
                onClick={() => setSettingsTab("key")}
              >
                连接加密
              </button>
              <button
                className={"nav-item" + (settingsTab === "general" ? " active" : "")}
                onClick={() => setSettingsTab("general")}
              >
                通用
              </button>
              <button
                className={"nav-item" + (settingsTab === "kb" ? " active" : "")}
                onClick={() => setSettingsTab("kb")}
              >
                知识库
              </button>
              <button
                className={"nav-item" + (settingsTab === "assistant" ? " active" : "")}
                onClick={() => setSettingsTab("assistant")}
              >
                数据助手
              </button>
            </div>

            <div className={"settings-content" + (settingsTab === "kb" || settingsTab === "assistant" ? " kb-content-flush" : "")}>
              {/* --- 模块一：模型设置（LLM） --- */}
              {settingsTab === "model" && (
                <div className="settings-page">
                  <h3>供应商列表</h3>
                  <div className="dim" style={{ fontSize: "var(--fs-xs)", marginBottom: 12 }}>
                    左侧选供应商，右侧编辑。点 + 添加新供应商；composer 里的「我的供应商」段会同步出现。
                  </div>

                  {/* Vendor profiles — the single source of truth for
                   * model configuration. The list on the left is the
                   * "vendor manager"; the form on the right edits the
                   * selected one (or a new one when "+ 添加供应商" is active). */}
                  <div className="settings-group">

                    <div className="vendor-profiles">
                      <ul className="vendor-list">
                        {vendorProfiles.map((p) => {
                          const isEditing = editingVendor === p.id;
                          return (
                            <li
                              key={p.id}
                              className={"vendor-list-item" + (isEditing ? " editing" : "")}
                              onClick={() => {
                                userWantsCreate.current = false;
                                setPresetMenuOpen(false);
                                setEditingVendor(p.id);
                                setVendorDraft({
                                  name: p.name,
                                  base_url: p.base_url,
                                  api_key: "",
                                  api_format: (p.api_format as "openai" | "anthropic") || "openai",
                                  models: p.models.map((m) => ({ name: m.name })),
                                  newModel: "",
                                });
                              }}
                            >
                              <span className={"vendor-dot " + (p.enabled ? "ok" : "off")} />
                              <span className="vendor-list-name">{p.name}</span>
                              <span className="vendor-list-meta">
                                {p.models.length} 个 model
                              </span>
                              <button
                                type="button"
                                className="vendor-list-del"
                                title="删除该供应商"
                                aria-label={"删除供应商 " + p.name}
                                onClick={async (e) => {
                                  // Don't let the click bubble up to the
                                  // <li> (which would also re-select this
                                  // vendor just before we delete it).
                                  e.stopPropagation();
                                  if (!confirm("删除供应商「" + p.name + "」？")) return;
                                  try {
                                    await api.deleteModelAlias(p.id);
                                    setVendorProfiles(await api.listModelAliases());
                                    userWantsCreate.current = false;
                                    // If the deleted vendor was the one being edited,
                                    // clear the selection so the auto-pick effect lands
                                    // on the first remaining vendor. If it wasn't, stay
                                    // on whatever the user was looking at.
                                    if (editingVendor === p.id) setEditingVendor(null);
                                  } catch (err) {
                                    showToast("删除失败: " + String(err));
                                  }
                                }}
                              >
                                <Icon name="close" size={11} />
                              </button>
                            </li>
                          );
                        })}
                        <li
                          className={"vendor-list-item vendor-list-add" + (editingVendor === null ? " editing" : "")}
                          onClick={() => {
                            userWantsCreate.current = true;
                            setEditingVendor(null);
                            setVendorDraft({
                              name: "",
                              base_url: "https://api.openai.com/v1",
                              api_key: "",
                              api_format: "openai",
                              models: [],
                              newModel: "",
                            });
                          }}
                        >
                          <span className="vendor-list-name">+ 添加供应商</span>
                        </li>
                      </ul>
                      <div className="vendor-edit">
                        {/* The top-right X was removed — the delete affordance
                         * now lives in the LEFT list (one delete button per
                         * vendor row), which is where the user expects to
                         * find it. */}
                        <div className="vendor-edit-fields">
                          {/* The 供应商 Field + the preset popover are wrapped
                           * in a `position: relative` container so the
                           * popover anchors to the field rather than the
                           * entire settings content area (the previous
                           * sibling layout pushed the popover to the very
                           * bottom of the modal). */}
                          <div className="field-wrap">
                            {editingVendor === null ? (
                              // CREATE mode: editable name + preset shortcut
                              <Field
                                label="供应商"
                                value={vendorDraft.name}
                                placeholder="自定义名称 或 点右边选预设"
                                onChange={(v) => setVendorDraft({ ...vendorDraft, name: v })}
                                adornment={
                                  <button
                                    type="button"
                                    className="field-preset-trigger"
                                    onClick={() => setPresetMenuOpen(!presetMenuOpen)}
                                    aria-expanded={presetMenuOpen}
                                    title="从预设 vendor 模板填充"
                                  >
                                    预设
                                    <Icon name="chevron-down" size={10} style={{ marginLeft: 2 }} />
                                  </button>
                                }
                              />
                            ) : (
                              // EDIT mode: the vendor's name is its identity
                              // (used as the `id` for the API). It cannot be
                              // changed without breaking the saved config, so
                              // we render it as a read-only display.
                              <div className="field">
                                <span className="field-label">供应商</span>
                                <div className="field-display">
                                  <span className="field-display-name">{vendorDraft.name || "(无名称)"}</span>
                                  <span className="field-display-hint">名称不可修改</span>
                                </div>
                              </div>
                            )}
                            {/* Preset popover — only meaningful in CREATE mode */}
                            {editingVendor === null && presetMenuOpen && (
                              <div className="field-preset-menu">
                                {presets.length === 0 ? (
                                  <div className="dim" style={{ padding: 8, fontSize: "var(--fs-xs)" }}>
                                    暂无可用预设
                                  </div>
                                ) : (() => {
                                  const codingList = presets.filter((p) => p.category === "coding_plan");
                                  const apiList = presets.filter((p) => p.category !== "coding_plan");
                                  const pick = (p: VendorPreset) => {
                                    setVendorDraft({
                                      ...vendorDraft,
                                      name: p.label,
                                      base_url: p.base_url,
                                      api_format: (p.provider === "anthropic" ? "anthropic" : "openai"),
                                      models: [],
                                      newModel: "",
                                    });
                                    setRemoteCatalog(null);
                                    setPresetMenuOpen(false);
                                  };
                                  return (
                                    <>
                                      {codingList.length > 0 && (
                                        <>
                                          <div className="field-preset-group-title">
                                            📦 Coding Plan 专区（订阅计划）
                                          </div>
                                          {codingList.map((p) => (
                                            <button
                                              key={p.id}
                                              type="button"
                                              className="field-preset-item"
                                              onClick={() => pick(p)}
                                            >
                                              <div className="field-preset-item-header">
                                                <span className="field-preset-item-name">{p.label}</span>
                                              </div>
                                              <span className="field-preset-item-meta">
                                                {p.note || `${p.provider} · ${p.base_url}`}
                                              </span>
                                            </button>
                                          ))}
                                        </>
                                      )}
                                      {apiList.length > 0 && (
                                        <>
                                          <div
                                            className="field-preset-group-title"
                                            style={{ marginTop: codingList.length > 0 ? 8 : 0 }}
                                          >
                                            ⚡ 标准 API 模式（按量计费 / 聚合）
                                          </div>
                                          {apiList.map((p) => (
                                            <button
                                              key={p.id}
                                              type="button"
                                              className="field-preset-item"
                                              onClick={() => pick(p)}
                                            >
                                              <div className="field-preset-item-header">
                                                <span className="field-preset-item-name">{p.label}</span>
                                              </div>
                                              <span className="field-preset-item-meta">
                                                {p.note || `${p.provider} · ${p.base_url}`}
                                              </span>
                                            </button>
                                          ))}
                                        </>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                          <Field
                            label="接口地址"
                            value={vendorDraft.base_url}
                            placeholder="https://api.openai.com/v1"
                            mono
                            onChange={(v) => setVendorDraft({ ...vendorDraft, base_url: v })}
                            onBlur={editingVendor ? () => void autoSaveVendor() : undefined}
                          />
                          <Field
                            label="API 密钥"
                            type="password"
                            value={vendorDraft.api_key}
                            placeholder={
                              editingVendor && vendorProfiles.find((p) => p.id === editingVendor)?.enabled
                                ? "已保存（" + (vendorProfiles.find((p) => p.id === editingVendor)!.api_key_hint || "••••") + "），留空保持不变"
                                : "输入密钥"
                            }
                            onChange={(v) => setVendorDraft({ ...vendorDraft, api_key: v })}
                            onBlur={editingVendor ? () => void autoSaveVendor() : undefined}
                            adornment={(() => {
                              const v = editingVendor ? vendorProfiles.find((p) => p.id === editingVendor) : null;
                              if (!v) return undefined;
                              // Consider the draft too — if the user is typing a
                              // fresh key the saved `enabled` flag is still false
                              // (the persist-on-blur hasn't fired yet), so we
                              // treat "draft has any chars" as a positive
                              // signal. Empty draft + saved enabled = still
                              // configured; empty draft + saved disabled = not.
                              const hasKey = v.enabled || vendorDraft.api_key !== "";
                              return (
                                <span
                                  className={"vendor-key-state " + (hasKey ? "ok" : "off")}
                                  title={
                                    v.enabled
                                      ? vendorDraft.api_key
                                        ? "密钥待保存(失焦后落盘)"
                                        : "已配置 API Key"
                                      : "未配置 API Key（保存后可填）"
                                  }
                                >
                                  <Icon
                                    name={hasKey ? "check" : "circle"}
                                    size={12}
                                    variant={hasKey ? "stroke" : "fill"}
                                    style={{ marginRight: 4, verticalAlign: "-1px" }}
                                  />
                                  {hasKey ? "已配" : "未配"}
                                </span>
                              );
                            })()}
                          />
                          {/* 接口协议 — vertical layout (label above select)
                           * via the Field component's `children` slot. The
                           * native select arrow is hidden via `appearance: none`
                           * and replaced by a CSS background-image chevron
                           * (a small `v` shape, see style.css). The Icon-
                           * based chevron from the previous iteration had
                           * positioning issues (the absolute wrapper was
                           * taller than the row, biasing the icon upward and
                           * making it look like an up-arrow at small sizes). */}
                          <Field label="接口协议">
                            <select
                              className="field-input field-input-select"
                              value={vendorDraft.api_format}
                              onChange={(e) => {
                                setVendorDraft({
                                  ...vendorDraft,
                                  api_format: e.target.value as "openai" | "anthropic",
                                });
                                if (editingVendor)
                                  void autoSaveVendor({
                                    api_format: e.target.value as "openai" | "anthropic",
                                  });
                              }}
                            >
                              <option value="openai">OpenAI 兼容 · /v1/chat/completions</option>
                              <option value="anthropic">Anthropic Messages · /v1/messages</option>
                            </select>
                          </Field>
                        </div>
                        {/* Model list — always visible. */}
                        <div className="vendor-models">
                          <div className="vendor-models-head">
                            <span className="vendor-models-title">模型列表</span>
                            <button
                              type="button"
                              className="btn-fetch-models"
                              title="通过 GET /models 接口拉取该服务商支持的最新完整模型目录"
                              disabled={modelsFetching || !vendorDraft.base_url.trim()}
                              onClick={() => void ensureCatalog(true)}
                            >
                              {modelsFetching ? "正在拉取…" : "🔄 从接口拉取模型"}
                            </button>
                          </div>
                          {vendorDraft.models.length === 0 && (
                            <div className="dim" style={{ fontSize: "var(--fs-xs)", marginBottom: 6 }}>
                              还没有 model（填好密钥后点右上角「从接口拉取模型」或下方直接输入添加）
                            </div>
                          )}
                          {vendorDraft.models.map((m) => (
                            <div key={m.name} className="alias-row">
                              <span className="alias-name">{m.name}</span>
                              <span className="alias-meta" />
                              <button
                                className="alias-del"
                                title="删除"
                                onClick={async () => {
                                  const next = vendorDraft.models.filter((x) => x.name !== m.name);
                                  setVendorDraft({ ...vendorDraft, models: next });
                                  // Edit mode: persist the change. Create mode:
                                  // the list is just local until "添加供应商".
                                  if (editingVendor) {
                                    const v = vendorProfiles.find((p) => p.id === editingVendor);
                                    if (!v) return;
                                    try {
                                      await api.saveModelAlias({
                                        id: v.id,
                                        name: v.name,
                                        vendor: v.id,
                                        base_url: v.base_url,
                                        model: "",
                                        api_key: "",
                                        api_format: v.api_format,
                                        models: next,
                                      });
                                      setVendorProfiles(await api.listModelAliases());
                                    } catch (e) {
                                      showToast("删除 model 失败: " + String(e));
                                    }
                                  }
                                }}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <div className="alias-add" style={{ gridTemplateColumns: "1fr auto" }}>
                            <input
                              placeholder={
                                modelsFetching
                                  ? "正在从远程接口拉取最新模型目录…"
                                  : remoteCatalog && remoteCatalog.length > 0
                                  ? `在拉取的 ${remoteCatalog.length} 个模型中搜索 / 输入…`
                                  : "输入 model 名称（按 Enter 或点右侧「+ 添加」）"
                              }
                              value={vendorDraft.newModel}
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="off"
                              spellCheck={false}
                              onFocus={() => {
                                if (remoteCatalog && remoteCatalog.length > 0) {
                                  setModelMenuOpen(true);
                                }
                              }}
                              onChange={(e) => {
                                setVendorDraft({ ...vendorDraft, newModel: e.target.value });
                                if (remoteCatalog && remoteCatalog.length > 0) {
                                  setModelMenuOpen(true);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  setModelMenuOpen(false);
                                  return;
                                }
                                // Pressing Enter in the input submits the new model —
                                // matches the "click + 添加" flow without leaving the
                                // keyboard. An exact (case-insensitive) catalog match
                                // normalizes to the vendor's canonical casing.
                                if (e.key !== "Enter") return;
                                e.preventDefault();
                                const typed = vendorDraft.newModel.trim();
                                if (!typed) return;
                                const canon = remoteCatalog?.find(
                                  (m) => m.toLowerCase() === typed.toLowerCase()
                                );
                                const newName = canon ?? typed;
                                if (vendorDraft.models.some((m) => m.name === newName)) return;
                                addModel(newName);
                              }}
                            />
                            <button
                              className="primary"
                              disabled={
                                !vendorDraft.newModel.trim() ||
                                vendorDraft.models.some((m) => m.name === vendorDraft.newModel.trim())
                              }
                              onClick={() => {
                                const newName = vendorDraft.newModel.trim();
                                if (!newName) return;
                                addModel(newName);
                              }}
                            >
                              + 添加
                            </button>
                            {/* Remote-catalog suggestions, filtered live by the
                             * input text. Already-added ids are hidden — they
                             * are in the list right above. */}
                            {modelMenuOpen && remoteCatalog && remoteCatalog.length > 0 && (
                              <div className="remote-picker">
                                <div className="remote-picker-header">
                                  <span>🌐 远程获取的模型列表（共 {remoteCatalog.length} 个）</span>
                                  {modelsFetching && (
                                    <span className="remote-picker-loading">· 正在刷新…</span>
                                  )}
                                </div>
                                <div className="remote-picker-list">
                                  {(() => {
                                    const q = vendorDraft.newModel.trim().toLowerCase();
                                    const owned = new Set(vendorDraft.models.map((m) => m.name));
                                    const pool = remoteCatalog.filter((m) => !owned.has(m));
                                    const filtered = q
                                      ? pool.filter((m) => m.toLowerCase().includes(q))
                                      : pool;
                                    const visible = filtered.slice(0, 50);
                                    if (visible.length === 0) {
                                      return (
                                        <div className="remote-picker-empty">
                                          {q
                                            ? "无匹配模型 — 按 Enter 或点击右侧「+ 添加」"
                                            : "已全部添加到模型列表中"}
                                        </div>
                                      );
                                    }
                                    return visible.map((m) => (
                                      <button
                                        key={m}
                                        type="button"
                                        className="remote-picker-item"
                                        // onMouseDown (not onClick): fires before
                                        // the input's blur would close the menu.
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          addModel(m);
                                        }}
                                        title="点击添加到模型列表"
                                      >
                                        <span className="remote-picker-name">{m}</span>
                                      </button>
                                    ));
                                  })()}
                                  {(() => {
                                    const q = vendorDraft.newModel.trim().toLowerCase();
                                    const owned = new Set(vendorDraft.models.map((m) => m.name));
                                    const pool = remoteCatalog.filter((m) => !owned.has(m));
                                    const filtered = q
                                      ? pool.filter((m) => m.toLowerCase().includes(q))
                                      : pool;
                                    return filtered.length > 50 ? (
                                      <div className="remote-picker-more">
                                        仅显示前 50 个，继续输入以缩小范围（共 {filtered.length} 个）
                                      </div>
                                    ) : null;
                                  })()}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        {/* EDIT-mode action row. User feedback: the previous
                         * onBlur-only auto-save felt invisible ("为啥地址改
                         * 不了啊 / 保存了连个反馈都没有") — a manual button
                         * with explicit toast feedback makes the save
                         * observable. The onBlur auto-save still runs in
                         * parallel so the convenience isn't lost. */}
                        {editingVendor !== null && (
                          <div className="vendor-edit-save">
                            <span className="vendor-edit-hint">
                              字段失焦会自动保存，点这里手动触发并拿到反馈
                            </span>
                            <button
                              className="btn primary vendor-edit-cta"
                              onClick={async () => {
                                const r = await autoSaveVendor();
                                if (r === "saved") showToast("已保存");
                                else if (r === "unchanged") showToast("无变更");
                                else showToast("保存失败");
                              }}
                            >
                              <Icon name="check" size={14} style={{ marginRight: 6 }} />
                              保存修改
                            </button>
                          </div>
                        )}
                        {/* The bottom action row only shows when creating a new
                         * vendor. For existing vendors, every field auto-saves
                         * on blur and the api_format select saves on change, so
                         * a manual "保存" button is redundant (user feedback).
                         *
                         * The create-mode save now includes the in-progress
                         * model list (vendorDraft.models), so the user can add
                         * models BEFORE clicking 添加供应商 — one save instead
                         * of three. */}
                        {editingVendor === null && (
                          <div className="vendor-edit-create">
                            <span className="vendor-edit-hint">
                              名称和接口地址必填；密钥可以稍后再填
                            </span>
                            <button
                              className="btn primary vendor-edit-cta"
                              disabled={!vendorDraft.name.trim() || !vendorDraft.base_url.trim() || creating}
                              onClick={async () => {
                                if (creating) return;
                                setCreating(true);
                                try {
                                  const next = await api.saveModelAlias({
                                    id: undefined,
                                    name: vendorDraft.name.trim(),
                                    vendor: "custom",
                                    base_url: vendorDraft.base_url.trim(),
                                    model: "",
                                    api_key: vendorDraft.api_key,
                                    api_format: vendorDraft.api_format,
                                    models: vendorDraft.models,
                                  });
                                  setVendorProfiles(await api.listModelAliases());
                                  // Successful add — clear the create latch so a future
                                  // click on the first vendor doesn't get ignored.
                                  userWantsCreate.current = false;
                                  setPresetMenuOpen(false);
                                  setEditingVendor(next.id);
                                  setVendorDraft({
                                    ...vendorDraft,
                                    api_key: "",
                                    // After create, the saved vendor is the source of
                                    // truth for the model list — sync the draft so the
                                    // next "+ 添加" works against the right baseline.
                                    models: next.models.map((m) => ({ name: m.name })),
                                  });
                                  // After add, the new vendor has no active
                                  // model yet — the user has to pick one in
                                  // the composer. Make this explicit so they
                                  // don't think the new vendor is "in use"
                                  // just because the profile is saved.
                                  showToast("已添加供应商，去 composer 选 model 即可用");
                                } catch (e) {
                                  showToast("添加失败: " + String(e));
                                } finally {
                                  setCreating(false);
                                }
                              }}
                            >
                              {creating ? (
                                <>
                                  <span className="vendor-edit-cta-spinner" aria-hidden />
                                  添加中…
                                </>
                              ) : (
                                <>
                                  <Icon name="plus" size={14} style={{ marginRight: 6 }} />
                                  添加供应商
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* --- 模块二：连接加密密钥 (#0) --- */}
              {settingsTab === "key" && (
                <div className="settings-page">
                  <h3>连接加密密钥</h3>
                  <div className="settings-group">
                  <div className={"key-status " + (keyStatus.configured ? "on" : "off")}>
                    当前状态：{keyStatus.configured ? "已配置自定义密钥" : "使用默认密钥（换机器/换人无法解密导出文件）"}
                  </div>
                  {!keyStatus.configured && (
                    <div className="key-warn">
                      ⚠️ 尚未配置自定义密钥。导入/导出用的 system-key 加密将退化为默认密钥，
                      换机器后无法解密。建议在此设置一个自定义密钥（导出与导入两端使用相同密钥即可互通）。
                    </div>
                  )}
                  <label>
                    密钥口令（用于派生 AES 密钥；留空则重置回默认）
                    <input
                      type="password"
                      value={keyField}
                      placeholder="设置一个易记的口令"
                      onChange={(e) => setKeyField(e.target.value)}
                    />
                  </label>
                  </div>
                  <div className="modal-actions">
                    <button className="primary" onClick={() => void saveKey()}>
                      保存密钥并重加密
                    </button>
                  </div>
                  {keyMsg && (
                    <div className={"cfg-msg " + (keyMsg.ok ? "ok" : "err")}>
                      {keyMsg.text}
                    </div>
                  )}
                </div>
              )}

              {/* --- 模块三：通用偏好 --- */}
              {settingsTab === "general" && (
                <div className="settings-page">
                  <h3>通用设置</h3>
                  <div className="settings-group">
                    <label className="cfg-input">
                      <span>
                        单条查询超时（秒）
                        <small>
                          执行 SQL/Redis 命令的服务端兜底时长，超时后会以错误返回。范围 1 ~ 1800，默认 300（5 分钟）。改完即生效，不需要重启。
                        </small>
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={1800}
                        step={30}
                        value={queryTimeoutSecs}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(1800, Math.floor(Number(e.target.value) || 1)));
                          setQueryTimeoutSecs(v);
                          localStorage.setItem("cq_query_timeout_secs", String(v));
                        }}
                      />
                    </label>

                    <label className="cfg-input">
                      <span>
                        SQL 执行历史保留条数
                        <small>
                          记录执行过的 SQL 历史条数上限，超过该数量的最早未收藏历史记录会自动清理。范围 10 ~ 5000，默认 200。改完即生效。
                        </small>
                      </span>
                      <input
                        type="number"
                        min={10}
                        max={5000}
                        step={50}
                        value={queryHistoryLimit}
                        onChange={(e) => {
                          const v = Math.max(10, Math.min(5000, Math.floor(Number(e.target.value) || 10)));
                          setQueryHistoryLimit(v);
                          localStorage.setItem("cq_query_history_limit", String(v));
                          void api.pruneHistory(v);
                        }}
                      />
                    </label>
                  </div>
                </div>
              )}

              {/* --- 模块四：知识库 (ADR-AI-6) --- */}
              {settingsTab === "kb" && (
                <div className="settings-page kb-page">
                  <div className="kb-layout">
                    {/* 左：文档列表 */}
                    <div className="kb-list">
                      <div className="kb-list-header">
                        <div className="kb-header-title">
                          <span>知识库文档</span>
                          <span className="kb-count-pill">{kbDocs.length}</span>
                        </div>
                        <button
                          type="button"
                          className="btn-kb-new"
                          title="新建知识库文档"
                          onClick={startNewKb}
                        >
                          ＋ 新建
                        </button>
                      </div>
                      <div className="kb-list-scroll">
                        {kbDocs.length === 0 && (
                          <div className="kb-empty-box">
                            <span className="kb-empty-icon">📂</span>
                            <span>暂无文档</span>
                            <small>点击上方「＋ 新建」添加业务说明</small>
                          </div>
                        )}
                        {kbDocs.map((d) => {
                          const isCur = kbEditing?.id === d.id;
                          return (
                            <div
                              key={d.id}
                              className={"kb-list-item" + (isCur ? " active" : "")}
                              onClick={() => editKb(d)}
                            >
                              <div className="kb-item-head">
                                <span className="kb-item-icon">📄</span>
                                <span className="kb-list-name" title={d.name}>
                                  {d.name || "未命名文档"}
                                </span>
                              </div>
                              <div className="kb-list-meta">
                                <span className="kb-badge-bind">
                                  {d.bindings.length > 0 ? `🔗 ${d.bindings.length} 处绑定` : "未绑定"}
                                </span>
                                <span className="kb-badge-chars">{d.content.length} 字</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 右：安全顶栏 + 编辑器 */}
                    <div className="kb-right-container">
                      <div className="kb-top-safe-bar">
                        <div className="kb-top-safe-title">
                          <span>📚</span>
                          <span>{kbEditing ? `编辑文档 · ${kbName || kbEditing.name}` : "新建知识库文档"}</span>
                        </div>
                        {kbEditing && (
                          <span className="kb-top-safe-badge">ID: {kbEditing.id}</span>
                        )}
                      </div>
                      <div className="kb-editor">
                      {!kbIsNew && !kbEditing ? (
                        <div className="kb-empty-large">
                          <div className="kb-empty-hero">
                            <div className="kb-empty-hero-icon">📚</div>
                            <h4>知识库与上下文增强</h4>
                            <p>
                              在此维护数据库表结构说明、字段业务含义与口径规范。<br />
                              在已绑定的数据库提问时，AI 会智能检索相关文档作为上下文参考。
                            </p>
                            <button
                              type="button"
                              className="btn btn-primary kb-hero-btn"
                              onClick={startNewKb}
                            >
                              ＋ 新建知识库文档
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
                                  <span>📄</span> 文档信息
                                </span>
                              </div>
                              <div>
                                <label className="kb-label" style={{ marginBottom: "6px" }}>
                                  文档名称 <span style={{ color: "var(--danger-500, #ef4444)" }}>*</span>
                                </label>
                                <input
                                  className="kb-input"
                                  value={kbName}
                                  placeholder="例如：电商订单业务与核心表说明、会员状态口径"
                                  onChange={(e) => setKbName(e.target.value)}
                                  spellCheck={false}
                                  autoCorrect="off"
                                />
                              </div>
                            </div>

                            {/* 卡片 2：文档内容 */}
                            <div className="ast-section-card">
                              <div className="ast-section-header">
                                <span className="ast-section-title">
                                  <span>📝</span> 文档内容（Markdown / 纯文本）
                                  <span className="ast-section-badge">{kbContent.length} 字</span>
                                </span>
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                  <CertPickButton
                                    accept=".txt,.md,.markdown,.text,text/plain,text/markdown"
                                    title="从文件导入（.txt / .md）"
                                    onPick={(t) => setKbContent(t)}
                                    label="导入文件"
                                  />
                                </div>
                              </div>
                              <textarea
                                className="kb-textarea"
                                style={{ minHeight: "180px", fontFamily: "var(--font-mono, monospace)", fontSize: "13px", resize: "vertical" }}
                                value={kbContent}
                                placeholder="编写表含义、核心字段业务口径、常用关联 SQL 等知识内容…&#10;&#10;示例：&#10;## 订单库 (order_db) 业务说明&#10;- orders: 订单主表，status: 1 待支付，2 已完成，3 已取消&#10;- order_items: 订单明细表，以 order_id 关联主表&#10;&#10;## 常用统计口径&#10;- GMV 计算：status IN (1, 2) 且 is_deleted = 0"
                                onChange={(e) => setKbContent(e.target.value)}
                                spellCheck={false}
                                autoCorrect="off"
                              />
                              <div className="ast-section-desc">
                                💡 提示：支持标准 Markdown。AI 会在提问时结合语义检索最相关的片段辅助 SQL 生成与业务口径理解。
                              </div>
                            </div>

                            {/* 卡片 3：绑定连接 / 数据库 */}
                            <div className="ast-section-card">
                              <div className="ast-section-header">
                                <span className="ast-section-title">
                                  <span>🔗</span> 绑定到连接 / 具体数据库
                                  <span className={"ast-section-badge" + (kbBindings.length > 0 ? " highlight" : "")}>
                                    已绑定 {kbBindings.length} 项
                                  </span>
                                </span>
                              </div>
                              <div className="ast-section-desc">
                                绑定后，AI 仅在选中的连接或具体数据库中对话时才自动引用本文档；未绑定时文档处于闲置状态。
                              </div>

                              <div className="ast-bindings-list">
                                {kbBindings.length === 0 ? (
                                  <div style={{ fontSize: "12px", color: "var(--text-tertiary, #888)", padding: "6px 0" }}>
                                    ⚠️ 尚未绑定任何数据库连接（文档当前未生效，请在下方选择连接进行绑定）
                                  </div>
                                ) : (
                                  kbBindings.map((b, i) => {
                                    const c = allConns.find((x) => x.id === b.conn_id);
                                    const isRedis = c?.db_type === "redis";
                                    const dbName = b.database || "整条连接（默认库）";
                                    return (
                                      <div className="ast-binding-chip" key={i} title={`${c?.name ?? b.conn_id} / ${dbName}`}>
                                        <span className="ast-binding-chip-icon">{isRedis ? "🔴" : "🐬"}</span>
                                        <span className="ast-binding-chip-conn">{c ? c.name : b.conn_id}</span>
                                        <span className="ast-binding-chip-sep">/</span>
                                        <span className="ast-binding-chip-db">{dbName}</span>
                                        <button
                                          type="button"
                                          className="ast-binding-chip-del"
                                          title="移除此绑定"
                                          onClick={() => removeKbBinding(i)}
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
                                  value={kbNewConn}
                                  onChange={(e) => {
                                    setKbNewConn(e.target.value);
                                    setKbNewDb("");
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
                                  value={kbNewDb}
                                  disabled={!kbNewConn}
                                  onChange={(e) => setKbNewDb(e.target.value)}
                                >
                                  <option value="">整条连接（默认库）</option>
                                  {(kbDbCache[kbNewConn] ?? []).map((db) => (
                                    <option key={db} value={db}>
                                      🗄 {db}
                                    </option>
                                  ))}
                                  {kbLoadingDbs === kbNewConn && (
                                    <option value="" disabled>
                                      加载库列表中…
                                    </option>
                                  )}
                                </select>

                                <button
                                  type="button"
                                  className="ast-btn-add-bind"
                                  disabled={!kbNewConn}
                                  onClick={() => {
                                    addKbBinding(kbNewConn, kbNewDb === "" ? null : kbNewDb);
                                    setKbNewDb("");
                                  }}
                                >
                                  ＋ 添加绑定
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* 底部固定操作栏（无论文档多长始终固定吸底可见） */}
                          <div className="ast-footer-fixed">
                            <div>
                              {kbMsg && (
                                <div className={"cfg-msg " + (kbMsg.ok ? "ok" : "err")} style={{ margin: 0 }}>
                                  {kbMsg.text}
                                </div>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                              {kbEditing && (
                                <button
                                  type="button"
                                  className="btn btn-danger"
                                  style={{ height: "34px", padding: "0 14px", fontSize: "13px" }}
                                  onClick={() => void deleteKb(kbEditing)}
                                >
                                  删除文档
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ height: "34px", padding: "0 22px", fontSize: "13px", fontWeight: 600 }}
                                onClick={() => void saveKbDoc()}
                              >
                                {kbEditing ? "保存文档" : "创建文档"}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    </div>
                  </div>
                </div>
              )}

              {/* --- 模块五：数据助手 (Data Assistant) --- */}
              {settingsTab === "assistant" && (
                <div className="settings-page kb-page">
                  <div className="kb-layout">
                    {/* 左侧：助手列表 */}
                    <div className="kb-list">
                      <div className="kb-list-header">
                        <div className="kb-header-title">
                          <span>数据助手</span>
                          <span className="kb-count-pill">{assistants.length}</span>
                        </div>
                        <button
                          type="button"
                          className="btn-kb-new"
                          title="新建数据助手"
                          onClick={startNewAssistant}
                        >
                          ＋ 新建
                        </button>
                      </div>
                      <div className="kb-list-scroll">
                        {assistants.length === 0 && (
                          <div className="kb-empty-box">
                            <span className="kb-empty-icon">🤖</span>
                            <span>暂无助手</span>
                            <small>点击上方「＋ 新建」创建专属数据助手</small>
                          </div>
                        )}
                        {assistants.map((a) => {
                          const isCur = astEditing?.id === a.id;
                          return (
                            <div
                              key={a.id}
                              className={"kb-list-item" + (isCur ? " active" : "")}
                              onClick={() => editAssistant(a)}
                            >
                              <div className="kb-item-head">
                                <span className="kb-item-icon">{a.avatar || "🤖"}</span>
                                <span className="kb-list-name" title={a.name}>
                                  {a.name}
                                </span>
                              </div>
                              <div className="kb-list-meta">
                                <span className="kb-badge-bind">
                                  {a.bound_databases && a.bound_databases.length > 0
                                    ? `🗄 绑定 ${a.bound_databases.length} 库`
                                    : "继承会话库"}
                                </span>
                                {a.bound_knowledge_base_ids.length > 0 && (
                                  <span className="kb-badge-chars">
                                    📚 {a.bound_knowledge_base_ids.length} 知识库
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* 右侧：安全顶栏 + 助手配置表单 */}
                    <div className="kb-right-container">
                      <div className="kb-top-safe-bar">
                        <div className="kb-top-safe-title">
                          <span>🤖</span>
                          <span>{astIsNew ? "新建数据助手" : (astEditing ? `编辑助手 · ${astEditing.name}` : "数据助手配置")}</span>
                        </div>
                        {astEditing && (
                          <span className="kb-top-safe-badge">
                            {astEditing.bound_databases?.length ? `已绑定 ${astEditing.bound_databases.length} 库` : "继承会话库"}
                          </span>
                        )}
                      </div>
                      <div className="kb-editor" style={{ overflow: "hidden" }}>
                        {!astIsNew && !astEditing ? (
                          <div className="kb-empty-large">
                            <div className="kb-empty-hero">
                              <div className="kb-empty-hero-icon">🤖</div>
                              <h4>数据助手 (Data Assistant)</h4>
                              <p>
                                预设专属业务提示词，多选关联数据库与知识库。<br />
                                在 Chat 对话框中输入 <code>@助手名</code> 即可随时调用专属专家。
                              </p>
                              <button
                                type="button"
                                className="btn btn-primary kb-hero-btn"
                                onClick={startNewAssistant}
                              >
                                ＋ 创建第一个数据助手
                              </button>
                            </div>
                          </div>
                        ) : (
                          <DataAssistantEditor
                            key={astIsNew ? "new" : astEditing?.id}
                            initialAssistant={astEditing}
                            isNew={astIsNew}
                            allConns={allConns}
                            kbDocs={kbDocs}
                            kbDbCache={kbDbCache}
                            kbLoadingDbs={kbLoadingDbs}
                            loadKbDbs={loadKbDbs}
                            onSave={saveAssistant}
                            onDelete={deleteAssistant}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              className="settings-close"
              onClick={() => setSettingsOpen(false)}
              title="关闭"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {ctxMenu && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <TableContextMenuContainer x={ctxMenu.x} y={ctxMenu.y}>
            {ctxMenu.cell && result?.kind === "table" && (
              <>
                <div className="ctx-title">
                  单元格：
                  {result.columns[ctxMenu.cell.ci] ?? `#${ctxMenu.cell.ci + 1}`}
                </div>
                <button
                  onClick={() =>
                    void copyCell(ctxMenu.cell!.ri, ctxMenu.cell!.ci)
                  }
                >
                  复制单元格
                </button>
                <button
                  onClick={() =>
                    openCellView(ctxMenu.cell!.ri, ctxMenu.cell!.ci)
                  }
                >
                  查看完整内容
                </button>
                <div className="ctx-sep" />
              </>
            )}
            {selCols.size > 0 && result?.kind === "table" && (
              <>
                <div className="ctx-title">
                  {selCols.size === 1
                    ? `列：${result.columns[Array.from(selCols)[0]] ?? ""}`
                    : `已选 ${selCols.size} 列：${
                        Array.from(selCols)
                          .sort((a, b) => a - b)
                          .slice(0, 3)
                          .map((ci) => result.columns[ci] ?? `#${ci + 1}`)
                          .join("、") + (selCols.size > 3 ? " …" : "")
                      }`}
                </div>
                <button onClick={() => void copyColsAs("json")}>
                  {selCols.size === 1
                    ? "复制选中列为 JSON"
                    : `复制选中 ${selCols.size} 列为 JSON`}
                </button>
                {selCols.size > 1 && (
                  <>
                    <button onClick={() => void copyColsAs("csv")}>
                      复制为 CSV（含表头）
                    </button>
                    <button onClick={() => void copyColsAs("tsv")}>
                      复制列值（Tab 分隔）
                    </button>
                  </>
                )}
                <button onClick={() => void copyColsAs("names")}>
                  复制列名
                </button>
                <div className="ctx-sep" />
              </>
            )}
            {ctxMenu.col != null && (
              <>
                <div className="ctx-title">
                  排序：
                  {result?.kind === "table" ? result.columns[ctxMenu.col] : ""}
                </div>
                <button
                  onClick={() => {
                    setGridSort({ col: ctxMenu.col!, dir: "asc" });
                    setCtxMenu(null);
                  }}
                >
                  按此列升序 ▲
                </button>
                <button
                  onClick={() => {
                    setGridSort({ col: ctxMenu.col!, dir: "desc" });
                    setCtxMenu(null);
                  }}
                >
                  按此列降序 ▼
                </button>
                {gridSort?.col === ctxMenu.col && (
                  <button
                    onClick={() => {
                      setGridSort(null);
                      setCtxMenu(null);
                    }}
                  >
                    取消排序
                  </button>
                )}
                <div className="ctx-sep" />
                <div className="ctx-title">
                  列筛选：
                  {result?.kind === "table" ? result.columns[ctxMenu.col] : ""}
                </div>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "contains")}>
                  包含…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "equals")}>
                  等于…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "nequals")}>
                  不等于…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "range")}>
                  数值范围…
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "empty")}>
                  为空
                </button>
                <button onClick={() => void filterColByPrompt(ctxMenu.col!, "notempty")}>
                  非空
                </button>
                {colFilters[ctxMenu.col] && (
                  <button onClick={() => clearColFilter(ctxMenu.col!)}>
                    清除该列筛选
                  </button>
                )}
                <div className="ctx-sep" />
              </>
            )}
            {ctxMenu.rows.length > 0 ? (
              <>
            <div className="ctx-title">复制选中 {ctxMenu.rows.length} 行</div>
            <button onClick={() => void copyRowsAs("json")}>复制为 JSON</button>
            <button
              onClick={() => void copyRowsAs("insert")}
            >
              复制为 INSERT 语句
            </button>
            <button
              onClick={() => void copyRowsAs("update")}
            >
              复制为 UPDATE 语句
              {result?.kind === "table" &&
              (result.primaryKeys?.length ?? 0) === 0
                ? result.columns.some((c) => c.toLowerCase() === "id")
                  ? "（按 ID 定位）"
                  : "（全列定位）"
                : ""}
            </button>
            <button onClick={() => void copyRowsAs("wherein")}>
              复制为 WHERE IN
            </button>
            <button onClick={() => void copyRowsAs("csv")}>
              复制为 CSV
            </button>
              </>
            ) : null}
          </TableContextMenuContainer>
        </>
      )}

      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          onClose={() => setEditorMenu(null)}
          items={buildEditorMenu(editorMenu.hasSel)}
        />
      )}

      {dbPickerOpen && (
        <DbPicker
          tree={tree}
          // Highlight the row that matches whichever context the
          // picker was opened from: chat's own state when the chat
          // + menu opened it, otherwise the active SQL tab.
          activeConnId={dbPickerCallback ? (chatConnId ?? "") : (active?.connId ?? "")}
          activeDb={dbPickerCallback ? chatDb : (active?.db ?? null)}
          onSelect={dbPickerCallback ?? changeTabContext}
          onClose={() => {
            setDbPickerOpen(false);
            setDbPickerCallback(null);
          }}
        />
      )}

      {dlg && (
        <div
          className="modal-mask"
          onMouseDown={() => closeDlg(dlg.kind === "confirm" ? false : null)}
        >
          <div className="modal dialog-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{dlg.title}</h3>
            {dlg.kind === "prompt" ? (
              <input
                id="dlg-input"
                defaultValue={dlg.def}
                autoFocus
                onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  if (e.key === "Enter") closeDlg(v);
                  if (e.key === "Escape") closeDlg(null);
                }}
              />
            ) : dlg.kind === "envType" ? (
              <>
                <input
                  id="env-name-input"
                  value={envDlgName}
                  autoFocus
                  placeholder="环境名称"
                  onChange={(e) => setEnvDlgName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      closeDlg({ name: envDlgName.trim(), dbType: envDlgType });
                    if (e.key === "Escape") closeDlg(null);
                  }}
                />
                <div className="seg">
                  <button
                    className={envDlgType === "mysql" ? "seg-on" : ""}
                    onClick={() => setEnvDlgType("mysql")}
                  >
                    MySQL
                  </button>
                  <button
                    className={envDlgType === "redis" ? "seg-on" : ""}
                    onClick={() => setEnvDlgType("redis")}
                  >
                    Redis
                  </button>
                </div>
              </>
            ) : (
              <p className="modal-msg">{dlg.message}</p>
            )}
            <div className="modal-actions">
              <button
                onClick={() => closeDlg(dlg.kind === "confirm" ? false : null)}
              >
                取消
              </button>
              <button
                className="primary"
                onClick={() => {
                  if (dlg.kind === "prompt") {
                    const el = document.getElementById("dlg-input") as HTMLInputElement | null;
                    closeDlg(el ? el.value : dlg.def);
                  } else if (dlg.kind === "envType") {
                    closeDlg({ name: envDlgName.trim(), dbType: envDlgType });
                  } else {
                    closeDlg(true);
                  }
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI write confirmation (ADR-AI-1 / ADR-AI-4). The turn is blocked on
          this answer, so there is no mask-click / Escape dismissal — an
          accidental click must not silently reject a pending write. */}
      {confirmQueue.length > 0 && (
        <div className="modal-mask">
          <div className="modal ai-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <h3>AI 请求执行写操作</h3>
            <p className="modal-msg">{confirmQueue[0].reason}</p>
            <div className="ai-confirm-meta">
              连接：<b>{confirmQueue[0].connection}</b>
              {" · "}
              库：<b>{confirmQueue[0].db || "默认库"}</b>
              {confirmQueue.length > 1 && (
                <span className="ai-confirm-more">
                  还有 {confirmQueue.length - 1} 条待确认
                </span>
              )}
            </div>
            <pre className="ai-confirm-sql">{confirmQueue[0].sql}</pre>
            <p className="ai-confirm-warn">
              执行后无法自动撤销，请确认语句的 WHERE 条件与影响范围。
            </p>
            <div className="modal-actions">
              <button onClick={() => answerConfirm(false)}>拒绝</button>
              <button className="primary danger" onClick={() => answerConfirm(true)}>
                执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat 消息一键执行 SQL 二次确认弹窗（防误触） */}
      {chatSqlConfirm && (
        <div
          className="modal-mask"
          onClick={() => {
            const res = chatSqlConfirm.resolve;
            setChatSqlConfirm(null);
            res(false);
          }}
        >
          <div className="modal chat-sql-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chat-sql-confirm-head">
              <div className="chat-sql-confirm-title-group">
                <span className="chat-sql-confirm-icon">{chatSqlConfirm.isWrite ? "⚠️" : "⚡"}</span>
                <span className="chat-sql-confirm-title">执行 SQL 确认</span>
                <span className={"chat-sql-confirm-badge " + (chatSqlConfirm.isWrite ? "write" : "read")}>
                  {chatSqlConfirm.isWrite ? "写操作 (写入/变更)" : "只读查询"}
                </span>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  const res = chatSqlConfirm.resolve;
                  setChatSqlConfirm(null);
                  res(false);
                }}
                title="取消 (Esc)"
              >
                ×
              </button>
            </div>
            <div className="chat-sql-confirm-body">
              {/* 目标环境与数据库信息栏（对称单行） */}
              <div className="chat-sql-confirm-meta">
                <div className="chat-sql-confirm-meta-item">
                  <span className="chat-sql-confirm-meta-label">目标环境：</span>
                  <span className="chat-sql-confirm-meta-val">
                    {(() => {
                      const c = allConns.find((x) => x.id === chatSqlConfirm.connId);
                      return `${c?.db_type === "redis" ? "🔴 " : "🐬 "}${chatSqlConfirm.connName}`;
                    })()}
                  </span>
                </div>
                <span className="chat-sql-confirm-meta-divider">/</span>
                <div className="chat-sql-confirm-meta-item">
                  <span className="chat-sql-confirm-meta-label">目标数据库：</span>
                  <span className="chat-sql-confirm-meta-val db">
                    🗄 {chatSqlConfirm.db || "默认库"}
                  </span>
                </div>
              </div>

              {/* 待执行 SQL 预览 */}
              <div className="chat-sql-confirm-preview-wrap">
                <div className="chat-sql-confirm-preview-head">
                  <span>SQL STATEMENT</span>
                  <span>{chatSqlConfirm.sql.length} 字符</span>
                </div>
                <pre className="chat-sql-confirm-preview">{chatSqlConfirm.sql}</pre>
              </div>

              {/* 提示与警告 Banner */}
              <div className={"chat-sql-confirm-alert " + (chatSqlConfirm.isWrite ? "warn" : "info")}>
                <span>{chatSqlConfirm.isWrite ? "⚠️" : "💡"}</span>
                <span>
                  {chatSqlConfirm.isWrite
                    ? "警告：该语句包含写入/修改操作（INSERT / UPDATE / DELETE / REPLACE），确认后将在目标数据库直接生效，并自动留存审计日志。"
                    : "提示：即将向目标数据库发送此查询，执行结果将展示在下方数据结果区。"}
                </span>
              </div>
            </div>
            <div className="modal-actions" style={{ margin: 0, padding: "12px 18px 16px" }}>
              <button
                type="button"
                onClick={() => {
                  const res = chatSqlConfirm.resolve;
                  setChatSqlConfirm(null);
                  res(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={"primary" + (chatSqlConfirm.isWrite ? " danger" : "")}
                onClick={() => {
                  const res = chatSqlConfirm.resolve;
                  setChatSqlConfirm(null);
                  res(true);
                }}
                autoFocus
              >
                {chatSqlConfirm.isWrite ? "确认执行写操作" : "确认执行查询"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {cellTip && (
        <div
          ref={cellTipRef}
          className="cell-tip"
          style={{ left: cellTip.x, top: cellTip.y, maxWidth: cellTip.maxW }}
        >
          {cellTip.text}
          <div className="cell-tip-hint">双击单元格查看完整内容</div>
        </div>
      )}

      {cellView && (
        <div className="modal-mask" onClick={() => setCellView(null)}>
          <div className="modal cell-view-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cell-view-head">
              <span>
                {result?.kind === "table"
                  ? result.columns[cellView.ci] ?? `#${cellView.ci + 1}`
                  : `列 #${cellView.ci + 1}`}
                {" · "}第 {cellView.ri + 1} 行
              </span>
              <button className="icon-btn" onClick={() => setCellView(null)} title="关闭 (Esc)">
                ×
              </button>
            </div>
            <pre className="cell-view-body">{cellView.text}</pre>
            <div className="modal-actions">
              <span className="cell-view-meta">{cellView.text.length.toLocaleString()} 字符</span>
              <div className="spacer" />
              <button onClick={() => void copyText(cellView.text)}>复制</button>
              <button className="primary" onClick={() => setCellView(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {refView && (
        <div className="modal-mask" onClick={() => setRefView(null)}>
          <div
            className="modal cell-view-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cell-view-head">
              <span>
                {(() => {
                  const l = refLabel(refView);
                  return `${l.icon} ${l.name} · ${l.db} · ${l.scope}`;
                })()}
              </span>
              <button
                className="icon-btn"
                onClick={() => setRefView(null)}
                title="关闭 (Esc)"
              >
                ×
              </button>
            </div>
            <pre className="cell-view-body">{refView.sql}</pre>
            <div className="modal-actions">
              <span className="cell-view-meta">
                {refView.sql.length.toLocaleString()} 字符
              </span>
              <div className="spacer" />
              <button onClick={() => void copyText(refView.sql)}>复制</button>
              <button className="primary" onClick={() => setRefView(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

/// Serialize a table result to CSV with proper RFC-4180 quoting.
function fmtCell(c: unknown): string {
  return c == null ? "" : typeof c === "object" ? JSON.stringify(c) : String(c);
}

/** Type-based semantic color class helper (inspired by DBX dataGridTypeColorScheme). */
function getCellStyleClass(text: string, rawVal: unknown): string | undefined {
  if (text === "NULL" || rawVal === null || rawVal === undefined) return "cell--null";
  if (text === "true" || text === "false" || text === "TRUE" || text === "FALSE") return "cell--bool";
  if (/^-?\d+(\.\d+)?$/.test(text)) return "cell--num";
  if (
    /^\d{4}[-/]\d{2}[-/]\d{2}(\s+\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(text) ||
    /^\d{2}:\d{2}:\d{2}$/.test(text)
  ) {
    return "cell--datetime";
  }
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      JSON.parse(text);
      return "cell--json";
    } catch {
      // not valid json, normal text
    }
  }
  return undefined;
}

function toCsv(columns: string[], rows: string[][]): string {
  const esc = (s: string) => {
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [columns.map(esc).join(",")];
  for (const row of rows) lines.push(row.map((c) => esc(c ?? "")).join(","));
  return lines.join("\r\n");
}

/// Export result as CSV. Tauri 2: open system Save dialog and write the file
/// via the fs plugin. Web's `<a download>` is silently intercepted in the
/// Tauri webview, so we must use the official dialog/fs plugins instead.
async function exportCsv(r: Extract<QueryOutput, { kind: "table" }>, ctx: BrowseCtx | null) {
  const csv = toCsv(r.columns, r.rows);
  const base = ctx ? `${ctx.db}.${ctx.table}` : "result";
  const path = await save({
    defaultPath: `${base}-${Date.now()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return; // user cancelled
  await writeTextFile(path, "\uFEFF" + csv);
}

/// Export result as Excel (.xlsx) using the SheetJS library.
async function exportExcel(r: Extract<QueryOutput, { kind: "table" }>, ctx: BrowseCtx | null) {
  // xlsx is dynamically imported so it doesn't bloat the main bundle.
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.aoa_to_sheet([r.columns, ...r.rows]);
  const wb = XLSX.utils.book_new();
  const base = ctx ? `${ctx.db}.${ctx.table}` : "result";
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  // Get binary as ArrayBuffer; cast to Uint8Array for fs plugin's writeFile.
  const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const path = await save({
    defaultPath: `${base}-${Date.now()}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!path) return;
  await writeFile(path, new Uint8Array(ab));
}

/// Export result as JSON. Tauri 2: same dialog+fs pattern as CSV.
async function exportJsonFile(r: Extract<QueryOutput, { kind: "table" }>, ctx: BrowseCtx | null) {
  const json = rowsToJson(r.columns, r.rows);
  const base = ctx ? `${ctx.db}.${ctx.table}` : "result";
  const path = await save({
    defaultPath: `${base}-${Date.now()}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  await writeTextFile(path, json);
}

/// Build a WHERE IN clause from the selected rows' values for a specific
/// column.  Duplicate values are de-duplicated to keep the clause concise.
function rowsToWhereIn(colName: string, colIndex: number, rows: string[][]): string {
  const escId = "`" + colName.replace(/`/g, "``") + "`";
  const seen = new Set<string>();
  const vals: string[] = [];
  for (const r of rows) {
    const v = r[colIndex] ?? "";
    if (!seen.has(v)) {
      seen.add(v);
      vals.push(sqlLit(v));
    }
  }
  // Wrap for readability when there are many values.
  if (vals.length <= 5) {
    return `${escId} IN (${vals.join(", ")})`;
  }
  return `${escId} IN (\n  ${vals.join(",\n  ")}\n)`;
}

/// Serialize a value exactly as MySQL would inline it: NULL keyword, TRUE/FALSE,
/// raw numbers, otherwise a single-quoted + escaped string. The backend emits
/// SQL NULL as the literal string "NULL", so it round-trips correctly.
function sqlLit(v: string): string {
  if (v === "NULL") return "NULL";
  const low = v.toLowerCase();
  if (low === "true") return "TRUE";
  if (low === "false") return "FALSE";
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return "'" + v.replace(/'/g, "''") + "'";
}

/// Selected rows -> pretty JSON array. Numbers/booleans/NULL are typed;
/// everything else stays a string (the grid has no column-type info).
function rowsToJson(columns: string[], rows: string[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = r[i] ?? "";
      const low = v.toLowerCase();
      if (v === "NULL") o[c] = null;
      else if (low === "true") o[c] = true;
      else if (low === "false") o[c] = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) o[c] = Number(v);
      else o[c] = v;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

/// Best-effort extraction of a single table name from a SQL statement's
/// FROM clause. Handles `FROM `table``, `FROM table`, `FROM db.table`, aliases, etc.
function extractTableFromSql(sql: string): string | null {
  if (!sql) return null;
  const clean = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();

  const m = clean.match(
    /\bFROM\s+(?:`([^`]+)`|([a-zA-Z0-9_$]+))(?:\s*\.\s*(?:`([^`]+)`|([a-zA-Z0-9_$]+)))?/i
  );
  if (!m) return null;

  const secondPart = m[3] || m[4];
  const firstPart = m[1] || m[2];
  const table = secondPart || firstPart;
  return table || null;
}

function rowsToInsert(table: string, columns: string[], rows: string[][]): string {
  const escId = (c: string) => "`" + c.replace(/`/g, "``") + "`";
  const cols = columns.map(escId).join(", ");
  const tuples = rows
    .map((r) => "(" + r.map((v) => sqlLit(v ?? "")).join(", ") + ")")
    .join(",\n  ");
  return `INSERT INTO \`${table.replace(/`/g, "``")}\` (${cols}) VALUES\n  ${tuples};`;
}

function rowsToUpdate(
  table: string,
  columns: string[],
  pks: string[],
  rows: string[][]
): string {
  const escId = (c: string) => "`" + c.replace(/`/g, "``") + "`";
  const tname = table.replace(/`/g, "``");

  // Find column indices of primary keys (case-insensitive)
  const pkSet = new Set((pks || []).map((p) => p.toLowerCase()));
  const pkIdx: number[] = [];
  columns.forEach((c, i) => {
    if (pkSet.has(c.toLowerCase())) {
      pkIdx.push(i);
    }
  });

  // If no primary key was specified or found, check if there is an id column
  if (pkIdx.length === 0) {
    const idIndex = columns.findIndex((c) => {
      const low = c.toLowerCase();
      return low === "id" || low.endsWith("_id");
    });
    if (idIndex >= 0) {
      pkIdx.push(idIndex);
    }
  }

  return rows
    .map((r) => {
      let setCols: number[];
      let whereCols: number[];

      if (pkIdx.length > 0) {
        whereCols = pkIdx;
        setCols = columns
          .map((_, i) => i)
          .filter((i) => !pkIdx.includes(i));
        // Edge case: all columns in result are PKs (e.g. SELECT id FROM t)
        if (setCols.length === 0) {
          setCols = pkIdx;
        }
      } else {
        // Fallback when no PK at all: SET all columns, WHERE all columns
        setCols = columns.map((_, i) => i);
        whereCols = columns.map((_, i) => i);
      }

      const setClause = setCols
        .map((i) => `${escId(columns[i])} = ${sqlLit(r[i] ?? "")}`)
        .join(", ");
      const whereClause = whereCols
        .map((i) => `${escId(columns[i])} = ${sqlLit(r[i] ?? "")}`)
        .join(" AND ");

      return `UPDATE \`${tname}\` SET ${setClause} WHERE ${whereClause};`;
    })
    .join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function roleLabel(r: string) {
  return r === "user" ? "你" : r === "assistant" ? "AI" : "工具";
}

/// Thousands separator for token counts — five-digit numbers are common and
/// unreadable unsegmented.
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/// Rough char→token estimate for providers that don't report usage: CJK text
/// ≈ 1 token/char, other text ≈ 1 token per 4 chars. Fallback only — the real
/// numbers come from the provider's `usage` chunk (2026-08-12).
function estimateTokens(s: string): number {
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const rest = s.length - cjk;
  return Math.max(1, Math.ceil(cjk * 1.2 + rest / 4));
}

/// Collapse a SQL reference to a single chip-sized line. Whitespace is
/// flattened so a multi-line statement still reads as one glance-able preview.
function refPreview(sql: string, max = 56): string {
  const one = sql.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/// Human label for a guardrail verdict stored in the audit trail.
function auditLabel(d: string): string {
  switch (d) {
    case "write-approved":
      return "已批准";
    case "write-rejected":
      return "已拒绝";
    case "write-expired":
      return "已超时";
    case "deny":
      return "已阻断";
    case "manual":
      return "手动执行";
    default:
      return d;
  }
}
