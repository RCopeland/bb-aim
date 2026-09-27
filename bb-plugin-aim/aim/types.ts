import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/**
 * The presence bullet shown next to a buddy (thread) in the AIM list and
 * IM windows. Maps bb's resolved sidebar `indicator` (plus the pending
 * interaction flag) onto the classic AIM presence vocabulary.
 */
export type AimPresence =
  | "online"
  | "idle"
  | "away"
  | "offline"
  | "attention";

/** True when a thread is blocked waiting for the user to respond. */
export function isWaitingForInput(thread: PluginSidebarThread): boolean {
  // `waiting-for-input` is bb's resolved "the agent needs the user to
  // continue" status; `hasPendingInteraction` is the parallel flag for a
  // plugin interaction (approval / question) surfaced through the composer.
  return (
    thread.indicator === "waiting-for-input" || thread.hasPendingInteraction
  );
}

/** Sum of every live work counter; all zero means nothing is running. */
export function workingCount(thread: PluginSidebarThread): number {
  const a = thread.activity;
  return (
    a.workflows +
    a.backgroundAgents +
    a.backgroundCommands +
    a.planMode +
    a.goals
  );
}

export function threadPresence(thread: PluginSidebarThread): AimPresence {
  if (isWaitingForInput(thread)) return "attention";
  switch (thread.indicator) {
    // The agent is actively running.
    case "background-agent":
    case "background-command":
    case "goal":
    case "plan-mode":
    case "runtime":
    case "workflow":
      return "online";
    case "unread-error":
      return "idle";
    case "draft":
    case "working-draft":
      return "away";
    case "none":
    default:
      // Treat unknown indicators as offline/none (bb adds kinds over time).
      return "offline";
  }
}

/** A short human label for a thread's current status. */
export function presenceLabel(thread: PluginSidebarThread): string {
  if (thread.indicatorLabel) return thread.indicatorLabel;
  const presence = threadPresence(thread);
  switch (presence) {
    case "attention":
      return "Waiting for input";
    case "online":
      return "Online";
    case "away":
      return "Away";
    case "idle":
      return "Idle";
    case "offline":
    default:
      return "Offline";
  }
}

export function presenceText(presence: AimPresence): string {
  return presence.charAt(0).toUpperCase() + presence.slice(1);
}

/**
 * Does this thread need the user right now? Broader than
 * {@link isWaitingForInput}: a blocked agent is the primary case, but an
 * unread error, a finished-but-unseen success, and a pending interaction all
 * want the same "come look at me" treatment. Used for the attention dot, the
 * auto-reopen edge, and the taskbar flag so all three agree.
 */
export function needsAttention(thread: PluginSidebarThread): boolean {
  if (isWaitingForInput(thread)) return true;
  return thread.indicator === "unread-error" || thread.indicator === "unread-success";
}

/**
 * Relative "last activity" text for a buddy row, e.g. "3m ago". Kept terse
 * because rows are narrow; falls back to an empty string for bad timestamps.
 */
export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** A compact "what is running" summary, or null when nothing is running. */
export function activitySummary(thread: PluginSidebarThread): string | null {
  const a = thread.activity;
  const parts: string[] = [];
  if (a.backgroundAgents > 0) parts.push(`${a.backgroundAgents} agent${a.backgroundAgents === 1 ? "" : "s"}`);
  if (a.workflows > 0) parts.push(`${a.workflows} workflow${a.workflows === 1 ? "" : "s"}`);
  if (a.backgroundCommands > 0) parts.push(`${a.backgroundCommands} cmd${a.backgroundCommands === 1 ? "" : "s"}`);
  if (a.planMode > 0) parts.push("planning");
  if (a.goals > 0) parts.push(`${a.goals} goal${a.goals === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
