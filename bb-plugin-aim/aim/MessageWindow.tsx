// AIM instant-message window.
//
// The window is AIM chrome (title bar, presence header, drag/resize) wrapped
// around the host's OWN chat component, `ThreadChat`. That is deliberate: an
// earlier version hand-rolled a transcript from the timeline RPC, which
// flattened every non-`kind: "conversation"` row away — tool calls, diffs,
// file rows, queued messages, drafts, attachments, @-mentions and the
// permission control all silently disappeared, and sends bypassed the host's
// submit pipeline. `ThreadChat` is bb's real chat, so the IM window now has
// full thread functionality and keeps working as bb evolves.
import {
  ThreadChat,
  experimental_useProviders,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  threadPresence,
  presenceLabel,
  workingCount,
  presenceText,
} from "./types";
import { useAimDrag, type DragBoundsRef } from "./useAimDrag";
import { useAimResize, type ResizeTarget } from "./useAimResize";

export interface ImWindowState {
  threadId: string;
  visible: boolean;
  x: number;
  y: number;
  z: number;
  flash: boolean;
  width: number;
  height: number;
}

/**
 * Default IM window size.
 *
 * These were 312x300 when the popup only drew plain message bubbles. It now
 * hosts bb's real `ThreadChat` (timeline with tool calls and diffs, plus the
 * full composer with attach / mention / permission controls), so the old size
 * was too cramped to read or type in. Sized for the chat surface, not the old
 * bubble list.
 */
export const DEFAULT_W = 440;
export const DEFAULT_H = 540;

export interface MessageWindowProps {
  window: ImWindowState;
  thread: PluginSidebarThread;
  active: boolean;
  bounds: DragBoundsRef;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (resize: ResizeTarget) => void;
  onClose: () => void; // hides only — thread keeps running in the app
  onOpenThread: () => void; // actions.open(threadId) — jump to it in the app
}

export function MessageWindow({
  window,
  thread,
  active,
  bounds,
  onFocus,
  onMove,
  onResize,
  onClose,
  onOpenThread,
}: MessageWindowProps) {
  const { providers } = experimental_useProviders();
  const drag = useAimDrag(bounds, onMove);
  const resizeSE = useAimResize(bounds, "se", onResize, onFocus);
  const resizeSW = useAimResize(bounds, "sw", onResize, onFocus);
  const presence = threadPresence(thread);
  const running = workingCount(thread) > 0;
  const provider =
    providers.find((entry) => entry.id === thread.providerId)?.displayName ??
    thread.providerId;
  const name = thread.title ?? thread.titleFallback ?? "Untitled";
  const branch = thread.environment?.branchName;
  const host = thread.host?.name;

  return (
    <section
      className={`aim-win aim-interactive window${window.flash ? " aim-flash" : ""}${
        active ? " aim-win-active" : ""
      }`}
      style={{
        left: window.x,
        top: window.y,
        width: window.width,
        height: window.height,
        zIndex: window.z,
      }}
      onClick={onFocus}
      onContextMenu={(event) => event.stopPropagation()}
      role="dialog"
      aria-label={`Instant message — ${name}`}
    >
      <header className="title-bar" {...drag}>
        <div className="title-bar-text" title={name}>
          {name}
        </div>
        <div className="title-bar-controls">
          <button
            type="button"
            aria-label="Minimize"
            title="Hide (thread keeps running)"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          />
          <button
            type="button"
            aria-label="Close"
            title="Hide window"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          />
        </div>
      </header>

      <div className="window-body aim-win-body">
        {/* Presence strip. Announces the same "needs you" signal the buddy
            list and taskbar use, so the window states why it reappeared. */}
        <div className="aim-win-meta">
          <span className={`aim-pp aim-pp-${presence}`} aria-hidden="true" />
          <span className="aim-win-meta-status">
            <b>{presenceText(presence)}</b> {presenceLabel(thread)}
          </span>
          <span className="aim-status-chip" title="Provider">
            {provider}
          </span>
          {branch ? (
            <span className="aim-status-chip aim-status-chip-branch" title={`Branch: ${branch}`}>
              {branch}
            </span>
          ) : null}
          {running ? (
            <span className="aim-status-chip" title="Running work">
              busy
            </span>
          ) : null}
        </div>

        {/* The window's real content: bb's own chat. `contained` makes it fill
            and scroll inside this bounded, resizable parent; `inherit` keeps
            sends pinned to the thread's own resolved permission mode — a
            plugin surface must never widen it. */}
        <div className="aim-win-chat">
          <ThreadChat
            threadId={thread.id}
            variant="compact"
            layout="contained"
            permissionPolicy="inherit"
            className="aim-thread-chat"
          />
        </div>

        <div className="aim-win-actions">
          <button type="button" className="aim-btn" onClick={onOpenThread}>
            Open thread
          </button>
          {host ? (
            <span className="aim-win-host" title={`Machine: ${host}`}>
              {host}
            </span>
          ) : null}
        </div>
      </div>

      {/* Corner resize handles. Draggable, clamped to the desktop. Top corners
         stay free for the ✕/minimize controls. */}
      <span className="aim-win-resize aim-se" {...resizeSE} aria-hidden="true" />
      <span className="aim-win-resize aim-sw" {...resizeSW} aria-hidden="true" />
    </section>
  );
}
