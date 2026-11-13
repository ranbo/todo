# ToDo

A personal to-do web app: one list of categories (Work, Home, Church, …) and tasks, nested as deep as you like.
It is plain static files in `public/` (no build step, no server of its own) that can be hosted on any web server;
data syncs across devices through your own Firebase Firestore project, protected by Google sign-in and
`firestore.rules`. It works offline and can be installed to a phone's home screen.

## Using it

- **Checkbox:** click → done (✕), click again → to do. Shift-click (or press and hold on a phone) → in progress (/).
  A task shows **in progress** automatically when any sub-task is in progress or done, until you mark it done.
- **Select:** click a row. ⌘-click adds/removes rows, Shift-click selects a range, click empty space to clear.
- **Adding tasks (like a checklist in Docs):** select a row and press **Return** for a new task below it (inside, for a
  category or an open parent), or **Shift-Return** for a subtask. While typing a name: Return saves it and starts the
  next one · Return on an empty task outdents it, or ends the list · Tab / Shift-Tab indent / outdent · ↑/↓ move to the
  previous/next task · Backspace on an empty task removes it · Esc or clicking away finishes (empty tasks disappear).
- **Rename:** click the name of the selected row again, double-click it, or press F2.
- **Toolbar:** + new task · copy · cut · paste · delete · undo · redo · ⋯ more.
- **Drag** rows to reorder (drop on the top or bottom edge of a row) or to move them inside another row (drop on its
  middle). Dragging a selected row drags the whole selection. On a phone, press and hold a row to pick it up.
- **Description:** select a task and click the **+** to its right. ⌘B / ⌘I / ⌘U for bold/italic/underline;
  typing "- " at the start of a line (or ⇧⌘8) starts a bulleted list. The **▸** next to a name shows/hides its description; click into it to edit.
- **Completed tasks** stay visible the day they're checked off and drop out of view after midnight.
  **Show task history** (the clock button, or ⋯ menu) shows them all again, with **Created / Started / Completed**
  dates on the right; click a date to change it. A parent with no start date of its own shows (in italics) when its
  first subtask was started or done.
- **See Journal** (the book button, or ⋯ menu) lists completed tasks newest first, grouped by day, with each task's
  place in the list and the time it was checked off. Click an entry to jump to it in the list; Esc goes back.
- **Deleting** keeps the record (marked with a deletion date) rather than erasing it; deleted items aren't shown.
- **Copy** puts an indented text outline on the clipboard. Pasting it back here restores the items with their
  states and descriptions; pasting other text makes one task per line (indentation nests; `[x]` marks done).
- **Keyboard:** ↑/↓ select (Shift extends) · ←/→ collapse/expand · Space done, Shift-Space in progress ·
  Return / Shift-Return new task / subtask · F2 rename · Tab / Shift-Tab indent / outdent ·
  ⌘↑/⌘↓ move · ⌫ delete · ⌘C/⌘X/⌘V · ⌘Z / ⇧⌘Z undo/redo (also in ⋯ → Keyboard shortcuts).
- On iPhone: open the page in Safari → Share → **Add to Home Screen**. On a Mac in Chrome: ⋮ → Cast, save and share →
  **Install page as app**; in Safari: File → **Add to Dock**.

Undo history lasts until the page is reloaded.

## Setting up your own copy

1. In the [Firebase console](https://console.firebase.google.com), create a project (the free Spark plan is plenty).
2. **Firestore Database** → Create database (production mode), then on its **Rules** tab paste `firestore.rules` and
   **Publish**. Each Google account can then read and write only its own data.
3. **Authentication** → Get started → **Sign-in method** → enable **Google**. Under **Settings → Authorized domains**,
   add the domain you'll host the app on (`localhost` is there already).
4. **Project settings** → Your apps → add a **Web** app, then copy `public/firebase-config.example.js` to
   `public/firebase-config.js` and fill in the values it shows. (That file is git-ignored.)

## Running locally

```sh
cd public && python3 -m http.server 8765
```

- http://localhost:8765/ — the real app (Google sign-in; `localhost` is an authorized domain by default)
- http://localhost:8765/?local&demo — try it with sample data kept only in this browser, no sign-in
  (add `&lag` to simulate sync updates arriving late)
- http://localhost:8765/?emulator — use the local Firebase emulators (`firebase emulators:start --only firestore,auth
  --project demo-todo`, Firestore on port 8085, Auth on 9099) with a test sign-in

Tests for the tree logic: `node --test test/model.test.mjs`

## Deploying

Any static web host works: upload the contents of `public/` (including your `firebase-config.js`) to a folder on an
HTTPS site. The page must be served over `http(s)://`, not opened as a `file://`.

For a site served from a Google Cloud Storage bucket, `./deploy.sh` does the upload with your `gcloud` login: copy
`deploy.config.example` to `deploy.config` (git-ignored), set `DEPLOY_TARGET` (e.g. `gs://example.com/todo`), and
run it; `./deploy.sh --dry-run` shows what would change. If another tool mirrors that bucket and deletes files it
doesn't know about, exclude the app's folder there.

After changing files, bump `CACHE` in `public/sw.js` (e.g. `todo-v9`) so installed copies pick up the change promptly.

## Data layout

`users/{uid}/nodes/{nodeId}` — one document per category or task:
`{ parentId (null at the top), type: 'category'|'task', title, state: 'todo'|'in_progress'|'done', order,
collapsed, desc (sanitized HTML), descOpen, createdAt, startedAt, completedAt, deletedAt }`; dates are millisecond
timestamps or null. Checking a task off sets `completedAt` (unchecking clears it); starting it sets `startedAt`.
Older top-level `type: 'context'` items become categories, and items from before dates were tracked get their dates
filled in from their last-saved time, automatically.
