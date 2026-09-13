import { useCallback, useEffect, useRef, useState } from "react";
import {
  Markdown,
  experimental_useProviders,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  threadPresence,
  presenceLabel,
  isWaitingForInput,
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

export const DEFAULT_W = 312;
export const DEFAULT_H = 300;

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

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  id: string;
  /** The agent's thinking rows, in order, or null when there is none. */
  thinking: string[] | null;
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
  const rpc = useRpc<typeof rpcContract>();
  const drag = useAimDrag(bounds, onMove);
  const resizeSE = useAimResize(bounds, "se", onResize, onFocus);
  const resizeSW = useAimResize(bounds, "sw", onResize, onFocus);
  const presence = threadPresence(thread);
  const waiting = isWaitingForInput(thread);
  const running = workingCount(thread) > 0;
  const provider =
    providers.find((provider) => provider.id === thread.providerId)
      ?.displayName ?? thread.providerId;
  const name = thread.title ?? thread.titleFallback ?? "Untitled";
  const branch = thread.environment?.branchName;
  const host = thread.host?.name;
  const threadId = thread.id;

  // --- Transcript state. ---
  const [history, setHistory] = useState<TranscriptMessage[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Screen-reader announcement of only the newly-appended rows. */
  const [announcement, setAnnouncement] = useState("");

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastSeenUpdatedAtRef = useRef(thread.updatedAt ?? 0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Message ids already surfaced to this window; null = not seeded yet. */
  const knownIdsRef = useRef<Set<string> | null>(null);
  /** True once the on-open load has first resolved. */
  const historyLoadedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("thread_history", { threadId });
      const next = result.messages ?? [];
      setLoadError(null);
      setHistory(next);
      setTruncated(result.truncated ?? false);

      // Announce only genuinely-new rows (by id), never the whole transcript,
      // and never on the first load (which just seeds the baseline).
      const seen = knownIdsRef.current;
      if (seen) {
        const fresh = next.filter((message) => !seen.has(message.id));
        if (fresh.length > 0) {
          const held = fresh.slice(-3); // cap announcements to the newest few
          setAnnouncement(held.map((message) => announceText(message, name)).join(" "));
        }
      }
      knownIdsRef.current = new Set(next.map((message) => message.id));
      historyLoadedRef.current = true;
    } catch (err) {
      setHistory(null);
      setTruncated(false);
      setLoadError(
        err instanceof Error ? err.message : "Could not load the conversation.",
      );
    }
  }, [rpc, threadId, name]);

  // Initial load on open / when the thread changes; start pinned to the bottom.
  useEffect(() => {
    let active2 = true;
    stickToBottomRef.current = true;
    load().then(() => {
      if (!active2) return;
      // ensure we settle at the newest message once loaded
      const element = transcriptRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => {
      active2 = false;
    };
  }, [load]);

  // Live freshness: the sidebar thread record updates (updatedAt) when the
  // thread posts new activity. Debounce those bump into a transcript refetch so
  // streaming output arrives in the popup without hammering the server.
  useEffect(() => {
    const updatedAt = thread.updatedAt ?? 0;
    if (updatedAt !== lastSeenUpdatedAtRef.current) {
      lastSeenUpdatedAtRef.current = updatedAt;
      // If the on-open load is still in flight, skip scheduling: that load will
      // already fetch the current data, so we avoid a wasteful back-to-back fetch.
      if (!historyLoadedRef.current) return;
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(() => {
        void load();
      }, 450);
    }
  }, [thread.updatedAt, load]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await rpc.call("thread_send", { threadId, text });
      setDraft("");
      stickToBottomRef.current = true;
      await load();
    } catch (err) {
      setSendError(
        err instanceof Error
          ? err.message
          : "Could not send — open the thread in the app.",
      );
    } finally {
      setSending(false);
    }
  }, [rpc, threadId, draft, sending, load]);

  // Auto-scroll to the newest message unless the user has scrolled up.
  const transcriptKey =
    history
      ?.slice(-80)
      .map((message) => `${message.id}:${message.createdAt}:${message.text.length}`)
      .join("|") ?? "";
  useEffect(() => {
    const element = transcriptRef.current;
    if (element && stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [transcriptKey]);

  const handleScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    stickToBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  const visibleMessages = history ?? [];

  return (
    <section
      className={`aim-win aim-interactive window${window.flash ? " aim-flash" : ""}`}
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
      {/* Off-screen polite live region announcing only newly-appended rows. */}
      <div className="aim-announcer" aria-live="polite" aria-atomic="false">
        {announcement}
      </div>
      <header className="title-bar" {...drag}>
        <div className="title-bar-text">{name}</div>
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
        <div className="aim-win-meta">
          <span className={`aim-pp aim-pp-${presence}`} aria-hidden="true" />
          <span>
            <b>{presenceText(presence)}</b> {presenceLabel(thread)}
          </span>
          <span className="aim-status-chip">{provider}</span>
        </div>

        <div className="aim-win-transcript" ref={transcriptRef} onScroll={handleScroll}>
          {history === null && loadError === null ? (
            <div className="aim-msg-loading" role="status">
              Loading conversation…
            </div>
          ) : loadError !== null ? (
            <div className="aim-msg-error" role="alert">
              <b>Couldn't reach this thread.</b> {loadError}
            </div>
          ) : visibleMessages.length === 0 ? (
            <div className="aim-msg-empty" role="status">
              No messages yet in this thread. Type below to start.
            </div>
          ) : (
            visibleMessages.map((message) => (
              <div
                key={message.id}
                className={`aim-tx aim-${message.role}`}
                aria-label={`${message.role === "user" ? "You" : "Agent"}: ${message.text}`}
              >
                <span
                  className={`aim-tx-name ${
                    message.role === "user" ? "aim-tx-name-user" : "aim-tx-name-agent"
                  }`}
                >
                  {message.role === "user" ? "You" : name}
                </span>
                {message.role === "assistant" &&
                message.thinking != null &&
                message.thinking.length > 0 ? (
                  <details className="aim-tx-thinking">
                    <summary className="aim-tx-thinking-label">
                      Thinking
                    </summary>
                    {message.thinking.map((block, index) => (
                      <div
                        key={`${message.id}-think-${index}`}
                        className="aim-tx-thinking-block"
                      >
                        <Markdown content={block} className="aim-tx-thinking-text" />
                      </div>
                    ))}
                  </details>
                ) : null}
                <Markdown content={message.text} className="aim-tx-text" />
              </div>
            ))
          )}
          {truncated && (
            <div className="aim-tx-truncated" role="status">
              Showing the most recent messages.
            </div>
          )}
        </div>

        <div className="aim-win-composer">
          <textarea
            id={`aim-input-${threadId}`}
            className="aim-composer-input"
            aria-label={`Reply to ${name}`}
            value={draft}
            placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={sending}
          />
          {sendError ? (
            <div className="aim-composer-error" role="alert">
              {sendError}
            </div>
          ) : null}
          <div className="aim-composer-row">
            <button
              type="button"
              className="aim-btn aim-btn-primary"
              onClick={() => void send()}
              disabled={sending || !draft.trim()}
            >
              {sending ? "Sending…" : "Send"}
            </button>
            <button type="button" className="aim-btn" onClick={onOpenThread}>
              Open thread
            </button>
          </div>
        </div>
      </div>

      {/* Corner resize handles. Draggable, clamped to the desktop. Top corners
         stay free for the ✕/minimize controls. */}
      <span className="aim-win-resize aim-se" {...resizeSE} aria-hidden="true" />
      <span className="aim-win-resize aim-sw" {...resizeSW} aria-hidden="true" />
    </section>
  );
}

/** Build a short, spoken-style announcement for one transcript row. */
function announceText(message: TranscriptMessage, threadName: string): string {
  const who = message.role === "user" ? "You" : threadName || "Agent";
  const body = message.text.length > 240 ? `${message.text.slice(0, 240)}…` : message.text;
  return `${who} said: ${body}`;
}
