import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | {
      type: "item";
      label: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | { type: "sep" };

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 计算右键菜单防越界坐标（当向右或向下超出视口时，自动反转或夹紧在视口边缘内部）。
 */
export function clampMenuPosition(
  initialX: number,
  initialY: number,
  width: number,
  height: number,
  pad = 12
): { x: number; y: number } {
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  let x = initialX;
  let y = initialY;

  // 水平防超出视口
  if (x + width > winW - pad) {
    if (initialX - width >= pad) {
      x = initialX - width;
    } else {
      x = Math.max(pad, winW - width - pad);
    }
  }

  // 垂直防超出视口（核心修复：如果菜单过高且鼠标靠下，自动向上翻转或贴底，避免底部项不可见）
  if (y + height > winH - pad) {
    if (initialY - height >= pad) {
      y = initialY - height;
    } else {
      y = Math.max(pad, winH - height - pad);
    }
  }

  return { x, y };
}

/**
 * 右键菜单自适应定位 hook：初次挂载后测量实际渲染宽高，若越界立即贴合屏幕内。
 */
export function useAutoMenuPosition(initialX: number, initialY: number) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clamped = clampMenuPosition(initialX, initialY, rect.width, rect.height);
    setPos(clamped);
  }, [initialX, initialY]);

  return { pos, ref };
}

/**
 * Floating right-click menu rendered into <body> so it escapes the sidebar's
 * overflow. Closes on any outside left-click, Escape, or window resize — but
 * deliberately NOT on a second right-click (that just replaces the menu via
 * the row's own onContextMenu).
 *
 * Menu items are rendered as <div role="menuitem"> instead of <button> to
 * prevent WebKit from associating them with native editable-area actions
 * (e.g. showing a "Paste" tooltip over the editor's context menu).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const { pos, ref } = useAutoMenuPosition(x, y);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="ctx-backdrop"
        onMouseDown={() => onClose()}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="ctx-menu"
        style={{ position: "fixed", left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        {items.map((it, i) =>
          it.type === "sep" ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <div
              key={i}
              className={
                "ctx-item" +
                (it.danger ? " danger" : "") +
                (it.disabled ? " disabled" : "")
              }
              role="menuitem"
              tabIndex={-1}
              aria-disabled={it.disabled}
              onMouseDown={(e) => {
                // Keep focus in the editor and suppress any native tooltip.
                e.preventDefault();
              }}
              onClick={() => {
                if (it.disabled) return;
                onClose();
                it.onClick();
              }}
            >
              {it.label}
            </div>
          )
        )}
      </div>
    </>,
    document.body
  );
}
