import { useState, useCallback } from "react";
import { api } from "./api";

interface PhpUnserializerProps {
  onClose: () => void;
}

type ViewMode = "tree" | "cards";

function PhpClassCard({ name, props }: { name: string; props: Record<string, unknown> }) {
  const [open, setOpen] = useState(true);
  const entries = Object.entries(props).filter(
    ([k]) => !k.startsWith("__") || k === "__php_class__"
  );
  return (
    <div className="php-card">
      <div className="php-card-head" onClick={() => setOpen(!open)}>
        <span className="php-card-arrow">{open ? "▾" : "▸"}</span>
        <span className="php-card-class">{name}</span>
        <span className="php-card-count">{entries.length} 属性</span>
      </div>
      {open && (
        <div className="php-card-body">
          <table className="php-card-table">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <td className="php-card-key">{key}</td>
                  <td className="php-card-val">
                    <PhpValueView value={value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PhpValueView({ value }: { value: unknown }): JSX.Element {
  if (value === null || value === undefined) return <span className="php-null">NULL</span>;
  if (typeof value === "boolean") return <span className="php-bool">{value ? "true" : "false"}</span>;
  if (typeof value === "number") return <span className="php-num">{String(value)}</span>;
  if (typeof value === "string") {
    // Detect regex patterns
    if (value.startsWith("#^") || value.startsWith("/^"))
      return <code className="php-regex">{value}</code>;
    // Detect route patterns
    if (value.includes("/") && !value.includes(" ") && value.length < 120)
      return <code className="php-route">{value}</code>;
    return <span className="php-str">{value}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <div className="php-arr">
        {value.map((v, i) => (
          <div key={i} className="php-arr-item">
            <span className="php-arr-idx">{i}</span>
            <PhpValueView value={v} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.__php_class__) {
      return <PhpClassCard name={obj.__php_class__ as string} props={obj.properties as Record<string, unknown>} />;
    }
    // Plain dict
    const entries = Object.entries(obj).filter(([k]) => !k.startsWith("__"));
    return (
      <div className="php-dict">
        {entries.map(([k, v]) => (
          <div key={k} className="php-dict-item">
            <span className="php-dict-key">{k}</span>
            <PhpValueView value={v} />
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

function JsonTree({ data }: { data: unknown }) {
  return (
    <pre className="php-json">{JSON.stringify(data, null, 2)}</pre>
  );
}

export function PhpUnserializer({ onClose }: PhpUnserializerProps) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewMode>("tree");

  const parse = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const json = await api.phpUnserialize(trimmed);
      const parsed = JSON.parse(json);
      setResult(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [input]);

  return (
    <div className="php-modal">
      <div className="php-modal-head">
        <span className="php-modal-title">🔧 PHP 反序列化</span>
        <div className="php-modal-actions">
          {result != null && (
            <>
              <button
                className={"php-view-btn" + (view === "tree" ? " active" : "")}
                onClick={() => setView("tree")}
              >
                JSON 树
              </button>
              <button
                className={"php-view-btn" + (view === "cards" ? " active" : "")}
                onClick={() => setView("cards")}
              >
                卡片视图
              </button>
            </>
          )}
          <button
            className="php-view-btn"
            onClick={() => {
              if (result != null) navigator.clipboard.writeText(JSON.stringify(result, null, 2));
            }}
            disabled={!result}
          >
            复制 JSON
          </button>
          <button className="php-close-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="php-body">
        <div className="php-input-panel">
          <textarea
            className="php-input"
            placeholder="粘贴 PHP serialize() 数据..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
          <button className="php-parse-btn" onClick={parse} disabled={loading || !input.trim()}>
            {loading ? "解析中..." : "解析 →"}
          </button>
        </div>
        <div className="php-output-panel">
          {loading && <div className="php-status">⏳ 解析中...</div>}
          {error && <div className="php-status php-error">{error}</div>}
          {!loading && !error && !result && (
            <div className="php-status php-hint">
              ← 在左侧粘贴 PHP 序列化数据，点击「解析」查看反序列化结果
            </div>
          )}
          {result != null && view === "tree" && <JsonTree data={result} />}
          {result != null && view === "cards" && (
            <div className="php-cards">
              <PhpValueView value={result} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
