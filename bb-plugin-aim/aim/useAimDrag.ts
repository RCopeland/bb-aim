import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Live size of the desktop (the drag containment area), kept in a ref so
 * the drag always uses the most recent layout even while dragging. */
export interface DragBoundsRef {
  current: { width: number; height: number };
}

/**
 * Pointer-based drag for an absolutely-positioned AIM element. Apply the
 * returned `onPointerDown` handler to a title bar (via `{...drag}`). While
 * dragging, `onMove(x, y)` reports the top-left position clamped to
 * `bounds` (falling back to the current window size); window listeners are
 * added for the duration of the drag and removed on release and cancel.
 */
export function useAimDrag(
  bounds: DragBoundsRef,
  onMove: (x: number, y: number) => void,
) {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Ignore clicks on controls (buttons) inside the title bar.
      if ((event.target as HTMLElement).closest(".aim-ctl,.title-bar-controls")) return;
      event.preventDefault();
      const host = event.currentTarget as HTMLElement;
      const parent = host.closest(".aim-win,.aim-buddy") as HTMLElement | null;
      // The element is absolutely positioned against its offset parent, the
      // desktop root (`.aim-root`), whose origin is offset from the viewport by
      // the app chrome. `event.clientX/Y` are viewport coords, so we must map
      // them into the root's frame or the window trails the cursor (jumps right
      // / down). Cache the root's viewport rect at drag start.
      const root = host.closest(".aim-root") as HTMLElement | null;
      const rootRect = root?.getBoundingClientRect();
      const rect = parent?.getBoundingClientRect();
      // Grab offset within the moved element (viewport-invariant px delta).
      const dx = event.clientX - (rect?.left ?? 0);
      const dy = event.clientY - (rect?.top ?? 0);

      const handleMove = (move: PointerEvent) => {
        const width = bounds.current.width || window.innerWidth;
        const height = bounds.current.height || window.innerHeight;
        // Target position expressed in the desktop root's coordinate frame.
        let x = move.clientX - (rootRect?.left ?? 0) - dx;
        let y = move.clientY - (rootRect?.top ?? 0) - dy;
        if (parent) {
          x = Math.min(Math.max(0, x), Math.max(0, width - parent.offsetWidth));
          y = Math.min(Math.max(0, y), Math.max(0, height - parent.offsetHeight));
        }
        onMove(x, y);
      };
      const end = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", handleMove);
      // End on release AND on cancel so listeners are always cleaned up.
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [bounds, onMove],
  );

  return { onPointerDown, onMouseDown: onPointerDown };
}