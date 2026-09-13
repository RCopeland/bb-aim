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