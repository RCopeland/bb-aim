// Test fixture for `PluginSidebarThread`.
//
// The AIM helper functions in `aim/types.ts` are pure: they read a handful of
// fields and return a presence, a label, or a count. Building a full thread
// object for every case would bury the one field under test in noise, so this
// factory supplies a realistic "idle, nothing happening" baseline and lets each
// test override only what it cares about.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/** Nothing running, no unread state, no pending interaction. */
export const IDLE_ACTIVITY = {
  workflows: 0,
  backgroundAgents: 0,
  backgroundCommands: 0,
  planMode: 0,
  goals: 0,
} as const;

export function makeThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_test",
    projectId: "proj_test",
    title: "Test thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    hasPendingInteraction: false,
    activity: { ...IDLE_ACTIVITY },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

/** A thread with one or more live work counters set. */
export function withActivity(
  activity: Partial<PluginSidebarThread["activity"]>,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return makeThread({ activity: { ...IDLE_ACTIVITY, ...activity }, ...overrides });
}
