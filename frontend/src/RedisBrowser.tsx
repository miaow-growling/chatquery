import { useEffect, useState, useCallback, useMemo, type FormEvent } from "react";
import { api } from "./api";
import type { KeyMeta, QueryOutput, RedisDbInfo, RedisValueView } from "./types";
import { Icon } from "./components/ui";

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtTtl(sec: number): string {
  if (sec <= 0) return "持久";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeDotClass(t: string): string {
  switch (t) {
    case "string": return "string";
    case "hash":   return "hash";
    case "list":   return "list";
    case "set":    return "set";
    case "zset":   return "zset";
    case "stream": return "stream";
    default:       return "none";
  }
}

/** Detect JSON / pretty-print. Returns the formatted string or null. */
function tryFormatJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch { /* not valid JSON */ }
  }
  return null;
}

/** Simple hex dump for binary / non-printable data. */
function toHexView(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const addr = i.toString(16).padStart(8, "0");
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (b) => (b >= 32 && b <= 126) ? String.fromCharCode(b) : ".").join("");
    lines.push(`${addr}  ${hex.padEnd(48)} ${ascii}`);
  }
  return lines.join("\n");
}

type ViewMode = "raw" | "formatted" | "hex";

const PAGE = 200;

// ─── component ──────────────────────────────────────────────────────────────

export interface RedisBrowserProps {
  connId: string;
  db: number;
  showToast: (msg: string) => void;
}

