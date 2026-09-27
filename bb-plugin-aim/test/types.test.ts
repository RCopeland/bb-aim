// Unit tests for the pure logic in `aim/types.ts` — the presence/attention
// mapping and the row-format helpers. These run with no plugin host at all:
// every function here is a pure transform of a `PluginSidebarThread`.
import { describe, expect, it } from "vitest";
import {
  activitySummary,
  isWaitingForInput,
  needsAttention,
  presenceLabel,
  presenceText,
  relativeTime,
  threadPresence,
  workingCount,
} from "../aim/types.js";
import { makeThread, withActivity } from "./helpers/thread.js";

describe("isWaitingForInput", () => {
  it("is true for the resolved waiting-for-input indicator", () => {
    expect(isWaitingForInput(makeThread({ indicator: "waiting-for-input" }))).toBe(
      true,
    );
  });

  // The indicator and the pending-interaction flag are independent signals:
  // a plugin interaction (approval/question) can be pending while bb's
  // indicator still reads "none".
  it("is true when a pending interaction exists even with a 'none' indicator", () => {
    expect(
      isWaitingForInput(makeThread({ indicator: "none", hasPendingInteraction: true })),
    ).toBe(true);
  });

  it("is false for an idle thread", () => {
    expect(isWaitingForInput(makeThread())).toBe(false);
  });

  // Only the blocked-on-user states count; a running agent is not waiting.
  it.each([
    "background-agent",
    "background-command",
    "goal",
    "plan-mode",
    "runtime",
    "workflow",
    "draft",
    "working-draft",
    "unread-error",
    "unread-success",
  ] as const)("is false for indicator %s", (indicator) => {
    expect(isWaitingForInput(makeThread({ indicator }))).toBe(false);
  });
});

describe("needsAttention", () => {
  // needsAttention is deliberately broader than isWaitingForInput: it is the
  // single signal shared by the buddy-list marker, the taskbar flag, and the
  // auto-reopen edge, so a failed or finished-but-unseen thread surfaces too.
  it.each(["waiting-for-input", "unread-error", "unread-success"] as const)(
    "is true for %s",
    (indicator) => {
      expect(needsAttention(makeThread({ indicator }))).toBe(true);
    },
  );

  it("is true for a pending interaction", () => {
    expect(needsAttention(makeThread({ hasPendingInteraction: true }))).toBe(true);
  });

  it.each(["none", "draft", "working-draft", "runtime", "workflow"] as const)(
    "is false for %s",
    (indicator) => {
      expect(needsAttention(makeThread({ indicator }))).toBe(false);
    },
  );

  // Regression: needsAttention must stay a superset of isWaitingForInput, or
  // the three surfaces that read it would disagree about the same thread.
  it("never contradicts isWaitingForInput", () => {
    const indicators = [
      "none",
      "waiting-for-input",
      "unread-error",
      "unread-success",
      "runtime",
      "draft",
    ] as const;
    for (const indicator of indicators) {
      for (const hasPendingInteraction of [true, false]) {
        const thread = makeThread({ indicator, hasPendingInteraction });
        if (isWaitingForInput(thread)) {
          expect(needsAttention(thread)).toBe(true);
        }
      }
    }
  });
});

describe("threadPresence", () => {
  it("maps a blocked thread to attention, taking priority over its indicator", () => {
    expect(threadPresence(makeThread({ indicator: "waiting-for-input" }))).toBe(
      "attention",
    );
    // Even an otherwise-"online" indicator loses to a pending interaction.
    expect(
      threadPresence(
        makeThread({ indicator: "background-agent", hasPendingInteraction: true }),
      ),
    ).toBe("attention");
  });

  it.each([
    "background-agent",
    "background-command",
    "goal",
    "plan-mode",
    "runtime",
    "workflow",
  ] as const)("maps running indicator %s to online", (indicator) => {
    expect(threadPresence(makeThread({ indicator }))).toBe("online");
  });

  it("maps unread-error to idle", () => {
    expect(threadPresence(makeThread({ indicator: "unread-error" }))).toBe("idle");
  });

  it.each(["draft", "working-draft"] as const)("maps %s to away", (indicator) => {
    expect(threadPresence(makeThread({ indicator }))).toBe("away");
  });

  it.each(["none", "unread-success"] as const)(
    "falls back to offline for %s",
    (indicator) => {
      expect(threadPresence(makeThread({ indicator }))).toBe("offline");
    },
  );
});

