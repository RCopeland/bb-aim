// The AIM buddy list: every bb thread as a buddy, in bb's own tree shape.
//
// This is a PARALLEL view, not a sidebar replacement. bb's default sidebar
// list is intentionally left registered and untouched.
//
// Rows are deliberately MINIMAL: a presence dot and the thread title. An
// earlier version crammed the default sidebar's whole detail vocabulary
// (branch, host, project, provider, workspace, fork origin, PR state, last
// activity) into each row, which made the list unreadable — the AIM look
// wants a buddy's name and nothing else. The full detail is still reachable:
// the row's `aria-label`/`title` carries every field as text, and opening the
// thread shows the real thing.
//
// Hooks discipline (two hard rules, both previously violated here):
//  1. Every hook runs unconditionally, BEFORE any early return. Dismissing
//     the list used to drop the hook count and crash the app.
//  2. The per-row hooks (`experimental_useSidebarThreadPullRequest`,
//     `experimental_useSidebarThreadSplit`) are called inside `BuddyRow` —
//     one component instance per row — never in a loop in this component.
import { Fragment, useCallback, useMemo, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  type PluginSidebarThreadActions,
  type PluginSidebarProject,
} from "@get-bb/plugin-sdk/app";
import {
  activitySummary,
  isWaitingForInput,
  presenceLabel,
  relativeTime,
  threadPresence,
} from "./types";
import { useAimDrag, type DragBoundsRef } from "./useAimDrag";

export interface BuddyListProps {
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  openThreadIds: ReadonlySet<string>;
  visible: boolean;
  position: { x: number; y: number };
  bounds: DragBoundsRef;
  onDismiss: () => void;
  onMove: (x: number, y: number) => void;
  onBuddyClick: (threadId: string) => void;
  /** Opens bb's new-thread screen (host flow), not a bespoke compose form. */
  onNewThread: () => void;
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

interface BuddyRowProps {
  thread: PluginSidebarThread;
  projectName: string | null;
  providerName: string | null;
  isParent: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  depth: number;
  actions: PluginSidebarThreadActions;
  onBuddyClick: (threadId: string) => void;
  onToggleExpanded: (threadId: string) => void;
}

/**
 * One buddy row. Owns the per-row host hooks (PR + split) that bb's own rows
 * call, and renders the same detail vocabulary the default sidebar uses.
 */
function BuddyRow({
  thread,
  projectName,
  providerName,
  isParent,
  isExpanded,
  isSelected,
  depth,
  actions,
  onBuddyClick,
  onToggleExpanded,
}: BuddyRowProps) {
  // Per-row hooks — one instance of this component per row, so calling them
  // here is legal and matches how bb's own list rows are built.
  //
  // Both remain even though the row no longer paints their state: `splitProps`
  // still carries the host's drag-to-split gesture onto the row button, and
  // dropping a hook would change this component's hook count.
  const split = experimental_useSidebarThreadSplit(thread.id);
  // `pullRequest` is intentionally unread: the row shows only a title now, so
  // the per-row PR lookup's value is not rendered anywhere. The hook is still
  // called to keep this component's hook count stable.
  experimental_useSidebarThreadPullRequest(thread.id);

  const name = thread.title ?? thread.titleFallback ?? "Untitled";
  const presence = threadPresence(thread);
  const waiting = isWaitingForInput(thread);
  // These are no longer painted in the row, but they still feed the accessible
  // label below, so a screen reader keeps the detail the visual row dropped.
  const activity = activitySummary(thread);
  const branch = thread.environment?.branchName ?? null;
  const host = thread.host?.name ?? null;
  const lastActivity = relativeTime(thread.updatedAt);

  // The row shows only a dot and the title, so the accessible name is where
  // the dropped detail lives. It stays a faithful, if terse, description.
  const labelParts = [name, thread.indicatorLabel ?? presenceLabel(thread)];
  if (thread.isUnread) labelParts.push("unread");
  if (thread.isPinned) labelParts.push("pinned");
  if (split.layout?.panes.some((pane) => pane.isMe)) {
    labelParts.push("in a split pane");
  }
  if (activity) labelParts.push(activity);
  if (branch) labelParts.push(`branch ${branch}`);
  if (host) labelParts.push(`on ${host}`);
  if (projectName) labelParts.push(`project ${projectName}`);
  if (providerName) labelParts.push(`provider ${providerName}`);
  if (lastActivity) labelParts.push(`last activity ${lastActivity}`);
  const label = labelParts.join(", ");

  const rowContent = (
    <>
      <span className={`aim-pp aim-pp-${presence}`} aria-hidden="true" />
      <span className="aim-buddy-main">
        <span
          className={`aim-buddy-name${thread.isUnread ? " aim-buddy-unread" : ""}`}
        >
          {name}
        </span>
      </span>
      {thread.isPinned ? (
        <span className="aim-buddy-pin" title="Pinned" aria-hidden="true" />
      ) : null}
      {waiting ? (
        <span className="aim-buddy-needs" title="Needs your input">
          !
        </span>
      ) : null}
    </>
  );

  return (
    <li className="aim-buddy-li" style={{ paddingLeft: depth * 12 }}>
      <div className="aim-buddy-rowwrap">
        {/* The disclosure caret is its own control. Clicking the row body opens
            the IM window; clicking the caret only expands/collapses children.
            Separating them keeps a single click meaning one thing, and keeps
            both actions keyboard reachable without a double-click. */}
        {isParent ? (
          <button
            type="button"
            className="aim-buddy-caret-btn"
            aria-label={
              isExpanded ? `Collapse ${name} children` : `Expand ${name} children`
            }
            aria-expanded={isExpanded}
            onClick={() => onToggleExpanded(thread.id)}
          >
            <span
              className={`aim-buddy-caret${isExpanded ? " aim-buddy-caret-open" : ""}`}
              aria-hidden="true"
            />
          </button>
        ) : null}
        <button
          type="button"
          // `splitProps` carries the host's split-drag gesture; spreading it is
          // safe when splits are unavailable (it is then empty).
          {...split.splitProps}
          className={`aim-buddy-row${isSelected ? " aim-select" : ""}${
            isParent ? " aim-buddy-parent" : ""
          }${thread.isUnread ? " aim-buddy-row-unread" : ""}`}
          onClick={() => onBuddyClick(thread.id)}
          aria-label={label}
          aria-pressed={isSelected}
          title={`${label} (opens IM window)`}
        >
          {rowContent}
        </button>
        {/* The single row action: archive. Pin and mark-read were removed
            because their state is already visible (the dot and the pin mark)
            and three cryptic glyphs per row made the list noisy. Always
            rendered — a hover-only control is invisible until you happen to
            pass over it, which is what made these look broken. The glyph is a
            CSS-drawn box-in-slot icon, not a text character, so it renders
            identically in the pixel font. */}
        <button
          type="button"
          className="aim-buddy-act"
          aria-label={`Archive ${name}`}
          title={`Archive ${name}`}
          onClick={() => actions.archive(thread.id)}
        >
          <span className="aim-ico-archive" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

export function BuddyList({
  threads,
  projects,
  openThreadIds,
  visible,
  position,
  bounds,
  onDismiss,
  onMove,
  onBuddyClick,
  onNewThread,
}: BuddyListProps) {
  const drag = useAimDrag(bounds, onMove);
  const actions = experimental_useSidebarThreadActions();
  const { providers } = experimental_useProviders();

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

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  const providerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers) map.set(provider.id, provider.displayName);
    return map;
  }, [providers]);

