import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface ScrollAreaProps {
  children: React.ReactNode;
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}

const THUMB_MIN = 18;
const TRACK_PAD = 3;

/**
 * Custom scroll container with always-visible, Apple-style thin scrollbars.
 *
 * Why not rely on the native scroller: on macOS WKWebView the native scroller
 * is "overlay" — it hides itself when not scrolling and ignores
 * `::-webkit-scrollbar` styling. So we hide the native scrollbar entirely
 * (overflow:hidden + programmatic scroll) and render our own track/thumb that
 * stay visible. Works the same across macOS / Windows / Linux.
 */
export function ScrollArea({ children, className, onContextMenu }: ScrollAreaProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [m, setM] = useState({ v: false, h: false, vh: 0, vtop: 0, hw: 0, hleft: 0 });
  const drag = useRef<{ axis: "v" | "h"; start: number; startPos: number } | null>(null);

  const recompute = useCallback(() => {
    const v = viewRef.current;
    if (!v) return;
    const trackV = v.clientHeight - TRACK_PAD * 2;
    const trackH = v.clientWidth - TRACK_PAD * 2;
    const showV = v.scrollHeight - v.clientHeight > 1;
    const showH = v.scrollWidth - v.clientWidth > 1;
    const vRatio = showV ? v.clientHeight / v.scrollHeight : 0;
    const hRatio = showH ? v.clientWidth / v.scrollWidth : 0;
    const vh = Math.max(vRatio * trackV, showV ? THUMB_MIN : 0);
    const hw = Math.max(hRatio * trackH, showH ? THUMB_MIN : 0);
    const rawV = showV ? (v.scrollTop / (v.scrollHeight - v.clientHeight)) * (trackV - vh) : 0;
    const rawH = showH ? (v.scrollLeft / (v.scrollWidth - v.clientWidth)) * (trackH - hw) : 0;
    const vtop = Math.max(0, Math.min(rawV, trackV - vh));
    const hleft = Math.max(0, Math.min(rawH, trackH - hw));
    setM({ v: showV, h: showH, vh, vtop, hw, hleft });
  }, []);

  useLayoutEffect(() => {
    recompute();
    const v = viewRef.current;
    const c = contentRef.current;
    if (!v || !c) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(v);
    ro.observe(c);
    return () => ro.disconnect();
  }, [recompute]);

  // Native wheel handling (passive:false so we can preventDefault). Falls back
  // to touchpad two-finger scroll (deltaX/deltaY) seamlessly.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : 0;
      let handled = false;
      if (dx !== 0 && v.scrollWidth - v.clientWidth > 1) {
        v.scrollLeft += dx;
        handled = true;
      }
      if (dy !== 0 && v.scrollHeight - v.clientHeight > 1) {
        v.scrollTop += dy;
        handled = true;
      }
      if (handled) e.preventDefault();
    };
    v.addEventListener("wheel", onWheel, { passive: false });
    return () => v.removeEventListener("wheel", onWheel);
  }, []);

  const onThumbDown = (axis: "v" | "h") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const v = viewRef.current!;
    drag.current = {
      axis,
      start: axis === "v" ? v.scrollTop : v.scrollLeft,
      startPos: axis === "v" ? e.clientY : e.clientX,
    };
    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const vv = viewRef.current!;
      const delta = (axis === "v" ? ev.clientY : ev.clientX) - d.startPos;
      const viewport = axis === "v" ? vv.clientHeight : vv.clientWidth;
      const content = axis === "v" ? vv.scrollHeight : vv.scrollWidth;
      const ratio =
        delta / (viewport - viewport * (axis === "v" ? m.vh / vv.clientHeight : m.hw / vv.clientWidth));
      const target = d.start + ratio * (content - viewport);
      if (axis === "v") vv.scrollTop = target;
      else vv.scrollLeft = target;
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onTrackDown = (axis: "v" | "h") => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains(axis === "v" ? "scroll-thumb-v" : "scroll-thumb-h")) return;
    const v = viewRef.current!;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (axis === "v") {
      const ratio = (e.clientY - rect.top) / rect.height;
      v.scrollTop = ratio * (v.scrollHeight - v.clientHeight);
    } else {
      const ratio = (e.clientX - rect.left) / rect.width;
      v.scrollLeft = ratio * (v.scrollWidth - v.clientWidth);
    }
  };

  return (
    <div className={"scroll-area" + (className ? " " + className : "")} onContextMenu={onContextMenu}>
      <div className="scroll-view" ref={viewRef} onScroll={recompute}>
        <div className="scroll-content" ref={contentRef}>
          {children}
        </div>
      </div>
      {m.v && (
        <div className="scroll-track scroll-track-v" onMouseDown={onTrackDown("v")}>
          <div
            className="scroll-thumb scroll-thumb-v"
            style={{ height: `${m.vh}px`, transform: `translateY(${m.vtop}px)` }}
            onMouseDown={onThumbDown("v")}
          />
        </div>
      )}
      {m.h && (
        <div className="scroll-track scroll-track-h" onMouseDown={onTrackDown("h")}>
          <div
            className="scroll-thumb scroll-thumb-h"
            style={{ width: `${m.hw}px`, transform: `translateX(${m.hleft}px)` }}
            onMouseDown={onThumbDown("h")}
          />
        </div>
      )}
    </div>
  );
}
