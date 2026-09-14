import React, { useState, useEffect, useRef } from "react";
import { FilterCondition } from "../types";

export interface ColumnMetaItem {
  name: string;
  data_type?: string;
  column_type?: string;
  key?: string;
  comment?: string | null;
}

export interface TableFilterBarProps {
  columns: string[];
  columnsMeta?: ColumnMetaItem[];
  conditions: FilterCondition[];
  onChangeConditions: (conds: FilterCondition[]) => void;
  onApply?: (whereSql: string) => void;
  onClear?: () => void;
  onCopySql?: (whereSql: string) => void;
  tableName?: string;
}

export const OPERATOR_OPTIONS = [
  { op: "=", label: "等于 (Equals)", desc: "= 'val'" },
  { op: "<>", label: "不等于 (Not Equals)", desc: "<> 'val'" },
  { op: ">", label: "大于 (Greater Than)", desc: "> val" },
  { op: ">=", label: "大于等于 (GTE)", desc: ">= val" },
  { op: "<", label: "小于 (Less Than)", desc: "< val" },
  { op: "<=", label: "小于等于 (LTE)", desc: "<= val" },
  { op: "LIKE", label: "包含 (LIKE)", desc: "LIKE '%val%'" },
  { op: "NOT LIKE", label: "不包含 (NOT LIKE)", desc: "NOT LIKE '%val%'" },
  { op: "IN", label: "列表包含 (IN)", desc: "IN (a, b, c)" },
  { op: "IS NULL", label: "为空 (IS NULL)", desc: "IS NULL" },
  { op: "IS NOT NULL", label: "非空 (IS NOT NULL)", desc: "IS NOT NULL" },
];

export function buildWhereSql(conditions: FilterCondition[]): string {
  const parts: string[] = [];
  conditions.forEach((c) => {
    if (c.enabled === false) return;
    let clause = "";
    const colName = c.col.includes(" ") || /^[0-9]/.test(c.col) ? `\`${c.col}\`` : c.col;

    if (c.op === "IS NULL") {
      clause = `${colName} IS NULL`;
    } else if (c.op === "IS NOT NULL") {
      clause = `${colName} IS NOT NULL`;
    } else if (c.op === "LIKE") {
      clause = `${colName} LIKE '%${c.val.replace(/'/g, "''")}%'`;
    } else if (c.op === "NOT LIKE") {
      clause = `${colName} NOT LIKE '%${c.val.replace(/'/g, "''")}%'`;
    } else if (c.op === "IN") {
      const cleanVal = c.val.trim().replace(/^\(|\)$/g, "");
      clause = `${colName} IN (${cleanVal})`;
    } else {
      const isNum = !Number.isNaN(Number(c.val)) && c.val.trim() !== "";
      if (isNum) {
        clause = `${colName} ${c.op} ${c.val.trim()}`;
      } else {
        clause = `${colName} ${c.op} '${c.val.replace(/'/g, "''")}'`;
      }
    }

    if (parts.length === 0) {
      parts.push(clause);
    } else {
      parts.push(`${c.logic || "AND"} ${clause}`);
    }
  });

  return parts.join(" ");
}

