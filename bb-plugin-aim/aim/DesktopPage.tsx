import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent } from "react";
import {
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { needsAttention } from "./types";
import { BuddyList } from "./BuddyList";
import {
  DEFAULT_H,
  DEFAULT_W,
  MessageWindow,
  type ImWindowState,
} from "./MessageWindow";
import type { DragBoundsRef } from "./useAimDrag";
import { MIN_H, MIN_W, type ResizeTarget } from "./useAimResize";

/**
 * Z-ordering budget for the AIM page.
 *
 * CRITICAL: these values are deliberately SMALL. The AIM desktop renders inside
 * the bb app's own stacking context and is an ANCESTOR of the host's
 * `ThreadChat`, whose composer popovers (model / permission dropdowns) are the
 * thing this budget must not cover.
 *
 * The host's own popover layers are modest — its Tailwind scale tops out at
 * `z-100`, and the composer menus sit at `z-[45]` / `z-[70]`. An earlier
 * version used ~2.1 billion for windows and 1,000,100 after a first fix; both
 * were orders of magnitude above the host, so every host popover opened
 * UNDERNEATH our window. That was the "model menu appears behind the IM
 * window" bug — it was never a clipping or caching problem.
 *
 * Layout is layered inside the desktop root, so these only need to order our
 * own children. The band is chosen to sit ABOVE the host's page content
 * (`z-[1]`) but BELOW its popovers (`z-[45]` / `z-[70]` / `z-100`), so a
 * dropdown always paints over an IM window:
 *
 *     0..9    wallpaper
 *    11..29   IM windows  ← raise within this band only
 *    32       taskbar
 *    34       start menu + flyouts
 *    36       context menu / status toast
 *
 * Every value stays under 45 so no host popover can lose to our chrome.
 */
const OVERLAY_BASE_Z = 11;
/** Last usable window z. Raising past this wraps back to the band floor. */
const WINDOW_Z_MAX = 29;
const FLASH_MS = 1500;

/**
 * Layout tokens, in px. `.aim-root` in aim.css owns these as custom properties
 * (`--aim-buddy-w` / `--aim-buddy-h` / `--aim-buddy-margin` / `--aim-taskbar-h`)
 * so the CSS is the single source of truth and the numbers can never drift.
 *
 * The fallbacks are the values the CSS ships with, so behaviour is identical if
 * the variables are missing or we are not in a browser (SSR, tests, a build
 * that reads this module before mount).
 */
export type AimLayoutToken =
  | "--aim-buddy-w"
  | "--aim-buddy-h"
  | "--aim-buddy-margin"
  | "--aim-taskbar-h";

const LAYOUT_FALLBACK_PX: Record<AimLayoutToken, number> = {
  "--aim-buddy-w": 268,
  "--aim-buddy-h": 420,
  "--aim-buddy-margin": 14,
  "--aim-taskbar-h": 30,
};

/** Custom-property name -> resolved px, shared by every desktop instance. */
let layoutTokens: LayoutTokenRecord | null = null;

/**
 * Marker key on the resolved token record recording which element the values
 * were read from, so a remaining desktop instance re-reads after a root swap.
 * (A symbol, so it can never collide with a custom-property name.)
 */
const LAYOUT_RESOLVED_FOR: unique symbol = Symbol("aim-layout-resolved-for");
type LayoutTokenRecord = Record<AimLayoutToken, number> & {
  [LAYOUT_RESOLVED_FOR]?: HTMLElement | null;
};

/**
 * Resolve the layout tokens from the desktop root's computed style. Called
 * lazily, once per resolved root, never per render or per drag frame. An absent
 * DOM/`getComputedStyle`, or an empty/non-numeric value, keeps the ship literal.
 */
function readLayoutTokens(root: HTMLElement | null): LayoutTokenRecord {
  const resolved: LayoutTokenRecord = { ...LAYOUT_FALLBACK_PX };
  if (root === null || typeof getComputedStyle !== "function") return resolved;
  const style = getComputedStyle(root);
  for (const name of Object.keys(LAYOUT_FALLBACK_PX) as AimLayoutToken[]) {
    const parsed = parseFloat(style.getPropertyValue(name));
    if (Number.isFinite(parsed)) resolved[name] = parsed;
  }
  return resolved;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // match server cap

/** Build a fresh IM window entry for a thread. */
/**
 * Build a fresh IM window entry for a thread, sized to fit the current
 * desktop. The default chat size is the preferred size, but on a small
 * viewport a 440x540 window would hang off the edge (and the auto-reopen path
 * creates windows without a cascade position), so clamp down to the available
 * area, never below the resize minimums.
 */
function newWindow(
  threadId: string,
  x: number,
  y: number,
  z: number,
  desktop?: { width: number; height: number },
): ImWindowState {
  const fitW =
    desktop === undefined
      ? DEFAULT_W
      : Math.max(MIN_W, Math.min(DEFAULT_W, desktop.width - 32));
  const fitH =
    desktop === undefined
      ? DEFAULT_H
      : Math.max(MIN_H, Math.min(DEFAULT_H, desktop.height - y - 16));
  return {
    threadId,
    visible: true,
    x,
    y,
    z,
    flash: false,
    width: fitW,
    height: fitH,
  };
}

interface ContextMenuState {
  x: number;
  y: number;
}

/**
 * The AIM desktop page. Renders a classic-Windows wallpaper that hosts the
 * buddy list and floating IM windows (see the peer components). It also owns
 * the wallpaper feature: right-click (contextmenu) on the desktop — or the
 * "Wallpaper" desktop icon (top-left), which opens the keyboard-reachable
 * wallpaper-controls panel that is itself keyboard-reachable — to upload a
 * raster image that is persisted server-side and served back through a plugin
 * HTTP route.
 */
export function DesktopPage() {
  const { status, threads, projects } = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const rpc = useRpc<typeof rpcContract>();

  // --- Desktop container + its live size (drives window bounds). ---
  const desktopRef = useRef<HTMLDivElement | null>(null);
  // Layout tokens resolved from the desktop root's computed style, read once
  // after mount. Until then (and if the vars are unavailable) the module
  // fallbacks stand in, so the numbers are always usable.
  const [layout, setLayout] = useState<LayoutTokenRecord>(
    () => layoutTokens ?? readLayoutTokens(null),
  );
  const buddyWidth = layout["--aim-buddy-w"];
  const buddyHeight = layout["--aim-buddy-h"];
  const buddyMargin = layout["--aim-buddy-margin"];
  const taskbarH = layout["--aim-taskbar-h"];
  // `null` until the desktop has ACTUALLY been measured. Starting from a
  // hardcoded default made the buddy list place itself against a fake 1200px
  // desktop on first render and then never re-place, so it landed mid-screen.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const boundsRef: DragBoundsRef = useRef({ width: 1200, height: 720 });
  if (size !== null) boundsRef.current = size;
  useEffect(() => {
    const node = desktopRef.current;
    if (!node) return;
    // Read once per mounted root: reuse the module cache when it was already
    // resolved from this same element, otherwise re-read `getComputedStyle`.
    if (layoutTokens === null || layoutTokens[LAYOUT_RESOLVED_FOR] !== node) {
      layoutTokens = readLayoutTokens(node);
      layoutTokens[LAYOUT_RESOLVED_FOR] = node;
    }
    setLayout(layoutTokens);
  }, []);

  useEffect(() => {
    const node = desktopRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({
        width: Math.max(320, Math.round(rect.width)),
        // Reserve the taskbar strip at the bottom so dragged/resized IM
        // windows can never slip underneath it and become unreachable.
        height: Math.max(240, Math.round(rect.height) - taskbarH),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [taskbarH]);

  // --- Window + buddy state (unchanged behaviors). ---
  const [windows, setWindows] = useState<Record<string, ImWindowState>>({});
  const zCounter = useRef(OVERLAY_BASE_Z);
  const nextZ = useCallback(() => {
    // Stay inside the window band: wrapping (rather than growing) keeps raising
    // from ever climbing into the taskbar/menu layers, and the relative order
    // of the visible windows stays correct because every live window is
    // re-raised from the same counter.
    zCounter.current =
      zCounter.current >= WINDOW_Z_MAX ? OVERLAY_BASE_Z : zCounter.current + 1;
    return zCounter.current;
  }, []);

  const [buddyVisible, setBuddyVisible] = useState(true);
  const [buddyPos, setBuddyPos] = useState({ x: 0, y: 0 });
  const buddyPlaced = useRef(false);

  // Respect prefers-reduced-motion: we still auto-reopen attention windows,
  // but skip the emphasis flash animation for users who ask for less motion.
  const reducedMotion = useRef(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  ).current;

  // Place the buddy list top-right the FIRST time a real measurement exists;
  // afterward the user's drag position wins. The `size === null` guard is the
  // fix for "it starts in the middle": this used to run against the placeholder
  // desktop size and place itself at a bogus x, then latch via `buddyPlaced`.
  useEffect(() => {
    if (buddyPlaced.current || size === null || size.width <= 0) return;
    buddyPlaced.current = true;
    setBuddyPos({ x: Math.max(0, size.width - buddyWidth - buddyMargin), y: buddyMargin });
  }, [size, buddyWidth, buddyMargin]);

  // --- Wallpaper state ---
  const [wallpaperUrl, setWallpaperUrl] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const statusTimer = useRef<number | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  /** Which Start-menu folder is expanded: Settings or Applications. */
  const [startMenu, setStartMenu] = useState<"apps" | "settings" | null>(null);

  const notify = useCallback((message: string) => {
    setStatusMsg(message);
    if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatusMsg(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (statusTimer.current !== null) window.clearTimeout(statusTimer.current);
    },
    [],
  );

  const refreshWallpaper = useCallback(async () => {
    try {
      const result = await rpc.call("wallpaper_get");
      setWallpaperUrl(result.url);
    } catch (error) {
      // Non-fatal: fall back to the default wallpaper.
      setWallpaperUrl(null);
    }
  }, [rpc]);

  useEffect(() => {
    void refreshWallpaper();
  }, [refreshWallpaper]);
  // Stable handler: read the latest refresh through a ref so the subscription
  // is created once and cleaned up without churn on every render.
  const refreshRef = useRef(refreshWallpaper);
  refreshRef.current = refreshWallpaper;
  useRealtime(
    "aim-wallpaper-changed",
    useCallback(() => {
      void refreshRef.current();
    }, []),
  );

  // --- Image picking + upload ---
  const onFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Ensure the input can re-select the same file later.
      event.target.value = "";
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        notify("Please choose an image file (PNG, JPEG, GIF, or WebP).");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        notify("Image is too large (max 10 MB).");
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => notify("Could not read that file.");
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const comma = dataUrl.indexOf(",");
        const dataBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        try {
          const result = await rpc.call("wallpaper_set", {
            dataBase64,
            mimeType: file.type,
          });
          setWallpaperUrl(result.url);
          notify("Wallpaper updated.");
        } catch (error) {
          notify(
            error instanceof Error
              ? error.message
              : "Could not upload that image.",
          );
        }
      };
      reader.readAsDataURL(file);
    },
    [rpc, notify],
  );

  const restoreDefault = useCallback(async () => {
    try {
      await rpc.call("wallpaper_clear");
      setWallpaperUrl(null);
      notify("Back to the default wallpaper.");
    } catch {
      notify("Could not restore the default wallpaper.");
    }
  }, [rpc, notify]);

  // --- Context menu (right-click) state ---
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Clamped position so the menu never overflows the desktop's edges; its
  // real size is measured after mount, then the position is corrected.
  const [menuPos, setMenuPos] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setMenuPos(null);
  }, []);

  const onDesktopContextMenu = useCallback(
    (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault();
      const node = desktopRef.current;
      const left = node?.getBoundingClientRect().left ?? 0;
      const top = node?.getBoundingClientRect().top ?? 0;
      const raw = {
        x: Math.round(event.clientX - left),
        y: Math.round(event.clientY - top),
      };
      setMenu(raw);
      setMenuPos(raw);
    },
    [],
  );

  // Clamp after the menu has rendered so we know its real width/height.
  useLayoutEffect(() => {
    if (!menu) return;
    // No real desktop measurement yet: leave the menu where the click put it
    // rather than clamping it against a placeholder size.
    if (size === null) return;
    const node = menuRef.current;
    const width = node?.offsetWidth ?? 200;
    const height = node?.offsetHeight ?? 96;
    const maxX = Math.max(4, size.width - width - 4);
    const maxY = Math.max(4, size.height - height - 4);
    setMenuPos({
      x: Math.min(Math.max(4, menu.x), maxX),
      y: Math.min(Math.max(4, menu.y), maxY),
    });
  }, [menu, size]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  // Start menu: close on outside click + Escape (mirrors the context menu).
  const closeStart = useCallback(() => {
    setStartOpen(false);
    setStartMenu(null);
  }, []);
  useEffect(() => {
    if (!startOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeStart();
    };
    window.addEventListener("click", closeStart);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", closeStart);
      window.removeEventListener("keydown", onKey);
    };
  }, [startOpen, closeStart]);

  // --- Thread actions (unchanged: focus via bb's own flow). ---
  const openThreadInApp = useCallback(
    (threadId: string) => actions.open(threadId),
    [actions],
  );

  // New-thread creation always routes through bb's host composer
  // (actions.openNewThread) — there is no plugin-side silent create.
  // Scope the new thread to the project the AIM panel is showing: prefer the
  // projectId of the first thread (concrete, real), else bb's personal
  // project, else leave it unspecified so bb applies its own default.
  const newThreadProjectId = useMemo(
    () =>
      threads.length > 0 && threads[0].projectId
        ? threads[0].projectId
        : projects.find((p) => p.isPersonal)?.id,
    [threads, projects],
  );

  const onNewThread = useCallback(
    () => actions.openNewThread({ projectId: newThreadProjectId }),
    [actions, newThreadProjectId],
  );

  const onBuddyClick = useCallback(
    (threadId: string) => {
      setWindows((prev) => {
        const existing = prev[threadId];
        if (existing) {
          return {
            ...prev,
            [threadId]: {
              ...existing,
              visible: !existing.visible,
              z: existing.visible ? existing.z : nextZ(),
              flash: false,
            },
          };
        }
        const count = Object.keys(prev).length;
        return {
          ...prev,
          [threadId]: newWindow(
            threadId,
            24 + (count % 5) * 28,
            24 + (count % 5) * 28,
            nextZ(),
            size ?? undefined,
          ),
        };
      });
    },
    [nextZ, size],
  );

  const onFocusWindow = useCallback(
    (threadId: string) => {
      setWindows((prev) => {
        const existing = prev[threadId];
        if (!existing || existing.z === zCounter.current) return prev;
        return { ...prev, [threadId]: { ...existing, z: nextZ() } };
      });
    },
    [nextZ],
  );

  const onMoveWindow = useCallback(
    (threadId: string) => (x: number, y: number) => {
      setWindows((prev) =>
        prev[threadId]
          ? { ...prev, [threadId]: { ...prev[threadId], x, y } }
          : prev,
      );
    },
    [],
  );

  const onResizeWindow = useCallback(
    (threadId: string) => (resize: ResizeTarget) => {
      setWindows((prev) =>
        prev[threadId]
          ? {
              ...prev,
              [threadId]: {
                ...prev[threadId],
                x: resize.x,
                y: resize.y,
                width: resize.width,
                height: resize.height,
              },
            }
          : prev,
      );
    },
    [],
  );

  // --- Auto-reopen: hidden thread becomes "waiting for input" -> pop back
  //     into view with an emphasis flash (unless reduced motion). ---
  const flashTimers = useRef<number[]>([]);
  const prevAttention = useRef(new Map<string, boolean>());
  useEffect(() => {
    flashTimers.current.forEach((timer) => window.clearTimeout(timer));
    flashTimers.current = [];

    if (status !== "ready") return;
    const prior = prevAttention.current;
    const nowMap = new Map<string, boolean>();
    for (const t of threads) nowMap.set(t.id, needsAttention(t));

    const newlyNeed: string[] = [];
    for (const [id, needs] of nowMap) {
      if (needs && !(prior.get(id) ?? false)) newlyNeed.push(id);
    }
    prevAttention.current = nowMap;
    if (newlyNeed.length === 0) return;

    setWindows((prev) => {
      const next = { ...prev };
      for (const threadId of newlyNeed) {
        const existing = next[threadId];
        const cascade = Object.keys(next).length;
        const base = {
          x: 24 + (cascade % 5) * 28,
          y: 24 + (cascade % 5) * 28,
        };
        next[threadId] = existing
          ? { ...existing, visible: true, flash: !reducedMotion, z: nextZ() }
          : {
              ...newWindow(threadId, base.x, base.y, nextZ(), size ?? undefined),
              flash: !reducedMotion,
            };
      }
      return next;
    });

    if (!reducedMotion) {
      flashTimers.current = newlyNeed.map((id) =>
        window.setTimeout(() => {
          setWindows((prev) =>
            prev[id] ? { ...prev, [id]: { ...prev[id], flash: false } } : prev,
          );
        }, FLASH_MS),
      );
    }
  }, [status, threads, nextZ, reducedMotion, size]);

  // Always clean timers on unmount too.
  useEffect(() => {
    return () =>
      flashTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const openThreadIds = useMemo(
    () =>
      new Set(
        Object.values(windows).filter((w) => w.visible).map((w) => w.threadId),
      ),
    [windows],
  );

  // The window currently on top among VISIBLE windows — the one the taskbar
  // should mark as focused and the one a taskbar click should hide (classic
  // toggle). Derived from state, not from the z counter ref, so it is
  // recomputed whenever a window is shown, hidden or raised.
  const focusedThreadId = useMemo(() => {
    let best: { id: string; z: number } | null = null;
    for (const [id, w] of Object.entries(windows)) {
      if (!w.visible) continue;
      if (best === null || w.z > best.z) best = { id, z: w.z };
    }
    return best?.id ?? null;
  }, [windows]);

  // Clamp into the desktop, but never pull the list further from the right
  // edge than its own placement margin: clamping to a SMALLER margin than the
  // initial placement is what made the window creep inwards from the edge.
  const effectiveBuddyPos = useMemo(() => {
    if (size === null) return { x: 0, y: 0 };
    const maxX = Math.max(0, size.width - buddyWidth - buddyMargin);
    const x = Math.min(Math.max(0, buddyPos.x), maxX);
    // Keep the whole window reachable vertically: clamp against its real height
    // (was a hardcoded 360, which no longer matched the box).
    const maxY = Math.max(0, size.height - buddyHeight - buddyMargin);
    const y = Math.min(Math.max(0, buddyPos.y), maxY);
    return { x, y };
  }, [buddyPos, size, buddyWidth, buddyHeight, buddyMargin]);

  const hasCustom = wallpaperUrl !== null;

  return (
    <div
      ref={desktopRef}
      className="aim-root aim-xp"
      onContextMenu={onDesktopContextMenu}
      onClick={closeMenu}
    >
      {/* Wallpaper layer: custom image (server route) or the default classic
          Windows-style backdrop. A tint keeps buddy/windows contrast up. */}
      {wallpaperUrl ? (
        <>
          <div
            className="aim-wp aim-wp-custom"
            role="img"
            aria-label="Custom desktop wallpaper"
            style={{ backgroundImage: `url("${wallpaperUrl}")` }}
          />
          <div className="aim-wp-tint" aria-hidden="true" />
        </>
      ) : (
        <div
          className="aim-wp aim-wp-default"
          role="img"
          aria-label="Default classic desktop wallpaper"
        />
      )}

      <BuddyList
        threads={threads}
        projects={projects}
        openThreadIds={openThreadIds}
        visible={buddyVisible}
        position={effectiveBuddyPos}
        bounds={boundsRef}
        onDismiss={() => setBuddyVisible(false)}
        onMove={(x, y) => setBuddyPos({ x, y })}
        onBuddyClick={onBuddyClick}
        onNewThread={onNewThread}
      />

      {Object.entries(windows)
        .filter(([, w]) => w.visible)
        .map(([threadId, w]) => {
          const thread = threads.find((t) => t.id === threadId);
          if (!thread) return null;
          return (
            <MessageWindow
              key={threadId}
              window={w}
              thread={thread}
              active={threadId === focusedThreadId}
              bounds={boundsRef}
              onFocus={() => onFocusWindow(threadId)}
              onMove={onMoveWindow(threadId)}
              onResize={onResizeWindow(threadId)}
              onClose={() =>
                setWindows((prev) =>
                  prev[threadId]
                    ? {
                        ...prev,
                        [threadId]: { ...prev[threadId], visible: false },
                      }
                    : prev,
                )
              }
              onOpenThread={() => openThreadInApp(threadId)}
            />
          );
        })}

      {/* Windows 98-style taskbar with Start button.
          The wallpaper/background changer lives in the Start menu below.
          Also closes the context menu + start menu on click (handled by their
          own listeners). */}
      <div className="aim-taskbar aim-interactive" onClick={() => closeMenu()}>
        <button
          type="button"
          className="aim-start-btn"
          aria-haspopup="menu"
          aria-expanded={startOpen}
          onClick={(event) => {
            event.stopPropagation();
            setStartMenu(null);
            setStartOpen((open) => !open);
          }}
        >
          <span className="aim-start-logo" aria-hidden="true">
            ◆
          </span>
          Start
        </button>

        {/* Taskbar window buttons. This is the always-visible surface for
            every thread that has an IM window: a hidden window can be recalled
            from here without opening the buddy list, and a thread that needs
            the user is flagged in place (so the pop-up flow is visible even
            when the window itself is minimized). */}
        <div className="aim-taskbar-windows" role="group" aria-label="Open IM windows">
          {Object.entries(windows).map(([threadId, w]) => {
            const thread = threads.find((t) => t.id === threadId);
            if (!thread) return null;
            const needs = needsAttention(thread);
            const title = thread.title ?? thread.titleFallback ?? "Untitled";
            return (
              <button
                key={threadId}
                type="button"
                className={`aim-task-btn${w.visible ? " aim-task-btn-open" : ""}${
                  needs ? " aim-task-btn-needs" : ""
                }`}
                aria-pressed={w.visible}
                aria-label={`${title}${needs ? ", needs your input" : ""}${
                  w.visible ? "" : ", hidden"
                }`}
                title={
                  w.visible
                    ? needs
                      ? `${title} — needs your input (click to hide)`
                      : `${title} (click to focus / hide)`
                    : needs
                      ? `${title} — needs your input (click to show)`
                      : `${title} — hidden (click to show)`
                }
                onClick={(event) => {
                  event.stopPropagation();
                  // Clicking the button for the window that is already on top
                  // hides it (classic taskbar toggle); clicking any other
                  // shows AND focuses it.
                  const isFocused = focusedThreadId === threadId;
                  if (isFocused) {
                    setWindows((prev) =>
                      prev[threadId]
                        ? { ...prev, [threadId]: { ...prev[threadId], visible: false } }
                        : prev,
                    );
                  } else {
                    setWindows((prev) =>
                      prev[threadId]
                        ? {
                            ...prev,
                            [threadId]: {
                              ...prev[threadId],
                              visible: true,
                              flash: false,
                              z: nextZ(),
                            },
                          }
                        : prev,
                    );
                  }
                }}
              >
                {needs ? (
                  <span className="aim-task-needs" aria-hidden="true">
                    !
                  </span>
                ) : null}
                <span className="aim-task-label">{title}</span>
              </button>
            );
          })}
        </div>
        <div className="aim-taskbar-spacer" />
      </div>

      {/* Win98-style Start menu: pops up above the Start button (bottom-left
          of the desktop). Vertical "AIM" brand strip on the left; folders for
          Applications (launching the buddy list) and Settings (wallpaper
          controls) with right-side flyouts. stopPropagation keeps
          outside-click and the Start button toggle working correctly. */}
      {startOpen ? (
        <div
          className="aim-start-menu aim-interactive"
          role="menu"
          aria-label="Start menu"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="aim-start-brand" aria-hidden="true">
            AIM
          </div>
          <div className="aim-start-body">
            <button
              type="button"
              className="aim-menu-item aim-start-folder"
              role="menuitem"
              aria-expanded={startMenu === "apps"}
              onClick={() =>
                setStartMenu((current) => (current === "apps" ? null : "apps"))
              }
            >
              <span>Applications</span>
              <span className="aim-start-arrow" aria-hidden="true">
                ▸
              </span>
            </button>
            <button
              type="button"
              className="aim-menu-item aim-start-folder"
              role="menuitem"
              aria-expanded={startMenu === "settings"}
              onClick={() =>
                setStartMenu((current) =>
                  current === "settings" ? null : "settings",
                )
              }
            >
              <span>Settings</span>
              <span className="aim-start-arrow" aria-hidden="true">
                ▸
              </span>
            </button>
          </div>

          {/* Applications folder: launches the AIM buddy list. */}
          {startMenu === "apps" ? (
            <div
              className="aim-start-flyout"
              role="menu"
              aria-label="Applications"
            >
              <button
                type="button"
                className="aim-menu-item aim-app-item"
                role="menuitem"
                onClick={() => {
                  setStartMenu(null);
                  setStartOpen(false);
                  setBuddyVisible(true);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    d="M4 6h16v8.2a1.4 1.4 0 0 1-1.4 1.4H11.2L6.4 20v-4.4H5.4A1.4 1.4 0 0 1 4 14.2z"
                  />
                  <circle cx="8" cy="10.1" r="1.5" fill="currentColor" />
                  <circle cx="12" cy="10.1" r="1.5" fill="currentColor" />
                  <circle cx="16" cy="10.1" r="1.5" fill="currentColor" />
                </svg>
                <span>AIM</span>
              </button>
            </div>
          ) : null}

          {/* Settings folder: wallpaper / background controls. */}
          {startMenu === "settings" ? (
            <div
              className="aim-start-flyout"
              role="menu"
              aria-label="Settings"
            >
              <button
                type="button"
                className="aim-menu-item"
                role="menuitem"
                onClick={() => {
                  setStartMenu(null);
                  setStartOpen(false);
                  fileInputRef.current?.click();
                }}
              >
                Change background…
              </button>
              {hasCustom ? (
                <button
                  type="button"
                  className="aim-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setStartMenu(null);
                    setStartOpen(false);
                    void restoreDefault();
                  }}
                >
                  Restore default wallpaper
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Wallpaper status toast: renders independent of panel visibility so
          feedback (e.g. Wallpaper updated.) is always seen, even while the
          panel is collapsed. Auto-dismissed via notify()/statusTimer (4000ms);
          right-click Change background routes through notify(), so it now
          gives visible toast feedback. */}
      {statusMsg ? (
        <div
          id="aim-wallpaper-status"
          className="aim-wallpaper-status"
          role="status"
          aria-live="polite"
        >
          {statusMsg}
        </div>
      ) : null}

      {/* Hidden, keyboard-reachable file picker. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="aim-file-input"
        onChange={(event) => void onFileSelected(event)}
        aria-label="Choose a wallpaper image"
      />

      {/* Right-click context menu. */}
      {menu ? (
        <div
          className="aim-menu aim-interactive"
          ref={menuRef}
          style={{
            left: menuPos?.x ?? menu.x,
            top: menuPos?.y ?? menu.y,
          }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
          aria-label="Desktop options"
        >
          <button
            type="button"
            className="aim-menu-item"
            role="menuitem"
            onClick={() => {
              closeMenu();
              fileInputRef.current?.click();
            }}
          >
            Change background…
          </button>
          {hasCustom ? (
            <button
              type="button"
              className="aim-menu-item"
              role="menuitem"
              onClick={() => {
                closeMenu();
                void restoreDefault();
              }}
            >
              Restore default wallpaper
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}