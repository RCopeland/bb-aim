# bb-plugin-aim — overview

An AOL Instant Messenger-style desktop for bb-app, reached from its own **AIM**
sidebar entry. It renders an in-app desktop hosting a **buddy list** of your
threads and draggable **instant-message windows** — no new browser windows.

## What you get

- **Buddy list.** Every bb-app thread appears as a buddy, in bb's own
  parent/child tree. Rows carry the same detail bb's default sidebar rows do:
  the thread name, a classic presence bullet (online / away / idle / offline /
  needs-you), unread and pinned state, a summary of running work (background
  agents, workflows, commands, plans, goals), the branch, the workspace kind
  (managed or your own worktree), the machine, the project, the provider, a
  fork badge, PR state, and a relative last-activity time. Per-row actions pin,
  mark read/unread and archive, through bb's own thread APIs.
- **Instant-message windows.** Clicking a buddy opens a popup IM window for
  that thread. The window is AIM chrome wrapped around **bb's own `ThreadChat`
  component**, so it has full thread functionality: the real timeline
  (including tool calls, diffs, file rows and queued messages), the real
  composer, attachments, @-mentions, drafts, and the thread's own permission
  mode. Each box is draggable, resizable (grab the bottom corners), and shows
  the thread's live status.
- **A taskbar.** Every IM window gets a taskbar button, visible or hidden. A
  minimized window is recalled from there without opening the buddy list, and a
  thread that needs you is flagged in place, so the demand is visible even when
  the window is hidden.
- **It's all inside the app.** The buddy list and every IM window are
  absolutely-positioned elements rendered on the desktop inside the app
  window.
- **A wallpaper you can change.** Right-click the desktop to upload a
  PNG/JPEG/GIF/WebP image. It persists across reloads and app restarts;
  "Restore default" returns to the built-in CSS backdrop.

## It stays out of the way on purpose

- **Closing a box hides it, it does not kill the thread.** The thread keeps
  running normally in bb-app — you only hide the window. State and position are
  preserved so it comes back where you left it, and the taskbar button restores
  it.
- **A thread that needs you pops back in.** When a thread starts needing you
  while its box is hidden, the window automatically returns with a short
  emphasis animation. "Needs you" is `needsAttention()` in `aim/types.ts`: a
  thread blocked on input or a pending interaction, *or* an unread error, *or*
  an unread success. The reopen fires on the rising edge only, so it never
  re-pops on every render. Users who prefer reduced motion get the reopen
  without the animation, and the taskbar flag without the pulse.

## How it works

The desktop is a self-contained page (a `navPanel` with its own sidebar entry)
— the one and only AIM surface. The buddy list reads bb's sidebar thread data
and action hooks, so opening a thread from an IM window routes through bb's own
navigation and keyboard shortcuts keep working.

The only server-side piece is the plugin's own service: wallpaper persistence
(image stored in the plugin's SQLite database and served back through a plugin
HTTP route, so it survives reloads and restarts). The plugin deliberately has
**no thread read/write RPCs** — see below.

## The IM window is the host's chat, not a reimplementation

Each IM window renders `ThreadChat` with `variant="compact"`,
`layout="contained"` and `permissionPolicy="inherit"`.

An earlier version hand-rolled this: a `thread_history` RPC read the timeline
via `bb.sdk.threads.timeline` and flattened it to `kind: "conversation"` rows,
and a `thread_send` RPC appended messages through `bb.sdk.threads.send`. That
path was removed because it was lossy and drifted from the real client:

- **It dropped everything that was not plain conversation text** — tool calls,
  diffs, file rows, queued messages, drafts, images. A thread that only made
  sense with its tool rows looked empty in the popup.
- **It capped history** at the most recent ~80 rows, so long threads silently
  lost their beginning.
- **It bypassed the host submit pipeline.** Sends did not carry attachments,
  @-mentions, or the thread's resolved execution settings, and never produced
  core's queued-message card, countdown, or optimistic state.
- **It re-derived thinking rows** by scanning up to 4000 raw events and
  joining `reasoning` items onto turns — a second implementation of something
  the host already renders correctly.

`permissionPolicy="inherit"` is not incidental: it pins every send to the
thread's own resolved default and renders the picker as a dimmed label, so a
plugin surface can never widen a thread's permission mode.

## The buddy list is a parallel view, not a sidebar replacement

bb's default sidebar list is intentionally left registered and untouched — the
plugin does **not** use `experimental_threadList`. The buddy list reaches
information parity the honest way, by reading the same host hooks bb's own rows
read:

- `experimental_useSidebarThreads()` — the live thread list plus projects
- `experimental_useProviders()` — provider display names
- `experimental_useSidebarThreadPullRequest(threadId)` — PR number, state and
  rolled-up attention
- `experimental_useSidebarThreadSplit(threadId)` — split drag plus pane
  placement
- `experimental_useSidebarThreadActions()` — open, pin, read, rename, archive,
  requestDelete

The per-row PR and split hooks are called inside the `BuddyRow` component — one
instance per row — never in a loop in the list component, because that would
violate the rules of hooks. The list also calls every hook before its early
return for the hidden state; an earlier version returned first and crashed on
dismiss.

## For developers

- `app.tsx` registers the `navPanel` (sidebar entry + desktop route).
- `aim/` holds the desktop page, the buddy list, the IM windows, the
  thread-state mapping plus row-format helpers, two small drag/resize hooks,
  and `chrome.css`.
- `server.ts` persists the wallpaper (SQLite BLOB + HTTP route) and validates
  uploaded images. That is its entire surface.

### Theme

`aim/chrome.css` defines only the chrome primitives the components use —
`.window`, `.window-body`, `.title-bar*`, `.status-bar*`, `.tree-view`, and
`button` — all scoped under `.aim-xp` so they cannot leak into the host app.
`aim.css` layers the AIM palette (teal title bars, silver body, gold accents)
on top.

An earlier version vendored the entire **98.css** design system (~68KB, scoped
by a build script) and then overrode it. That was retired: shipping a whole OS
design system meant a large artifact to keep re-scoping, and its generic rules
kept pulling the layout back toward a 1998 desktop instead of giving space to
thread detail and the real chat. There is nothing to regenerate now; the
`98.css` devDependency and the scoping script are gone.
