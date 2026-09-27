# bb-plugin-aim

[![CI](https://github.com/RCopeland/bb-aim/actions/workflows/ci.yml/badge.svg)](https://github.com/RCopeland/bb-aim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

An AOL Instant Messenger-style desktop for bb-app, reached from its own **AIM**
sidebar entry. It renders a classic-Windows desktop inside the app window that
hosts a **buddy list** of your threads and draggable **instant-message
windows** — all in-app elements (no new browser windows).

## What you get

- **Buddy list** — each bb-app thread is a buddy, in bb's own parent/child tree.
  Rows are deliberately minimal and AIM-style: a presence dot plus the thread
  title. A pinned thread carries a gold star, a "needs you" badge marks a thread
  waiting on you, and the single per-row action is archive, through bb's own
  thread APIs. The detail the dense rows used to paint (presence state, unread,
  running activity, branch, machine, project, provider, last-activity time) still
  reaches assistive tech through each row's accessible name, and the real detail
  is in the thread's IM window. Draggable, collapsible, keyboard reachable.
- **IM windows** — clicking a buddy pops up an IM window for that thread. Each
  window wraps **bb's own `ThreadChat` component**, so it has full thread
  functionality: the real timeline (including tool calls, diffs, file rows and
  queued messages), the real composer, attachments, @-mentions, drafts and the
  thread's own permission mode. Sends go through the host's submit pipeline
  exactly as they do in the main pane. Windows are draggable, resizable, and
  float above the app.
- **Pops back when you're needed** — when a thread stops needing you no longer
  (blocked on input, an unread error, an unread success) and its window is
  hidden, the window auto-returns with a short emphasis animation. The pop-up
  fires on the rising edge only, so it never re-pops every render.
- **Taskbar** — every IM window has a taskbar button, visible or hidden. A
  minimized window is recalled from there without opening the buddy list, and a
  thread that needs you is flagged in place, so the demand is visible even when
  the window is hidden. Clicking the focused window's button hides it.
- **Hide never kills** — closing a box only hides it; the thread keeps
  running in bb-app and the window keeps its position/state.
- **Reduced-motion safe** — the emphasis animation and presence pulse are
  disabled for `prefers-reduced-motion` users (reopen still happens).
- **Keyboard accessible** — buddy rows, row actions and all window controls are
  real `<button>`s with labels.
- **Changeable wallpaper** — right-click the desktop to upload a
  PNG/JPEG/GIF/WebP wallpaper. It is stored **server-side** in the plugin's
  SQLite database and served back through a plugin HTTP route, so it persists
  across reloads and app restarts. "Restore default" reverts to the built-in
  CSS wallpaper.

## Layout

```
app.tsx            registers the navPanel (sidebar entry + desktop route)
server.ts          wallpaper: DB BLOB persistence + HTTP route + RPC
                   (no thread read/write RPCs — ThreadChat owns that)
aim/DesktopPage.tsx desktop page: wallpaper, context menu, window state,
                   attention auto-reopen, taskbar
aim/BuddyList.tsx  the buddy list (one BuddyRow per thread, per-row host hooks)
aim/MessageWindow.tsx the IM window: AIM chrome around the host ThreadChat
aim/types.ts        indicator -> presence/attention mapping + row-format helpers
aim/useAimDrag.ts   pointer-based drag (handles move/up/cancel)
aim/useAimResize.ts pointer-based corner resize, clamped to the desktop
aim/chrome.css     our own window chrome primitives, scoped to .aim-xp
aim.css            the AIM palette, desktop layout, wallpaper layers, menus
```

## Theme (light retro IM, not a Win98 shell)

Earlier versions vendored the whole **98.css** design system (~68KB, scoped by
`scripts/make-98-scoped.mjs`) and skinned it with the AIM 3.0 palette. That was
retired deliberately: shipping an entire OS design system meant a large vendored
artifact to keep re-scoping, plus dozens of generic rules (`.window`, `button`,
`.title-bar`) that kept pulling the layout back toward a 1998 desktop instead of
letting thread detail and the real chat use the space.

`aim/chrome.css` now defines only the primitives the components actually use —
`.window`, `.window-body`, `.title-bar*`, `.status-bar*`, `.tree-view`, and
`button` — all scoped under `.aim-xp` so nothing can leak into the host app.
`aim.css` layers the AIM palette (teal title bars, silver body, gold accents)
on top. There is nothing to regenerate; the `98.css` devDependency and the
scoping script are gone.

## Thread state signal

Two related predicates live in `aim/types.ts`:

- `isWaitingForInput(thread)` — bb's resolved `indicator === "waiting-for-input"`,
  OR-ed with `hasPendingInteraction` (a pending approval/question). This is the
  faithful "the agent is blocked on you" flag.
- `needsAttention(thread)` — the broader "come look at me" signal used by the
  auto-reopen edge, the buddy-list marker and the taskbar flag. It covers
  `isWaitingForInput` plus `unread-error` and `unread-success`, so a failed or
  finished-but-unseen thread also surfaces. All three surfaces read this one
  function, so they cannot disagree.

Both are read live via `experimental_useSidebarThreads()`. `threadPresence()`
maps every other indicator to a presence bullet and treats unknown values as
offline (bb adds indicator kinds over time).

## How it works

- There is exactly **one AIM surface**: the desktop *page*, registered as a
  `navPanel` so it gets its own sidebar entry and a host-wrapped panel route.
  The former always-on `experimental_appOverlay` registration was removed, so
  the AIM chrome appears only on this page.
- The desktop fills the panel body; the buddy list and IM windows position
  absolutely within it and clamp to its size while dragging. The bottom
  taskbar strip (`--aim-taskbar-h`) is reserved out of the drag bounds so a
  window can never be dragged under the taskbar.
- **IM windows render bb's own `ThreadChat`** (`variant="compact"`,
  `layout="contained"`, `permissionPolicy="inherit"`). The plugin does not read
  or write thread transcripts itself. The previous hand-rolled path flattened
  the timeline to `kind: "conversation"` rows — silently dropping tool calls,
  diffs, files, queued messages and drafts — and sent via
  `bb.sdk.threads.send` directly, bypassing the host submit pipeline. `inherit`
  matters: a plugin surface must never widen a thread's permission mode.
- The buddy list is a **parallel view, not a sidebar replacement**. bb's default
  sidebar list is left registered and untouched; `experimental_threadList` is
  deliberately NOT used. Rows read the same host hooks bb's own rows read
  (`experimental_useSidebarThreads`,
  `experimental_useProviders`, `experimental_useSidebarThreadPullRequest`,
  `experimental_useSidebarThreadSplit`), and act through
  `experimental_useSidebarThreadActions` (pin / read / rename / archive /
  requestDelete).
- The per-row PR and split hooks are called inside `BuddyRow` — one component
  instance per row — never in a loop in the list component (rules of hooks).
- Opening a thread from an IM window routes through bb's own
  `experimental_useSidebarThreadActions().open(id)`, so splits, panes, and
  shortcuts behave as usual.
- Closing a window sets `visible: false` only — the thread id and window
  position stay in state, and the thread is never touched. The taskbar button
  restores it.
- The wallpaper uploads as base64 over RPC, is validated by magic bytes
  (PNG/JPEG/GIF/WebP), stored as a BLOB in `bb.storage.database()`, and
  served by `bb.http.route("GET", "/wallpaper", …)`. Picking an image
  persists and reapplies on reload/restart.

## Install / build

```
npm install
bb plugin install .
bb plugin reload aim
```

Build (contract gate) and type-check:

```
bb plugin build
npx tsc --noEmit
```

The frontend compiles to `dist/app.js` + `dist/app.css`; React and the SDK
are provided by bb at runtime (never bundled).

## License

[MIT](LICENSE) © Rob Copeland