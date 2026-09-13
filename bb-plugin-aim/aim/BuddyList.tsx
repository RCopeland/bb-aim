import { useCallback, useMemo, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { threadPresence, presenceLabel } from "./types";
import { useAimDrag, type DragBoundsRef } from "./useAimDrag";

export interface BuddyListProps {
  threads: readonly PluginSidebarThread[];
  openThreadIds: ReadonlySet<string>;
  visible: boolean;
  position: { x: number; y: number };
  bounds: DragBoundsRef;
  onDismiss: () => void;
  onMove: (x: number, y: number) => void;
  onBuddyClick: (threadId: string) => void;
}

/**
 * Split the flat sidebar `threads` into roots + a parent → children map.
 * Roots are top-level threads (`parentThreadId === null`); threads whose
 * parent isn't in the list (orphans) are promoted to roots so nothing is
 * ever dropped. Children preserve source order.
 */
function buildTree(threads: readonly PluginSidebarThread[]): {
  roots: PluginSidebarThread[];
  children: Map<string, PluginSidebarThread[]>;
} {
  const byId = new Map<string, PluginSidebarThread>();
  for (const t of threads) byId.set(t.id, t);

  const children = new Map<string, PluginSidebarThread[]>();
  const roots: PluginSidebarThread[] = [];
  for (const t of threads) {
    if (t.parentThreadId === null) {
      roots.push(t);
      continue;
    }
    // parentThreadId references another thread in the list → nest it.
    if (byId.has(t.parentThreadId)) {
      const arr = children.get(t.parentThreadId) ?? [];
      arr.push(t);
      children.set(t.parentThreadId, arr);
    } else {
      // Orphan: referenced parent missing from the list → render at root.
      roots.push(t);
    }
  }
  return { roots, children };
}

export function BuddyList({
  threads,
  openThreadIds,
  visible,
  position,
  bounds,
  onDismiss,
  onMove,
  onBuddyClick,
}: BuddyListProps) {
  const drag = useAimDrag(bounds, onMove);

  // Hooks MUST run unconditionally (before the `!visible` early return) so
  // React sees a stable number of hooks on every render. Calling them only
  // when `visible` was a Rules-of-Hooks violation — dismissing the list
  // dropped the hook count and crashed the app.
  const { roots, children } = useMemo(() => buildTree(threads), [threads]);
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!visible) {
    // Hidden: the buddy list is dismissed (its thread keeps running). It is
    // relaunched from the Start menu — Applications → AIM — so there is no
    // longer a desktop icon for it.
    return null;
  }

  const count = threads.length;

  // Render a single thread row, recursing into an expanded parent's children.
  // Leaf rows are visually & behaviorally unchanged; parent rows open the
  // thread popup AND toggle their nested children.
  const renderThread = (thread: PluginSidebarThread) => {
    const name = thread.title ?? thread.titleFallback ?? "Untitled";
    const presence = threadPresence(thread);
    const isOpen = openThreadIds.has(thread.id);
    const label = `${name}, ${presenceLabel(thread)}`;
    const childThreads = children.get(thread.id) ?? [];
    const isParent = childThreads.length > 0;
    const isExpanded = expanded.has(thread.id);
    const childrenId = `aim-buddy-children-${thread.id}`;

    const rowContent = (
      <>
        {isParent ? (
          <span className="aim-buddy-caret" aria-hidden="true" />
        ) : null}
        <span className={`aim-pp aim-pp-${presence}`} aria-hidden="true" />
        <span className="aim-buddy-name">{name}</span>
      </>
    );

    if (!isParent) {
      // Leaf row — opens its own popup, visually unchanged.
      return (
        <li key={thread.id}>
          <button
            type="button"
            className={`aim-buddy-row${isOpen ? " aim-select" : ""}`}
            onClick={() => onBuddyClick(thread.id)}
            aria-label={label}
            aria-pressed={isOpen}
            title={`${label} (opens IM window)`}
          >
            {rowContent}
          </button>
        </li>
      );
    }

    // Parent row — opens the popup AND toggles its children.
    return (
      <li key={thread.id}>
        <button
          type="button"
          className={`aim-buddy-row aim-buddy-parent${isOpen ? " aim-select" : ""}`}
          onClick={() => {
            onBuddyClick(thread.id);
            toggleExpanded(thread.id);
          }}
          aria-label={label}
          aria-pressed={isOpen}
          aria-expanded={isExpanded}
          aria-controls={childrenId}
          title={`${label} (opens IM window; toggles children)`}
        >
          {rowContent}
        </button>
        {isExpanded ? (
          <ul
            id={childrenId}
            className="aim-buddy-children"
            role="group"
            aria-label={`${name} children`}
          >
            {childThreads.map((child) => renderThread(child))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <section
      className="aim-buddy aim-interactive window aim-buddy-window"
      style={{ left: position.x, top: position.y }}
      aria-label="AIM buddy list: your bb-app threads"
      onContextMenu={(event) => event.stopPropagation()}
    >
      <header className="title-bar" {...drag}>
        <div className="title-bar-text">Buddy List</div>
        <div className="title-bar-controls">
          <button
            type="button"
            aria-label="Close"
            title="Hide buddy list"
            onClick={onDismiss}
          />
        </div>
      </header>

      <div className="window-body aim-buddy-body">
        <div className="aim-buddy-toolbar">
          <span>Threads</span>
          <span className="aim-buddy-count">{count}</span>
        </div>

        <ul className="tree-view aim-buddy-list" role="listbox" aria-label="AIM buddy list threads">
          {count === 0 ? (
            <li className="aim-buddy-empty" role="status">
              No threads yet.
              <br />
              Open a thread in the app and it appears here as a buddy.
            </li>
          ) : (
            roots.map((thread) => renderThread(thread))
          )}
        </ul>
      </div>

      <div className="status-bar">
        <div className="status-bar-field">
          {count === 0 ? "No buddies" : `${count} online`}
        </div>
        <div className="status-bar-field status-bar-spacer" aria-hidden="true" />
      </div>
    </section>
  );
}
