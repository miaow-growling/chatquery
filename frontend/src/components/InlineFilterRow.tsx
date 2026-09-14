import React, { useState, useEffect } from "react";
import { OPERATOR_OPTIONS } from "./TableFilterBar";

export interface InlineFilterRowProps {
  columns: string[];
  editable?: boolean;
  colFilters: Record<string, { op: string; val: string }>;
  onColChange: (col: string, op: string, val: string) => void;
  onColClear: (col: string) => void;
  onApply?: () => void;
}

export const InlineFilterRow: React.FC<InlineFilterRowProps> = ({
  columns,
  editable,
  colFilters,
  onColChange,
  onColClear,
  onApply,
}) => {
  const [activeMenuCol, setActiveMenuCol] = useState<{ col: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const handleOutside = () => setActiveMenuCol(null);
    window.addEventListener("click", handleOutside);
    return () => window.removeEventListener("click", handleOutside);
  }, []);

  const handleOpClick = (e: React.MouseEvent, col: string) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setActiveMenuCol({ col, x: r.left, y: r.bottom + 4 });
  };

  const handleSelectOp = (op: string) => {
    if (!activeMenuCol) return;
    const col = activeMenuCol.col;
    const current = colFilters[col] || { op: "=", val: "" };
    onColChange(col, op, current.val);
    setActiveMenuCol(null);
  };

  return (
    <tr className="filter-tr">
      {/* 行号列占位 */}
      <th className="row-num filter-th-row-num" title="行内即时过滤 (快捷键: ⌘⇧F 显示/隐藏)">
        ⚲
      </th>

      {/* 如果表可编辑，占位操作列 */}
      {editable && <th className="row-action-col filter-th-action" />}

      {/* 每一列的行内过滤框 */}
      {columns.map((col) => {
        const filterState = colFilters[col] || { op: col === "order_no" || col.includes("time") || col.includes("date") ? "LIKE" : "=", val: "" };
        const hasVal = filterState.val.trim().length > 0;

        return (
          <th key={col} className="filter-th-cell">
            <div className={"inline-filter-input-wrap" + (hasVal ? " has-val" : "")}>
              {/* 可点击微型运算符徽标 */}
              <span
                className="col-op-clickable"
                title="点击鼠标切换该列运算符 (> = >= = <> like)"
                onClick={(e) => handleOpClick(e, col)}
              >
                {filterState.op}
              </span>

              {/* 输入框 */}
              <input
                className="inline-filter-input"
                placeholder={filterState.op === "LIKE" ? "包含..." : "过滤..."}
                value={filterState.val}
                onChange={(e) => onColChange(col, filterState.op, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && onApply) {
                    onApply();
                  }
                }}
              />

              {/* 清除按钮 */}
              {hasVal && (
                <span
                  className="clear-col-val"
                  title="清除该列过滤"
                  onClick={(e) => {
                    e.stopPropagation();
                    onColClear(col);
                  }}
                >
                  &times;
                </span>
              )}
            </div>
          </th>
        );
      })}

      {/* 弹出式运算符菜单 */}
      {activeMenuCol && (
        <div
          className="op-dropdown-menu"
          style={{ left: activeMenuCol.x, top: activeMenuCol.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="op-menu-header">选择【{activeMenuCol.col}】的运算符</div>
          {OPERATOR_OPTIONS.map((item) => (
            <div
              key={item.op}
              className="op-menu-item"
              onClick={() => handleSelectOp(item.op)}
            >
              <span className="op-symbol">{item.op}</span>
              <span className="op-desc">{item.label}</span>
            </div>
          ))}
        </div>
      )}
    </tr>
  );
};
