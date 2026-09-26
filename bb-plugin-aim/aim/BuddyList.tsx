// The AIM buddy list: every bb thread as a buddy, in bb's own tree shape.
//
// This is a PARALLEL view, not a sidebar replacement. bb's default sidebar
// list is intentionally left registered and untouched; this window has to
// reach information parity with it on its own. Rows therefore surface the
// fields bb's own rows use — branch, host, project, provider, unread/pinned
// state, running activity, fork origin, PR state, split placement — from the
// same host hooks bb reads, so the two views cannot drift apart in meaning.
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
  workspaceBadge,
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

/** Human label for a PR's rolled-up attention state. */
function prLabel(pr: {
  number: number;
  state: "closed" | "draft" | "merged" | "open";
  attention: string;
}): string {
  switch (pr.attention) {
    case "changes_requested":
      return `#${pr.number} changes requested`;
    case "checks_failed":
      return `#${pr.number} checks failed`;
    case "checks_pending":
      return `#${pr.number} checks pending`;
    case "conflicts":
      return `#${pr.number} conflicts`;
    case "ready_to_merge":
      return `#${pr.number} ready to merge`;
    case "review_requested":
      return `#${pr.number} review requested`;
    case "blocked":
      return `#${pr.number} blocked`;
    case "merged":
      return `#${pr.number} merged`;
    case "closed":
      return `#${pr.number} closed`;
    case "draft":
      return `#${pr.number} draft`;
    default:
      return `#${pr.number} open`;
  }
}

/** A PR is worth flagging in gold only when it wants the user's attention. */
function prNeedsAttention(attention: string): boolean {
  return (
    attention === "changes_requested" ||
    attention === "checks_failed" ||
    attention === "conflicts" ||
    attention === "blocked" ||
    attention === "review_requested"
  );
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
  const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
  const split = experimental_useSidebarThreadSplit(thread.id);

  const name = thread.title ?? thread.titleFallback ?? "Untitled";
  const presence = threadPresence(thread);
  const waiting = isWaitingForInput(thread);
  const activity = activitySummary(thread);
  const branch = thread.environment?.branchName ?? null;
  const workspace = workspaceBadge(thread.environment?.workspaceDisplayKind);
  const host = thread.host?.name ?? null;
  const lastActivity = relativeTime(thread.updatedAt);
  const attention =
    pullRequest !== null && prNeedsAttention(pullRequest.attention);

  // The accessible name carries every detail the visual row encodes, so a
  // screen reader gets the same picture rather than just the title.
  const labelParts = [name, thread.indicatorLabel ?? presenceLabel(thread)];
  if (thread.isUnread) labelParts.push("unread");
  if (thread.isPinned) labelParts.push("pinned");
  if (activity) labelParts.push(activity);
  if (branch) labelParts.push(`branch ${branch}`);
  if (host) labelParts.push(`on ${host}`);
  if (projectName) labelParts.push(`project ${projectName}`);
  if (pullRequest) labelParts.push(prLabel(pullRequest));
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
        {/* Detail line: the same facts bb's sidebar row encodes. */}
        <span className="aim-buddy-detail">
          {thread.isPinned ? (
            <span className="aim-buddy-flag" title="Pinned" aria-hidden="true">
              ★
            </span>
          ) : null}
          {branch ? (
            <span className="aim-buddy-branch" title={`Branch: ${branch}`}>
              {branch}
            </span>
          ) : null}
          {workspace ? (
            <span className="aim-buddy-tag" title={`Workspace: ${workspace}`}>
              {workspace}
            </span>
          ) : null}
          {thread.originKind === "fork" ? (
            <span className="aim-buddy-tag" title="Forked thread">
              fork
            </span>
          ) : null}
          {activity ? (
            <span className="aim-buddy-tag aim-buddy-busy" title={activity}>
              {activity}
            </span>
          ) : null}
        </span>
        <span className="aim-buddy-sub">
          {providerName ? <span>{providerName}</span> : null}
          {projectName ? <span className="aim-buddy-project">{projectName}</span> : null}
          {host ? <span className="aim-buddy-host">{host}</span> : null}
          {lastActivity ? <span className="aim-buddy-time">{lastActivity}</span> : null}
        </span>
        {pullRequest ? (
          <span
            className={`aim-buddy-pr${attention ? " aim-buddy-pr-attention" : ""}`}
            title={`${pullRequest.title} — ${prLabel(pullRequest)}`}
          >
            {prLabel(pullRequest)}
          </span>
        ) : null}
      </span>
      {waiting ? (
        <span className="aim-buddy-needs" title="Needs your input">
          !
        </span>
      ) : null}
      {split.layout?.panes.some((pane) => pane.isMe) ? (
        <span className="aim-buddy-split" title="Open in a split pane">
          ⬒
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
        {/* Row actions, mirroring the sidebar's own verbs. Kept as real
            buttons (not a hover menu) so they stay keyboard reachable. */}
        <span className="aim-buddy-actions">
          <button
            type="button"
            className="aim-buddy-act"
            aria-label={thread.isPinned ? `Unpin ${name}` : `Pin ${name}`}
            title={thread.isPinned ? "Unpin" : "Pin"}
            onClick={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "★" : "☆"}
          </button>
          <button
            type="button"
            className="aim-buddy-act"
            aria-label={thread.isUnread ? `Mark ${name} read` : `Mark ${name} unread`}
            title={thread.isUnread ? "Mark read" : "Mark unread"}
            onClick={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "◉" : "○"}
          </button>
          <button
            type="button"
            className="aim-buddy-act"
            aria-label={`Archive ${name}`}
            title="Archive"
            onClick={() => actions.archive(thread.id)}
          >
            ▤
          </button>
        </span>
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