export function parseWhereSql(sql: string, columns: string[]): FilterCondition[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];

  // Remove leading WHERE if present
  const body = trimmed.replace(/^WHERE\s+/i, "");
  // Split on AND/OR
  const tokens = body.split(/\s+(AND|OR)\s+/i);
  const result: FilterCondition[] = [];

  let currentLogic: "AND" | "OR" = "AND";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token) continue;
    if (token.toUpperCase() === "AND") {
      currentLogic = "AND";
      continue;
    }
    if (token.toUpperCase() === "OR") {
      currentLogic = "OR";
      continue;
    }

    // Try parsing token into col, op, val
    // Check IS NULL / IS NOT NULL
    const nullMatch = token.match(/^`?([a-zA-Z0-9_]+)`?\s+IS\s+(NOT\s+NULL|NULL)$/i);
    if (nullMatch) {
      const col = nullMatch[1];
      const isNot = nullMatch[2].toUpperCase().includes("NOT");
      result.push({
        id: "c_" + Math.random().toString(36).slice(2, 7),
        col,
        op: isNot ? "IS NOT NULL" : "IS NULL",
        val: "",
        logic: currentLogic,
      });
      continue;
    }

    // Check LIKE / NOT LIKE
    const likeMatch = token.match(/^`?([a-zA-Z0-9_]+)`?\s+(NOT\s+LIKE|LIKE)\s+'%?([^']*)%?'$/i);
    if (likeMatch) {
      const col = likeMatch[1];
      const op = likeMatch[2].toUpperCase().includes("NOT") ? "NOT LIKE" : "LIKE";
      const val = likeMatch[3];
      result.push({
        id: "c_" + Math.random().toString(36).slice(2, 7),
        col,
        op,
        val,
        logic: currentLogic,
      });
      continue;
    }

    // Check operators (=, <>, !=, >=, <=, >, <)
    const opMatch = token.match(/^`?([a-zA-Z0-9_]+)`?\s*(=|<>|!=|>=|<=|>|<)\s*'?([^']*)'?$/);
    if (opMatch) {
      const col = opMatch[1];
      let op = opMatch[2];
      if (op === "!=") op = "<>";
      const val = opMatch[3];
      result.push({
        id: "c_" + Math.random().toString(36).slice(2, 7),
        col,
        op,
        val,
        logic: currentLogic,
      });
      continue;
    }

    // Fallback: match first word as column if in columns list
    const firstWord = token.split(/\s+/)[0].replace(/[`'"]/g, "");
    if (columns.includes(firstWord)) {
      result.push({
        id: "c_" + Math.random().toString(36).slice(2, 7),
        col: firstWord,
        op: "LIKE",
        val: token.slice(firstWord.length).trim().replace(/^LIKE\s+/i, "").replace(/['%]/g, ""),
        logic: currentLogic,
      });
    }
  }

  return result;
}

export const TableFilterBar: React.FC<TableFilterBarProps> = ({
  columns,
  columnsMeta,
  conditions,
  onChangeConditions,
  onApply,
  onClear,
  onCopySql,
  tableName,
}) => {
  const [isRawSqlMode, setIsRawSqlMode] = useState(false);
  const [rawSql, setRawSql] = useState("");
  const [activeOpMenu, setActiveOpMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [activeColMenu, setActiveColMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [colSearch, setColSearch] = useState("");
  const [showIntelliSense, setShowIntelliSense] = useState(false);
  const [intelliFilteredCols, setIntelliFilteredCols] = useState<string[]>([]);
  const rawInputRef = useRef<HTMLInputElement>(null);

  // Sync conditions to rawSql whenever conditions change (unless user is actively typing in raw mode)
  useEffect(() => {
    if (!isRawSqlMode) {
      setRawSql(buildWhereSql(conditions));
    }
  }, [conditions, isRawSqlMode]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleOutside = () => {
      setActiveOpMenu(null);
      setActiveColMenu(null);
      setShowIntelliSense(false);
    };
    window.addEventListener("click", handleOutside);
    return () => window.removeEventListener("click", handleOutside);
  }, []);

  const handleToggleMode = () => {
    if (!isRawSqlMode) {
      // Switch from Wizard to Raw SQL
      setRawSql(buildWhereSql(conditions));
      setIsRawSqlMode(true);
      setTimeout(() => rawInputRef.current?.focus(), 50);
    } else {
      // Switch from Raw SQL to Wizard
      const parsed = parseWhereSql(rawSql, columns);
      if (parsed.length > 0 || rawSql.trim() === "") {
        onChangeConditions(parsed);
      }
      setIsRawSqlMode(false);
    }
  };

  const handleAddCondition = () => {
    const defaultCol = columns[0] || "id";
    const newCond: FilterCondition = {
      id: "c_" + Math.random().toString(36).slice(2, 8),
      col: defaultCol,
      op: "=",
      val: "",
      logic: "AND",
      enabled: true,
    };
    onChangeConditions([...conditions, newCond]);
  };

  const handleRemoveCondition = (id: string) => {
    onChangeConditions(conditions.filter((c) => c.id !== id));
  };

  const handleUpdateCondition = (id: string, patch: Partial<FilterCondition>) => {
    onChangeConditions(
      conditions.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  };

  const handleRawSqlChange = (val: string) => {
    setRawSql(val);
    // IntelliSense detection: check the word before cursor
    const lastWordMatch = val.match(/([a-zA-Z0-9_]+)$/);
    if (lastWordMatch) {
      const prefix = lastWordMatch[1].toLowerCase();
      const hits = columns.filter((c) => c.toLowerCase().includes(prefix));
      setIntelliFilteredCols(hits);
      setShowIntelliSense(hits.length > 0);
    } else {
      setShowIntelliSense(false);
    }
  };

  const handleSelectIntelliSense = (colName: string) => {
    const updated = rawSql.replace(/([a-zA-Z0-9_]+)$/, colName + " = ");
    setRawSql(updated);
    setShowIntelliSense(false);
    rawInputRef.current?.focus();
  };

  const handleRawSqlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      if (showIntelliSense && intelliFilteredCols.length > 0) {
        handleSelectIntelliSense(intelliFilteredCols[0]);
        return;
      }
      const parsed = parseWhereSql(rawSql, columns);
      onChangeConditions(parsed);
      if (onApply) onApply(rawSql);
    } else if (e.key === "Escape") {
      setShowIntelliSense(false);
    }
  };

  const handleApplyClick = () => {
    const sql = isRawSqlMode ? rawSql : buildWhereSql(conditions);
    if (isRawSqlMode) {
      const parsed = parseWhereSql(rawSql, columns);
      onChangeConditions(parsed);
    }
    if (onApply) onApply(sql);
  };

  const handleCopySqlClick = () => {
    const where = isRawSqlMode ? rawSql.trim() : buildWhereSql(conditions).trim();
    const full = where
      ? `SELECT * FROM \`${tableName || "table"}\` WHERE ${where} LIMIT 200;`
      : `SELECT * FROM \`${tableName || "table"}\` LIMIT 200;`;
    if (onCopySql) {
      onCopySql(full);
    } else {
      navigator.clipboard?.writeText(full);
    }
  };

  return (
    <div className="where-builder-bar">
      <div className="where-badge" title="SQL WHERE 过滤子句">WHERE</div>

      {!isRawSqlMode ? (
        <>
          <div className="condition-pill-list">
            {conditions.map((c, idx) => {
              const meta = columnsMeta?.find((m) => m.name === c.col);
              const isNoValOp = c.op === "IS NULL" || c.op === "IS NOT NULL";

              return (
                <React.Fragment key={c.id}>
                  {idx > 0 && (
                    <button
                      type="button"
                      className="join-logic-btn"
                      title="点击切换 AND / OR 逻辑关系"
                      onClick={() =>
                        handleUpdateCondition(c.id, {
                          logic: c.logic === "OR" ? "AND" : "OR",
                        })
                      }
                    >
                      {c.logic || "AND"}
                    </button>
                  )}
                  <div className={"condition-pill" + (c.enabled === false ? " disabled" : "")}>
                    {/* Column dropdown button */}
                    <button
                      type="button"
                      className="pill-field-btn"
                      title="点击选择目标列"
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setActiveColMenu({ id: c.id, x: r.left, y: r.bottom + 4 });
                        setColSearch("");
                        setActiveOpMenu(null);
                      }}
                    >
                      {meta?.key === "PRI" ? "🔑 " : ""}
                      <span>{c.col}</span>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {/* Operator dropdown button */}
                    <button
                      type="button"
                      className="pill-operator-btn"
                      title="点击鼠标切换关系运算符 (> = >= = <> like)"
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setActiveOpMenu({ id: c.id, x: r.left, y: r.bottom + 4 });
                        setActiveColMenu(null);
                      }}
                    >
                      <span>{c.op}</span>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {/* Value input (hidden for IS NULL / IS NOT NULL) */}
                    {!isNoValOp && (
                      <input
                        className="pill-value-input"
                        placeholder="值..."
                        value={c.val}
                        onChange={(e) => handleUpdateCondition(c.id, { val: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleApplyClick();
                        }}
                      />
                    )}

                    {/* Remove button */}
                    <span
                      className="pill-del-btn"
                      title="删除此条件"
                      onClick={() => handleRemoveCondition(c.id)}
                    >
                      &times;
                    </span>
                  </div>
                </React.Fragment>
              );
            })}

            <button
              type="button"
              className="btn-add-condition"
              onClick={handleAddCondition}
              title="添加新筛选条件"
            >
              + 添加条件
            </button>
          </div>
        </>
      ) : (
        /* Raw SQL Hand-write Mode */
        <div className="raw-sql-container">
          <input
            ref={rawInputRef}
            type="text"
            className="raw-sql-input"
            placeholder="输入原生 WHERE 表达式，如: status = 'PAID' AND pay_amount >= 100..."
            value={rawSql}
            onChange={(e) => handleRawSqlChange(e.target.value)}
            onKeyDown={handleRawSqlKeyDown}
          />
          {showIntelliSense && intelliFilteredCols.length > 0 && (
            <div className="intellisense-popup" onClick={(e) => e.stopPropagation()}>
              <div className="intellisense-title">字段补全推荐 (回车或点击插入)</div>
              {intelliFilteredCols.slice(0, 8).map((colName) => (
                <div
                  key={colName}
                  className="intellisense-item"
                  onClick={() => handleSelectIntelliSense(colName)}
                >
                  <span>{colName}</span>
                  <span className="intellisense-tag tag-col">COL</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Right-aligned action buttons */}
      <div className="where-bar-actions">
        <button
          type="button"
          className="tool-btn primary"
          onClick={handleApplyClick}
          title="应用筛选条件并执行查询 (Enter)"
        >
          应用
        </button>

        <button
          type="button"
          className="mode-switch-btn"
          onClick={handleToggleMode}
          title={isRawSqlMode ? "切换为向导积木点选模式" : "切换为手写 SQL 表达式"}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>{isRawSqlMode ? "向导点选" : "手写 SQL"}</span>
        </button>

        {onClear && (
          <button
            type="button"
            className="tool-btn"
            style={{ padding: "3px 6px" }}
            onClick={onClear}
            title="清空所有过滤条件"
          >
            清空
          </button>
        )}

        <button
          type="button"
          className="tool-btn"
          style={{ padding: "3px 6px" }}
          onClick={handleCopySqlClick}
          title="复制完整带有 WHERE 的 SELECT 语句"
        >
          复制 SQL
        </button>
      </div>

      {/* Operator Dropdown Popup */}
      {activeOpMenu && (
        <div
          className="op-dropdown-menu"
          style={{ left: activeOpMenu.x, top: activeOpMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="op-menu-header">选择关系运算符</div>
          {OPERATOR_OPTIONS.map((item) => (
            <div
              key={item.op}
              className="op-menu-item"
              onClick={() => {
                handleUpdateCondition(activeOpMenu.id, { op: item.op });
                setActiveOpMenu(null);
              }}
            >
              <span className="op-symbol">{item.op}</span>
              <span className="op-desc">{item.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Column Dropdown Popup */}
      {activeColMenu && (
        <div
          className="col-dropdown-menu"
          style={{ left: activeColMenu.x, top: activeColMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="op-menu-header">切换目标字段</div>
          <div style={{ padding: "4px 8px" }}>
            <input
              type="text"
              className="col-search-input"
              placeholder="快速搜列名..."
              autoFocus
              value={colSearch}
              onChange={(e) => setColSearch(e.target.value)}
            />
          </div>
          <div className="col-menu-scroll">
            {columns
              .filter((col) => !colSearch || col.toLowerCase().includes(colSearch.toLowerCase()))
              .map((col) => {
                const meta = columnsMeta?.find((m) => m.name === col);
                return (
                  <div
                    key={col}
                    className="col-menu-item"
                    onClick={() => {
                      handleUpdateCondition(activeColMenu.id, { col });
                      setActiveColMenu(null);
                    }}
                  >
                    <span>{meta?.key === "PRI" ? "🔑" : "▤"}</span>
                    <span className="col-name-label">{col}</span>
                    {(meta?.column_type || meta?.data_type) && (
                      <span className="col-type-tag">{meta.column_type || meta.data_type}</span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};
