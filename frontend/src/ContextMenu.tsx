import { useEffect } from "react";
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
 * Floating right-click menu rendered into <body> so it escapes the sidebar's
 * overflow. Closes on any outside left-click, Escape, or window resize — but
 * deliberately NOT on a second right-click (that just replaces the menu via
 * the row's own onContextMenu).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onDocClick = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => onClose();
    window.addEventListener("click", onDocClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("click", onDocClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="ctx-menu"
      style={{ position: "fixed", left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.type === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={"ctx-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