describe("presenceLabel", () => {
  it("prefers the host's own indicator label", () => {
    expect(
      presenceLabel(
        makeThread({ indicator: "waiting-for-input", indicatorLabel: "Needs you" }),
      ),
    ).toBe("Needs you");
  });

  it.each([
    ["waiting-for-input", "Waiting for input"],
    ["background-agent", "Online"],
    ["draft", "Away"],
    ["unread-error", "Idle"],
    ["none", "Offline"],
  ] as const)("falls back to a label for %s", (indicator, expected) => {
    expect(presenceLabel(makeThread({ indicator }))).toBe(expected);
  });
});

describe("presenceText", () => {
  it("capitalizes the presence name", () => {
    expect(presenceText("attention")).toBe("Attention");
    expect(presenceText("offline")).toBe("Offline");
  });
});

describe("workingCount", () => {
  it("is zero when nothing is running", () => {
    expect(workingCount(makeThread())).toBe(0);
  });

  it("sums every work counter", () => {
    expect(
      workingCount(
        withActivity({
          workflows: 1,
          backgroundAgents: 2,
          backgroundCommands: 3,
          planMode: 1,
          goals: 4,
        }),
      ),
    ).toBe(11);
  });
});

describe("activitySummary", () => {
  it("is null when nothing is running", () => {
    expect(activitySummary(makeThread())).toBeNull();
  });

  it("singularizes a single counter", () => {
    expect(activitySummary(withActivity({ backgroundAgents: 1 }))).toBe("1 agent");
    expect(activitySummary(withActivity({ workflows: 1 }))).toBe("1 workflow");
    expect(activitySummary(withActivity({ backgroundCommands: 1 }))).toBe("1 cmd");
    expect(activitySummary(withActivity({ goals: 1 }))).toBe("1 goal");
  });

  it("pluralizes multiple counters", () => {
    expect(activitySummary(withActivity({ backgroundAgents: 2 }))).toBe("2 agents");
    expect(activitySummary(withActivity({ workflows: 3 }))).toBe("3 workflows");
    expect(activitySummary(withActivity({ backgroundCommands: 4 }))).toBe("4 cmds");
    expect(activitySummary(withActivity({ goals: 2 }))).toBe("2 goals");
  });

  // planMode is a flag, not a count: it reads "planning" at any value.
  it("labels plan mode as 'planning' regardless of count", () => {
    expect(activitySummary(withActivity({ planMode: 1 }))).toBe("planning");
    expect(activitySummary(withActivity({ planMode: 3 }))).toBe("planning");
  });

  it("joins multiple counters in a stable order", () => {
    expect(
      activitySummary(
        withActivity({
          backgroundAgents: 2,
          workflows: 1,
          backgroundCommands: 1,
          planMode: 1,
          goals: 3,
        }),
      ),
    ).toBe("2 agents · 1 workflow · 1 cmd · planning · 3 goals");
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it.each([
    [0, ""],
    [-1, ""],
    [Number.NaN, ""],
    [Number.POSITIVE_INFINITY, ""],
  ])("returns an empty string for a bad timestamp (%s)", (timestamp, expected) => {
    expect(relativeTime(timestamp, now)).toBe(expected);
  });

  it("reads 'just now' under 45 seconds", () => {
    expect(relativeTime(now - 1_000, now)).toBe("just now");
    expect(relativeTime(now - 44_000, now)).toBe("just now");
  });

  it("rounds to minutes past 45 seconds", () => {
    expect(relativeTime(now - 45_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
  });

  it("rounds to hours past 60 minutes", () => {
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
  });

  it("rounds to days past 24 hours", () => {
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe("1d ago");
    expect(relativeTime(now - 29 * 86_400_000, now)).toBe("29d ago");
  });

  it("rounds to months past 30 days", () => {
    expect(relativeTime(now - 30 * 86_400_000, now)).toBe("1mo ago");
    expect(relativeTime(now - 11 * 30 * 86_400_000, now)).toBe("11mo ago");
  });

  it("rounds to years past 12 months", () => {
    expect(relativeTime(now - 12 * 30 * 86_400_000, now)).toBe("1y ago");
    expect(relativeTime(now - 24 * 30 * 86_400_000, now)).toBe("2y ago");
  });

  it("defaults `now` to the current clock", () => {
    // A timestamp an hour in the past is "1h ago" no matter when this runs.
    expect(relativeTime(Date.now() - 3_600_000)).toBe("1h ago");
  });
});
