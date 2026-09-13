A nostalgic AOL Instant Messenger desktop over the top of bb-app, reached
from its own **AIM** sidebar entry. Every thread becomes a buddy, every buddy
opens a floating instant-message window, and windows jump back into view when
a thread needs you.

## What you get

- **A buddy list.** Each buddy is one bb-app thread (name + a classic
  presence bullet: online, away, idle, offline, or a pulsing blue
  "waiting for you"). Open a thread in the app and it appears here.
- **Instant-message windows.** Clicking a buddy opens a popup IM window for
  that thread. The chrome is **Windows XP “Luna”**, styled with the scoped
  `xp.css` theme (blue gradient title bars with authentic XP control buttons,
  beveled beige bodies, sunken text wells, and status bars) — a fitting
  mid-2000s companion to the classic AIM desktop. Each box is draggable,
  resizable (grab the bottom corners), shows the thread's live status, and
  doubles as a mini-thread: it renders the most recent conversation
  transcript (agent + your messages) and lets you reply right from the popup,
  continuing that thread on its own engine as if you'd typed in the app's
  composer.
- **It's all inside the app.** The buddy list and every IM window are
  absolutely-positioned elements rendered on a classic-Windows desktop inside
  the app window — no new browser windows, no external UI.
- **A wallpaper you can change.** Right-click the desktop (or click the "Wallpaper" desktop icon at top-left, to open the keyboard-reachable
  wallpaper-controls panel) to upload a PNG/JPEG/GIF/WebP image. It persists
  across reloads
  and app restarts; "Restore default" returns to the built-in classic-style
  backdrop.

## It stays out of the way on purpose

- **Closing a box hides it, it does not kill the thread.** The thread keeps
  running normally in bb-app — you only hide the window. State and position
  are preserved so it comes back where you left it.
- **A thread that needs you pops back in.** When a thread is blocked waiting
  for your input while its box is hidden, the window automatically returns
  to view with a short emphasis animation so you notice it. Users who prefer
  reduced motion get the reopen without the animation.

## How it works

The desktop is a self-contained page (a `navPanel` with its own sidebar
entry) — the one and only AIM surface. The chat reads bb's sidebar thread
data and action hooks, so opening a thread from an IM window routes through
bb's own navigation and keyboard shortcuts keep working. The only
server-side piece is the plugin's own service: wallpaper persistence (image
stored in the plugin's SQLite database and served back through a plugin HTTP
route, so it survives reloads and restarts) plus two small RPCs that power the
mini-threads — `thread_history` and `thread_send`.

## Instant-message popups are real mini-threads

- **Transcript.** Opening a window calls `thread_history`, which reads that
  thread's timeline via the SDK (`bb.sdk.threads.timeline`), flattens the
  `conversation` rows (user + assistant messages), and returns the latest ~80
  in order. The window renders them as classic chat bubbles.
- **Reply in place.** The composer calls `thread_send`, which appends your
  text as a user message through `bb.sdk.threads.send` (mode `auto` — it
  starts the turn on an idle thread or queues/steers a running one). The
  thread continues on its own engine, same as typing in the app.
- **Freshness.** The popup watches the live sidebar thread record: when the
  thread's `updatedAt` bumps (new output / attention), it re-fetches the
  transcript on a short debounce, so streaming replies arrive in the popup.
  Auto-scroll stays pinned to the newest message unless you scroll up.
- **Accessible.** An off-screen polite `aria-live` region announces each
  newly-appended agent/user message as it arrives (“<name> said: …”), so a
  screen reader is told only about genuinely-new rows — not the whole
  transcript on every refetch. The textarea is labelled and disabled while a
  send is in flight; Enter sends, Shift+Enter adds a newline; send errors
  surface in-line. If a thread can't be reached, the window shows a read-only
  error state instead of failing silently.

## For developers

- `app.tsx` registers the `navPanel` (sidebar entry + desktop route).
- `aim/` holds the desktop page, the buddy list, the IM windows, the
  thread-state mapping, a small drag hook, and `XP_scoped.css`.
- `server.ts` persists the wallpaper (SQLite BLOB + HTTP route), validates
  uploaded images, and exposes `thread_history` / `thread_send` RPCs that
  read and append to thread transcripts via `bb.sdk.threads`.

### Vintage theme (XP Luna)

The AIM chrome uses `xp.css@0.2.6` (MIT). Rather than shipping the raw
stylesheet (whose generic `.window` / `button` / `title-bar` classes would
leak into the host app), `scripts/make-xp-scoped.mjs` regenerates
`aim/XP_scoped.css`:

- every selector is prefixed with `.aim-xp ` (handles `@media`, `@supports`,
  `@keyframes`, grouped selectors, and parens in selectors),
- the two `Pixelated MS Sans Serif` fonts are inlined as base64,
- the unused `PerfectDOSVGA437Win` font-face is dropped (~40 KB saved).

`xp.css` is a devDependency — only the vendored, scoped output ships.
Regenerate after any bump with `node scripts/make-xp-scoped.mjs`. `app.tsx`
imports the scoped XP stylesheet before `aim.css` so the AIM layout rules can
override the XP chrome where the desktop needs to differ.

Works on bb 0.42+.