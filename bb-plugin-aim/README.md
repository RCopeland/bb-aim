# bb-plugin-aim

An AOL Instant Messenger-style desktop for bb-app, reached from its own **AIM**
sidebar entry. It renders a classic-Windows desktop inside the app window that
hosts a **buddy list** of your threads and draggable **instant-message
windows** — all in-app elements (no new browser windows).

## What you get

- **Buddy list** — each bb-app thread is a buddy, shown with its name and a
  classic presence bullet (online / away / idle / offline / waiting-for-you).
  It's draggable and collapsible.
- **IM windows** — clicking a buddy pops up an IM window for that thread,
  styled with **Windows 98 chrome** (scoped `98.css`) re-skinned with the
  **AIM 3.0 (1999) palette**: teal-slate title/status bars, silver list body,
  pale-gold header bands and Running-Man-gold accents — a faithful nod to the
  real AOL Instant Messenger buddy list / IM window look. Windows are
  draggable, resizable (drag the bottom corners), and float above the app.
- **Mini-thread popups** — each IM window doubles as a real thread: it shows
  the latest conversation transcript (agent + your messages as chat bubbles)
  and lets you reply in place with a labelled composer (Enter sends,
  Shift+Enter newline). Replies continue that thread on its own engine, same
  as typing in the app's composer.
- **Live transcript** — the popup re-fetches from the thread whenever its
  activity changes (short debounce), keeping the conversation fresh; it
  auto-scrolls to the newest message unless you've scrolled up.
- **Pops back when you're needed** — when a thread is blocked waiting for
  your input and its box is hidden, the window auto-returns with a short
  emphasis animation.
- **Hide never kills** — closing a box only hides it; the thread keeps
  running in bb-app and the window keeps its position/state.
- **Reduced-motion safe** — the emphasis animation and presence pulse are
  disabled for `prefers-reduced-motion` users (reopen still happens).
- **Keyboard accessible** — buddy rows and all window controls are real
  `<button>`s with labels.

- **Changeable wallpaper** — right-click the desktop, or click the
  "Wallpaper" desktop icon (top-left) to open the keyboard-reachable
  wallpaper-controls panel, to upload a PNG/JPEG/GIF/WebP image. It is stored
  **server-side**
  in the plugin's SQLite database and served back through a plugin HTTP
  route, so it persists across reloads and app restarts. "Restore default"
  reverts to the built-in classic-style CSS wallpaper.

## Layout

```
app.tsx            registers the navPanel (sidebar entry + desktop route)
server.ts          wallpaper: DB BLOB persistence + HTTP route + RPC
aim/DesktopPage.tsx desktop page: wallpaper, context menu, window/auto-reopen state
aim/BuddyList.tsx  the buddy list
aim/MessageWindow.tsx the IM popup
aim/types.ts        thread indicator -> presence / isWaitingForInput mapping
aim/useAimDrag.ts   pointer-based drag (handles move/up/cancel)
aim/WIN98_scoped.css vendored, scoped 98.css (Win98 base) — regenerate via script
scripts/make-98-scoped.mjs prefixes + inlines fonts, scoping to .aim-xp
aim.css            the AIM desktop chrome, wallpaper layers, context menu, AIM 3.0 palette
```

## Vintage theme (Win98 base + AIM 3.0 palette)

The AIM chrome sits on **98.css** (`98.css@0.1.21`, MIT — jdan/98.css, the era-
correct Windows 98 design system; XP.css "Luna" would be Windows XP / 2001).
The raw stylesheet uses generic classes (`.window`, `button`, `title-bar`) that
would leak into the rest of bb-app, so it's **scoped** by
`scripts/make-98-scoped.mjs` into `aim/WIN98_scoped.css`: every selector is
prefixed with `.aim-xp`, and the `Pixelated MS Sans Serif` fonts are inlined as
base64. `98.css` is a devDependency — only the vendored scoped CSS ships.
Regenerate after any bump with `node scripts/make-98-scoped.mjs`; `app.tsx`
imports it before `aim.css`, and a trailing **AIM 3.0 palette layer** in
`aim.css` re-skins the Win98 chrome with the teal-slate / silver / gold colors
of the real AOL Instant Messenger 3.0 (1999) buddy list and IM windows.

## Thread state signal

The "waiting for user input" signal is bb's resolved sidebar indicator
`indicator === "waiting-for-input"`, OR-ed with `hasPendingInteraction`
(pending approval/question). This is read live via
`experimental_useSidebarThreads()`. There is no gap: it's the faithful
"agent is blocked on you" flag. `threadPresence()` in `aim/types.ts` maps
every other indicator to a presence bullet and treats unknown values as
offline.

## How it works

- There is exactly **one AIM surface**: the desktop *page*, registered as a
  `navPanel` so it gets its own sidebar entry and a host-wrapped panel route.
  The former always-on `experimental_appOverlay` registration was removed, so
  the AIM chrome appears only on this page.
- The desktop fills the panel body; the buddy list and IM windows position
  absolutely within it and clamp to its size while dragging.
- Opening a thread from an IM window routes through bb's own
  `experimental_useSidebarThreadActions().open(id)`, so splits, panes, and
  shortcuts behave as usual.
- Closing a window sets `visible: false` only — the thread id and window
  position stay in state, and the thread is never touched.
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