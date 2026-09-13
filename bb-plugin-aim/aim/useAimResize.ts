import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DragBoundsRef } from "./useAimDrag";

export type ResizeCorner = "se" | "sw" | "ne" | "nw";

/** A window's position + size, all in the desktop root's coordinate frame. */
export interface ResizeTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_W = 232;
export const MIN_H = 220;

/** Clamp v into [lo, hi], guarding hi < lo by using the larger bound. */
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Corner-resize for an absolutely-positioned AIM window.
 *
 * Applying the returned `onPointerDown` to a `.aim-win-resize` handle drags
 * that corner of the window. Like `useAimDrag`, cursor coords (viewport) are
 * mapped into the desktop root's frame via the root rect, and the resulting
 * top-left + size are reported through `onResize` in root-relative px. The
 * window is clamped to a minimum size and to the desktop bounds, and west /
 * north handles keep the opposite edge pinned so the drag feels natural.
 *
 * Call once per corner (se/sw/ne/nw); each handle re-reads the live window
 * rect at pointerdown, so stale state is never applied.
 */
export function useAimResize(
  bounds: DragBoundsRef,
  corner: ResizeCorner,
  onResize: (next: ResizeTarget) => void,
  onFocus?: () => void,
) {
  const handle = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onFocus?.();

      const host = event.currentTarget as HTMLElement;
      const win = host.closest(".aim-win") as HTMLElement | null;
      const root = host.closest(".aim-root") as HTMLElement | null;
      const rootRect = root?.getBoundingClientRect();
      const winRect = win?.getBoundingClientRect();
      // Current window rect mapped into the root frame.
      const startX = (winRect?.left ?? 0) - (rootRect?.left ?? 0);
      const startY = (winRect?.top ?? 0) - (rootRect?.top ?? 0);
      const startW = winRect?.width ?? 0;
      const startH = winRect?.height ?? 0;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const Bw = bounds.current.width;
      const Bh = bounds.current.height;

      const handleMove = (move: PointerEvent) => {
        const dx = move.clientX - startClientX;
        const dy = move.clientY - startClientY;
        let next: ResizeTarget;
        switch (corner) {
          case "se": {
            next = {
              x: startX,
              y: startY,
              width: clamp(startW + dx, MIN_W, Bw - startX),
              height: clamp(startH + dy, MIN_H, Bh - startY),
            };
            break;
          }
          case "sw": {
            // Right edge stays pinned; west edge follows the cursor.
            const rightEdge = startX + startW;
            const w = clamp(startW - dx, MIN_W, rightEdge);
            next = {
              x: rightEdge - w,
              y: startY,
              width: w,
              height: clamp(startH + dy, MIN_H, Bh - startY),
            };
            break;
          }
          case "ne": {
            // Bottom edge stays pinned; north edge follows the cursor.
            const bottom = startY + startH;
            const h = clamp(startH - dy, MIN_H, bottom);
            next = {
              x: startX,
              y: bottom - h,
              width: clamp(startW + dx, MIN_W, Bw - startX),
              height: h,
            };
            break;
          }
          case "nw": {
            const rightEdge = startX + startW;
            const bottom = startY + startH;
            const w = clamp(startW - dx, MIN_W, rightEdge);
            const h = clamp(startH - dy, MIN_H, bottom);
            next = { x: rightEdge - w, y: bottom - h, width: w, height: h };
            break;
          }
        }
        onResize(next);
      };
      const end = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [bounds, corner, onResize, onFocus],
  );

  return { onPointerDown: handle };
}