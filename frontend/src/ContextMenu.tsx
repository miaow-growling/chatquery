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
 *
 * Menu items are rendered as <div role="menuitem"> instead of <button> to
 * prevent WebKit from associating them with native editable-area actions
 * (e.g. showing a "Paste" tooltip over the editor's context menu).
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
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
        className="ctx-menu"
        style={{ position: "fixed", left: x, top: y }}
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