export function RedisBrowser({ connId, db: initialDb, showToast }: RedisBrowserProps) {
  // db 选择
  const [dbList, setDbList] = useState<RedisDbInfo[]>([]);
  const [db, setDb] = useState(initialDb);

  // key 列表
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [keyTotal, setKeyTotal] = useState(0);
  const [keysLoading, setKeysLoading] = useState(false);

  // 选中 key
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [valueResult, setValueResult] = useState<QueryOutput | null>(null);
  const [valueLoading, setValueLoading] = useState(false);

  // 标签页
  const [tab, setTab] = useState<"browser" | "console">("browser");

  // 控制台
  const [consoleCmd, setConsoleCmd] = useState("");
  const [consoleResult, setConsoleResult] = useState<QueryOutput | null>(null);
  const [consoleRunning, setConsoleRunning] = useState(false);

  // 格式化视图
  const [viewMode, setViewMode] = useState<ViewMode>("raw");

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<KeyMeta | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── load db list ──
  const loadDbList = useCallback(() => {
    if (!connId) return;
    api.listRedisDbs(connId).then((dbs) => setDbList(dbs)).catch(() => {});
  }, [connId]);

  useEffect(() => {
    loadDbList();
  }, [loadDbList]);

  const dbOptions = useMemo(() => {
    if (dbList.length === 0) return [{ db, keys: 0 }];
    const hasCurrent = dbList.some((item) => item.db === db);
    if (!hasCurrent) {
      return [...dbList, { db, keys: 0 }].sort((a, b) => a.db - b.db);
    }
    return dbList;
  }, [dbList, db]);

  // ── load keys ──
  const loadKeys = useCallback(async () => {
    if (!connId) return;
    setKeysLoading(true);
    try {
      const metas = await api.listRedisKeysMeta(connId, db, pattern, PAGE);
      setKeys(metas);
      setKeyTotal(metas.length);
    } catch {
      setKeys([]);
      setKeyTotal(0);
    } finally {
      setKeysLoading(false);
    }
  }, [connId, db, pattern]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  // ── browse selected key ──
  const browseKey = useCallback(async (key: string) => {
    setSelectedKey(key);
    setViewMode("raw");
    setValueLoading(true);
    try {
      const r = await api.browseRedisKey(connId, db, key);
      setValueResult(r);
      // Auto-detect format for string values
      if (r.kind === "redis" && r.value?.type === "string") {
        if (tryFormatJson(r.value.value)) {
          setViewMode("formatted");
        }
      }
    } catch {
      setValueResult(null);
    } finally {
      setValueLoading(false);
    }
  }, [connId, db]);

  // ── delete key ──
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteRedisKey(connId, db, deleteTarget.key);
      // remove from list
      setKeys((prev) => prev.filter((k) => k.key !== deleteTarget.key));
      setKeyTotal((prev) => prev - 1);
      loadDbList();
      if (selectedKey === deleteTarget.key) {
        setSelectedKey(null);
        setValueResult(null);
      }
    } catch {
      // silently fail, key list stays
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, connId, db, selectedKey]);

  // ── copy helper ──
  const doCopy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => showToast(`已复制 · ${label}`),
      () => showToast("复制失败"),
    );
  }, [showToast]);

  // ── per-type copy handlers ──
  const copyStringView = useCallback(() => {
    if (!valueResult || valueResult.kind !== "redis" || !valueResult.value || valueResult.value.type !== "string") return;
    const raw = valueResult.value.value;
    let text: string;
    let label: string;
    if (viewMode === "formatted") {
      const formatted = tryFormatJson(raw);
      text = formatted ?? raw;
      label = "格式化";
    } else if (viewMode === "hex") {
      text = toHexView(raw);
      label = "Hex";
    } else {
      text = raw;
      label = "原始";
    }
    doCopy(text, label);
  }, [valueResult, viewMode, doCopy]);

  const copyHash = useCallback(() => {
    if (!valueResult || valueResult.kind !== "redis" || !valueResult.value || valueResult.value.type !== "hash") return;
    const v = valueResult.value;
    const text = v.entries.map((e) => `${e.field}\t${e.value}`).join("\n");
    doCopy(text, `hash · ${v.entries.length} 条`);
  }, [valueResult, doCopy]);

  const copyZset = useCallback(() => {
    if (!valueResult || valueResult.kind !== "redis" || !valueResult.value || valueResult.value.type !== "zset") return;
    const v = valueResult.value;
    const text = v.entries.map((e) => `${e.member}\t${e.score}`).join("\n");
    doCopy(text, `zset · ${v.entries.length} 条`);
  }, [valueResult, doCopy]);

  const copyList = useCallback(() => {
    if (!valueResult || valueResult.kind !== "redis" || !valueResult.value || valueResult.value.type !== "list") return;
    const v = valueResult.value;
    const text = v.entries.map((e) => e.value).join("\n");
    doCopy(text, `list · ${v.entries.length} 条`);
  }, [valueResult, doCopy]);

  const copySet = useCallback(() => {
    if (!valueResult || valueResult.kind !== "redis" || !valueResult.value || valueResult.value.type !== "set") return;
    const v = valueResult.value;
    const text = v.members.join("\n");
    doCopy(text, `set · ${v.members.length} 条`);
  }, [valueResult, doCopy]);

  // ── run console command ──
  const runConsole = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!consoleCmd.trim()) return;
    setConsoleRunning(true);
    try {
      const r = await api.executeQuery(connId, consoleCmd, undefined, 0, 1000);
      setConsoleResult(r);
    } catch (err) {
      setConsoleResult({
        kind: "redis",
        command: consoleCmd,
        lines: [],
        note: String(err),
        truncated: false,
      });
    } finally {
      setConsoleRunning(false);
    }
  };

  // ── renders ──

  const renderStringView = (raw: string) => {
    if (viewMode === "formatted") {
      const formatted = tryFormatJson(raw);
      if (formatted) {
        return <pre className="redis-string-value formatted">{formatted}</pre>;
      }
    }
    if (viewMode === "hex") {
      return <pre className="redis-string-value hex">{toHexView(raw)}</pre>;
    }
    return <div className="redis-string-value">{raw}</div>;
  };

  const renderValueViewer = () => {
    if (!selectedKey) return (
      <div className="rb-empty">
        <div className="rb-empty-icon" aria-hidden="true">
          <Icon name="search" size={20} />
        </div>
        ← 选中左侧键以查看内容
      </div>
    );
    if (valueLoading) return <div className="rb-loading">⏳ 加载中…</div>;
    if (!valueResult || valueResult.kind !== "redis") return <div className="rb-error">⚠ 读取失败</div>;

    const { lines, note, value, ttl, size } = valueResult;

    // 有结构化 value → 类型感知查看器
    if (value) {
      return renderTypedView(value, ttl, size);
    }

    // 回退 flat lines
    return (
      <div className="redis-view">
        <div className="redis-meta">
          {ttl != null && (
            <span className={"redis-meta-ttl" + (ttl > 0 && ttl < 3600 ? " warn" : "")}>
              TTL: {fmtTtl(ttl)}
            </span>
          )}
          {size != null && <span className="redis-meta-size">大小: {fmtSize(size)}</span>}
        </div>
        {lines.length > 0 ? (
          lines.map((l, i) => <div key={i} className="redis-line">{l}</div>)
        ) : (
          <div className="redis-note">{note}</div>
        )}
      </div>
    );
  };

  const renderTypedView = (v: RedisValueView, ttl?: number, size?: number) => (
    <div className="redis-view">
      <div className="redis-meta">
        <span className={"redis-type-badge " + v.type}>{v.type}</span>
        {ttl != null && (
          <span className={"redis-meta-ttl" + (ttl > 0 && ttl < 3600 ? " warn" : "")}>
            TTL: {fmtTtl(ttl)}
          </span>
        )}
        {size != null && <span className="redis-meta-size">大小: {fmtSize(size)}</span>}
      </div>

      {v.type === "string" && (
        <>
          <div className="rb-view-tabs">
            {(["raw", "formatted", "hex"] as ViewMode[]).map((m) => (
              <button
                key={m}
                className={"rb-view-tab" + (viewMode === m ? " active" : "")}
                onClick={() => setViewMode(m)}
              >
                {m === "raw" ? "原始" : m === "formatted" ? "格式化" : "Hex"}
              </button>
            ))}
            <div className="rb-view-tabs-spacer" />
            <button className="rb-copy-btn" onClick={copyStringView} title="复制当前视图内容">
              复制
            </button>
          </div>
          {renderStringView(v.value)}
        </>
      )}

      {v.type === "hash" && (
        <>
          <table className="redis-kv-table">
            <thead>
              <tr><th>Field</th><th>Value</th></tr>
            </thead>
            <tbody>
              {v.entries.map((e, i) => (
                <tr key={i}><td>{e.field}</td><td>{e.value}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="rb-copy-bar">
            <button className="rb-copy-btn" onClick={copyHash}>复制 (TSV · {v.entries.length} 条)</button>
          </div>
        </>
      )}

      {v.type === "list" && (
        <div className="redis-list-view">
          {v.entries.map((e, i) => (
            <div key={i} className="redis-list-item">
              <span className="redis-list-idx">{e.index}</span>
              <span>{e.value}</span>
            </div>
          ))}
          {v.truncated && (
            <div className="redis-truncated-note">
              ⚠ 列表已截断（仅展示前 {v.entries.length} 项）
            </div>
          )}
          <div className="rb-copy-bar">
            <button className="rb-copy-btn" onClick={copyList}>复制 ({v.entries.length} 行)</button>
          </div>
        </div>
      )}

      {v.type === "set" && (
        <>
          <div className="redis-set-grid">
            {v.members.map((m, i) => (
              <span key={i} className="redis-set-tag">{m}</span>
            ))}
          </div>
          {v.truncated && (
            <div className="redis-truncated-note">
              ⚠ 集合已截断（仅展示前 {v.members.length} 项）
            </div>
          )}
          <div className="rb-copy-bar">
            <button className="rb-copy-btn" onClick={copySet}>复制 ({v.members.length} 行)</button>
          </div>
        </>
      )}

      {v.type === "zset" && (
        <>
          <table className="redis-kv-table">
            <thead>
              <tr><th>Member</th><th>Score</th></tr>
            </thead>
            <tbody>
              {v.entries.map((e, i) => (
                <tr key={i}><td>{e.member}</td><td>{e.score}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="rb-copy-bar">
            <button className="rb-copy-btn" onClick={copyZset}>复制 (TSV · {v.entries.length} 条)</button>
          </div>
        </>
      )}

      {v.type === "none" && <div className="redis-note">(key 不存在或已过期)</div>}
    </div>
  );

  // ── main render ──

  return (
    <div className="redis-browser">
      {/* top bar */}
      <div className="rb-topbar">
        <div className="rb-tabs">
          <button className={"rb-tab" + (tab === "browser" ? " active" : "")} onClick={() => setTab("browser")}>
            🔎 浏览器
          </button>
          <button className={"rb-tab" + (tab === "console" ? " active" : "")} onClick={() => setTab("console")}>
            ⌨ 控制台
          </button>
        </div>
        <div className="rb-topbar-actions">
          <span className="rb-db-label">
            DB
            <select value={db} onChange={(e) => { setDb(Number(e.target.value)); setSelectedKey(null); setValueResult(null); }}>
              {dbOptions.map((item) => (
                <option key={item.db} value={item.db}>
                  db{item.db} ({item.keys})
                </option>
              ))}
            </select>
          </span>
          {tab === "browser" && (
            <button className="rb-btn" onClick={() => { loadKeys(); loadDbList(); }} disabled={keysLoading}>
              {keysLoading ? "⏳ 刷新中" : "↻ 刷新"}
            </button>
          )}
        </div>
      </div>

      {/* tab content */}
      {tab === "browser" ? (
        <div className="rb-split">
          {/* left: key list */}
          <div className="rb-keylist">
            <div className="rb-keylist-head">
              <input
                className="rb-pattern"
                placeholder="匹配模式（如 user:*）"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadKeys()}
              />
              {keysLoading && <span className="rb-spinner">⏳</span>}
            </div>
            <div className="rb-keylist-body">
              {keys.length === 0 && !keysLoading ? (
                <div className="rb-empty-keys">
                  暂无匹配的键<br /><b>{pattern}</b>
                </div>
              ) : (
                <table className="rb-key-table">
                  <thead>
                    <tr>
                      <th>键名</th>
                      <th>类型</th>
                      <th>TTL</th>
                      <th>大小</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr
                        key={k.key}
                        className={"rb-key-row" + (selectedKey === k.key ? " selected" : "")}
                        onClick={() => browseKey(k.key)}
                      >
                        <td className="rb-key-name" title={k.key}>{k.key}</td>
                        <td className="rb-key-type">
                          <span className={"rb-type-dot " + typeDotClass(k.key_type)} />
                          {k.key_type}
                        </td>
                        <td className={"rb-key-ttl" + (k.ttl != null && k.ttl > 0 && k.ttl < 3600 ? " expiring" : "")}>
                          {k.ttl != null ? fmtTtl(k.ttl) : "-"}
                        </td>
                        <td className="rb-key-size">{k.size != null ? fmtSize(k.size) : "-"}</td>
                        <td className="rb-key-del" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="rb-key-del-btn"
                            title="删除此键"
                            onClick={() => setDeleteTarget(k)}
                          >
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rb-keylist-foot">
              <span className="rb-keylist-count">{keyTotal} 个键</span>
              {keyTotal >= PAGE && <span className="rb-keylist-cap">已达单页上限</span>}
            </div>
          </div>

          {/* right: value viewer */}
          <div className="rb-value">
            {selectedKey && (
              <div className="rb-value-head">
                <span className="rb-value-key" title={selectedKey}>{selectedKey}</span>
                <div className="rb-value-actions">
                  <button
                    className="rb-btn danger"
                    onClick={() => {
                      const meta = keys.find((k) => k.key === selectedKey);
                      if (meta) setDeleteTarget(meta);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            )}
            <div className="rb-value-body">
              {renderValueViewer()}
            </div>
          </div>
        </div>
      ) : (
        /* console tab */
        <div className="rb-console">
          <form className="rb-cmd-form" onSubmit={(e) => void runConsole(e)}>
            <input
              className="rb-cmd-input"
              placeholder="输入 Redis 命令…"
              value={consoleCmd}
              onChange={(e) => setConsoleCmd(e.target.value)}
              spellCheck={false}
            />
            <button className="rb-cmd-run" type="submit" disabled={consoleRunning || !consoleCmd.trim()}>
              {consoleRunning ? "执行中…" : "执行"}
            </button>
          </form>
          {consoleResult && consoleResult.kind === "redis" && (
            <div className="rb-console-result">
              {consoleResult.lines.length > 0 ? (
                consoleResult.lines.map((l, i) => (
                  <div key={i} className="redis-line">{l}</div>
                ))
              ) : consoleResult.note ? (
                <div className="redis-note">{consoleResult.note}</div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* delete confirm dialog */}
      {deleteTarget && (
        <div className="modal-mask" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0, color: "var(--danger-500)" }}>确认删除</h3>
            <p className="modal-msg">
              确定要删除键 <b style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{deleteTarget.key}</b> 吗？
            </p>
            <p className="modal-msg" style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)" }}>
              此操作不可撤销。该键及其所有数据将被永久删除。
            </p>
            <div className="modal-actions" style={{ borderTop: "none", padding: "var(--sp-3) 0 0" }}>
              <div className="spacer" />
              <button onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
              <button className="primary danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
