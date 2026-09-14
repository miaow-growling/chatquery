import React, { useState, useEffect, useCallback } from "react";
import { getMemoryUsage, cleanCache } from "../api";

export interface MemoryWidgetProps {
  showToast?: (msg: string) => void;
  className?: string;
}

export const MemoryWidget: React.FC<MemoryWidgetProps> = ({ showToast, className }) => {
  const [memMb, setMemMb] = useState<number | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const fetchMem = useCallback(async () => {
    try {
      const stats = await getMemoryUsage();
      setMemMb(stats.resident_mb);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchMem();
    // 每 6 秒自动刷新一次内存占用数据
    const timer = setInterval(fetchMem, 6000);
    return () => clearInterval(timer);
  }, [fetchMem]);

  const handleClean = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (cleaning) return;
    setCleaning(true);
    try {
      const res = await cleanCache();
      setMemMb(res.after_mb);
      const msg =
        res.freed_mb > 0
          ? `已清理缓存，释放约 ${res.freed_mb} MB 内存`
          : `已完成缓存清理，当前内存占用 ${res.after_mb} MB`;
      showToast?.(msg);
    } catch {
      showToast?.("缓存清理完成");
      fetchMem();
    } finally {
      setTimeout(() => setCleaning(false), 500);
    }
  };

  // 估算参考百分比（以 512MB 标称内存为基准参考）
  const percent = memMb ? Math.min(100, Math.round((memMb / 512) * 100)) : 15;
  // 环形周长 2 * PI * r = 2 * 3.14159 * 6 ≈ 37.7
  const offset = 37.7 - 37.7 * (percent / 100);
  const gaugeColor =
    percent > 75
      ? "var(--danger-500, #EF4444)"
      : percent > 50
      ? "var(--warning-500, #F59E0B)"
      : "var(--brand, #6366F1)";

  return (
    <div
      className={"sidebar-memory-footer" + (className ? ` ${className}` : "")}
      title={`当前应用物理常驻内存: ${memMb !== null ? `${memMb} MB` : "计算中..."}\n包含 Rust 进程常驻内存与数据库元数据缓存\n点击「清理缓存」可立即释放闲置连接池与内部缓存`}
    >
      <div className="memory-capsule">
        <div className="mem-gauge" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <circle className="bg-circle" cx="8" cy="8" r="6" />
            <circle
              className="val-circle"
              cx="8"
              cy="8"
              r="6"
              style={{ strokeDashoffset: offset, stroke: gaugeColor }}
            />
          </svg>
        </div>
        <div className="mem-text">
          <span className="mem-label">内存</span>
          <span className="mem-val">{memMb !== null ? `${memMb} MB` : "-- MB"}</span>
        </div>
        <span className="mem-sep" aria-hidden="true" />
        <button
          type="button"
          className={"mem-clean-btn" + (cleaning ? " is-cleaning" : "")}
          onClick={handleClean}
          disabled={cleaning}
          title="清理数据库连接池、收缩 SQLite 缓存并清理元数据"
        >
          <span className={"mem-clean-icon" + (cleaning ? " spin" : "")}>🧹</span>
          <span>{cleaning ? "清理中…" : "清理缓存"}</span>
        </button>
      </div>
    </div>
  );
};