  if (!visible) {
    // Hidden: the buddy list is dismissed (its thread keeps running). It is
    // relaunched from the Start menu — Applications → AIM — so there is no
    // longer a desktop icon for it.
    return null;
  }

  const count = threads.length;

  // Render a thread row, recursing into an expanded parent's descendants.
  // Depth drives the indent; rows stay flat siblings inside the listbox so the
  // accessible structure is a clean set of rows rather than nested lists.
  const renderThread = (
    thread: PluginSidebarThread,
    depth = 0,
  ): React.ReactNode => {
    const childThreads = children.get(thread.id) ?? [];
    const isParent = childThreads.length > 0;
    const isExpanded = expanded.has(thread.id);
    return (
      <Fragment key={thread.id}>
        <BuddyRow
          thread={thread}
          projectName={projectNames.get(thread.projectId) ?? null}
          providerName={providerNames.get(thread.providerId) ?? null}
          isParent={isParent}
          isExpanded={isExpanded}
          isSelected={openThreadIds.has(thread.id)}
          depth={depth}
          actions={actions}
          onBuddyClick={onBuddyClick}
          onToggleExpanded={toggleExpanded}
        />
        {isExpanded ? childThreads.map((child) => renderThread(child, depth + 1)) : null}
      </Fragment>
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
          <button
            type="button"
            className="aim-buddy-new"
            onClick={onNewThread}
            title="Open bb's new-thread screen"
          >
            New
          </button>
        </div>

        <ul
          className="tree-view aim-buddy-list"
          role="listbox"
          aria-label="AIM buddy list threads"
        >
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
