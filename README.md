# Tab Workspaces

A Manifest V3 browser extension that turns your tabs into named workspaces, in
the spirit of Workona but as a self-contained implementation with no backend,
account, or external service. Everything lives in the browser's own extension
storage. Workspaces sync across every browser signed into the same browser
account (Chrome/Edge profile sync), so switching or reinstalling a browser keeps
your workspaces and saved tabs.

## Try it locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked.
4. Select this folder: `C:\PersonalProjects\BrowserExtensions\AIExtension\TabWorkspaces`.
5. Click the toolbar icon (or press `Alt+Shift+W`) to open the workspace hub.

## The hub tab

Unlike a normal popup, the main interface is a dedicated **hub page** that opens
in its own pinned browser tab (`hub.html`). It behaves as a singleton:

- Clicking the toolbar action or pressing `Alt+Shift+W` opens the hub, or focuses
  it if it is already open.
- If you close the hub tab, the toolbar action / shortcut reopens it. The
  background service worker forgets the old tab id when it closes and creates a
  fresh one on the next open.
- The hub is a privileged extension page, so it talks to the background service
  worker over `chrome.runtime` messaging and stays live as tabs open and close.

This is implemented with real extension APIs (`chrome.action.onClicked`,
`chrome.tabs.create({ url: chrome.runtime.getURL("hub.html") })`, and a
`chrome.tabs.query` lookup), not by simulating a page.

## Workspaces (Workona-style spaces)

- **Create / rename / delete / recolor** workspaces from the sidebar or context
  menu.
- **Reorder** workspaces by dragging them in the sidebar.
- **Switch** workspaces: the current space's live tabs are autosaved, then the
  target space's tabs open (reusing any tabs that are already open).
- **Autosave, no manual step needed.** Opening the hub materializes the active
  workspace — its saved tabs open into the window (reusing the blank New Tab)
  and from then on the workspace autosaves as you open, close, navigate, or
  reorder tabs. You never have to press Save to keep a workspace current.
- **Reopen on startup.** When the browser launches, the extension automatically
  reopens the workspace you were last in (the persisted `activeWorkspaceId`),
  opening its saved tabs and clearing any unrelated tabs so the window reflects
  that workspace. It waits for a browser window to exist first, then opens the
  pinned hub and materializes the workspace.
- **Save current tabs** still exists to snapshot the current window into the
  active workspace on demand, optionally into a named saved group.
- **Open all** restores a workspace's tabs, skipping URLs that already have an
  open tab so you never accumulate duplicates.
- **Tab groups** organize saved tabs within a workspace (create, rename, delete,
  open all).
- **Per-tab actions**: open/focus, rename, remove from the workspace (without
  closing the real tab), close the real browser tab, copy URL, and move between
  groups or workspaces via context menu or drag-and-drop.
- **Search** across workspace names, group names, tab titles, and URLs.
- **Workspace previews** appear after an intentional hover/focus delay and show
  up to six stored tabs plus a `+N more` count. One passive preview node is
  reused, so it never steals focus or remains mounted per workspace.
- **Open tabs** section shows the live browser session for the active workspace,
  visually distinct from saved groups, with an "open" badge on saved tabs that
  are currently open.

### Keyboard

- `/` focus search
- `n` new workspace
- `s` save current tabs
- `1`–`9` jump to that workspace
- `j` / `k` move to the next / previous workspace
- `Esc` close menus, clear search
- `Alt+Shift+W` open the hub from anywhere (configurable in the browser)

## Browser tab integration

The background service worker is the only component that touches the tabs API.
It uses **event listeners rather than polling**:

- `tabs.onCreated`, `onRemoved`, `onUpdated`, and `onMoved` feed a debounced
  autosave. Activation alone is ignored because it changes no persisted field.
  Unchanged snapshots keep stable tab IDs and do not write or broadcast.
- Autosave only writes for a workspace that is **live** — one whose saved tabs
  have actually been opened into the window this session (by materializing on
  hub open, switching, restoring, or an explicit save). A workspace that has
  never been opened this session keeps its saved tabs untouched, so opening the
  hub on a stray blank New Tab can never overwrite a saved workspace. The
  live-workspace set is session-scoped and resets on browser restart.
- Save/restore/switch use `chrome.tabs.query`, `chrome.tabs.create`,
  `chrome.tabs.update`, `chrome.tabs.remove`, `chrome.tabs.move`, and
  `chrome.windows.create`.
- Restore/switch dedupe against tabs already open in the window.
- **Order is preserved exactly.** When a workspace's tabs are opened (on
  startup, switch, restore, or first materialize), the tabs are reordered in the
  window to match the saved order — reused tabs are moved into place and newly
  created tabs are positioned, so reopening never shuffles your tabs. The pinned
  hub tab stays put because pinned tabs always sort before unpinned ones.
- The hub tab is excluded from tracking and from saved sessions.

## Architecture

Focused, dependency-free modules:

- `storage.js` — the data layer. Owns the persisted shape and all
  `chrome.storage` access (sharded `sync` + `local` mirror). Pure logic; no UI
  or tabs API.
- `background.js` — the service worker. Manages the hub tab, tracks live tabs via
  events, performs save/restore/switch, and answers hub messages.
- `hub.html` / `hub.css` / `hub.js` — the hub page. Holds an in-memory copy of
  state, renders the sidebar and active workspace, and re-fetches on the
  `stateChanged` broadcast.
- `floating.js` — a single, reusable overlay manager for every transient popup
  (dropdown menus, right-click context menus, and confirm popovers). See below.
- `preview.js` — one passive, delayed workspace preview. It mounts only the six
  visible summary rows and clears them immediately when dismissed.

### Overlays: one reliable system

All menus and popovers go through `floating.js`, which guarantees:

- Only one overlay is open at a time.
- It is positioned inside the viewport (it flips or clamps near edges) and
  rendered in a top-level layer, so it is never clipped by a scroll container.
- It dismisses on outside pointer-down, `Escape`, scroll, resize, and whenever
  the app re-renders (`render()` calls `closeAll()` first). This is why a menu
  can never stay stuck on screen after a workspace switch or a live tab update.
- Focus moves into the menu (arrow-key navigable) and returns to the trigger on
  close.

Renames happen inline (click to edit, `Enter` to save, `Escape` to cancel), and
the only confirmation is a small popover for deleting a workspace or group.
There are no native `prompt()`/`confirm()` dialogs.

### Branding

The logo (`assets/logo.svg`) is an original mark: stacked tab bars with an
active-workspace dot, on a dark rounded tile. A restrained light perimeter and
higher-contrast secondary bars keep it legible on both light and dark browser
chrome. `assets/gen-icons.mjs` rasterizes it into `icon16/32/48/128.png` (run
`node assets/gen-icons.mjs` to regenerate) for the manifest `icons`, the
toolbar `action` icon, the hub favicon, the header mark, and the first-run empty
state. The hub uses a fixed Workona-style palette — a dark workspace rail with a
bright white content area — and intentionally does not follow the OS dark theme,
so the main panel stays light and legible regardless of system settings.

### Large-workspace efficiency

- Search runs locally against the already-loaded tree and stores lightweight
  IDs instead of duplicate tab objects.
- The hub retains a unique open-URL set rather than another set of full tab
  metadata.
- Workspace counts are calculated once per state revision.
- Workspace/group/tab actions use delegated listeners where practical.
- Tab and search rows render in batches of 120; an `IntersectionObserver` loads
  the next batch near the viewport, with a keyboard-accessible fallback button.
  This is progressive rendering, not a data limit.
- Favicons use native lazy loading and async decoding.
- Refreshes are serialized and coalesced; live changes during inline editing
  result in one deferred refresh rather than a polling timer.
- Hub-initiated mutations use their response directly instead of receiving the
  same full state again through a broadcast.
- Storage reads legacy v1 only as a migration fallback, removes it after
  migration, preserves stable session-tab IDs, and skips unchanged autosaves.

### Where state lives

- **Synced data** (`chrome.storage.sync`): the durable source of truth, synced
  across browsers signed into the same account. Because sync has tight quotas
  (~8 KB per item, ~100 KB total), the tree is **sharded**: a small index item
  (`tw:index` = version, active workspace, workspace order) plus one item per
  workspace (`tw:ws:<id>`). Writes are debounced to stay under sync's write-rate
  limit.
- **Local mirror** (`chrome.storage.local`, key `tabWorkspaces.v2`): a full copy
  of the whole tree. It is the fallback when the user is signed out / sync is
  unavailable, and the source of truth for any single workspace too large to fit
  a sync item (that workspace stays local-only while the rest still sync). On
  read, the tree is reassembled from sync and any missing/oversized workspace is
  filled in from this mirror, so no data is ever lost.
- **Session-scoped facts** (`chrome.storage.session`): the hub tab id, the
  tab→workspace ownership map, the set of **live** workspaces (materialized into
  the window this session), and a transient "suspend tracking" flag. Cleared on
  browser restart, which is correct because browser tab ids are only valid
  within a session.

When another signed-in browser changes a workspace, `chrome.storage.onChanged`
(sync area) fires and the hub refreshes live.

### Data safety: switching is non-destructive by design

Workspace switching never loses tabs. Several layered guarantees enforce this:

- **Serialized writes (no lost updates).** Every durable change is a
  read-modify-write, and they all run through a single-writer promise chain
  (`withWriteLock`). Two overlapping operations — an autosave firing while you
  switch, or rapid A→B→A→B switching — can never read the same tree, mutate
  separate copies, and have the later save silently discard the earlier one.
- **Serialized window operations + switch coalescing.** Switch, restore,
  save, and first-time materialize each mutate the shared browser window and the
  shared tab→workspace ownership map. They run through one operation chain
  (`runExclusive`), so only one ever touches the window at a time — no
  interleaving that could close tabs another operation just opened or cross tab
  ownership between workspaces. Rapid switching is additionally *coalesced*:
  spamming A→B→C→A collapses to a single drain that ends at the last requested
  target instead of replaying every hop, and the hub is converged on the final
  state afterward.
- **Fault-tolerant tab calls.** Browser-tabs operations (`remove`, `move`,
  `create`) are wrapped so a tab id that became stale (the user or an event
  closed it) is skipped instead of rejecting the whole operation. Removals are
  done one id at a time for the same reason. This is what stops rapid switching
  from throwing "no tab with id" and aborting mid-surgery.
- **Owner-map writes are serialized too.** The tab→workspace map is changed both
  by window operations and by tab events (`onCreated`/`onRemoved`) that fire
  outside them; all of its read-modify-writes go through one chain
  (`updateTabOwners`) so concurrent sources can't lose entries.
- **Mid-navigation tabs are never recorded as blank.** A tab opened for a real
  url reports `about:blank`/`about:newtab` until its navigation commits (tens to
  hundreds of ms later). A snapshot taken in that gap — an autosave, or a rapid
  switch capturing the outgoing workspace — would otherwise record the tab as a
  blank "New Tab" and overwrite the real saved url. We remember each freshly
  opened tab's intended url in a session-scoped pending map (`pendingUrls`) and
  snapshots use that intended url (`effectiveUrl`) until the tab actually
  reports a real url, at which point the entry is cleared. This is what stops
  tabs from silently turning into New Tab under fast switching.
- **Empty snapshots never overwrite.** Writing a workspace's session with an
  empty tab list does nothing if that workspace currently has tabs
  (`allowEmpty` defaults to false). A transient loss of tab ownership (mid-
  switch, a cleared session map) therefore cannot wipe a saved workspace.
  Intentional clears pass `allowEmpty: true`.
- **Stale autosaves are dropped.** An autosave snapshots the window for the
  workspace it believed was active (`expectedWorkspaceId`). If a switch changed
  the active workspace before the write lands, the write is skipped, so an old
  window snapshot can never be written onto a different workspace.
- **Persist-before-close on switch.** Switching saves the outgoing workspace and
  flushes it (`flushPendingSync`) before closing its browser tabs, so an
  interruption between save and close cannot drop them.
- **Reads prefer the freshest copy.** `getRoot` merges sync and local per
  workspace and keeps whichever is newer by `updatedAt`. Because the sync push
  is debounced (~1.5s), the local mirror is newer during that window; comparing
  timestamps means a recent local change is never overwritten by the lagging
  sync copy, while a genuinely newer cross-browser update still wins. The active
  workspace pointer likewise follows the synchronously-written local mirror, so
  a switch is never snapped back by a lagging sync read.
- **No silent recovery by deletion.** A failed or empty storage read is never
  treated as "no data": a read error propagates instead of returning an empty
  tree, and `ensureDefaults` only ever writes an empty root when the local key
  is genuinely absent. Existing data is preserved rather than replaced.
- **A workspace present on either side is never dropped.** The merge takes the
  union of the sync index and local ids, so a workspace not yet reflected in a
  transient sync read (or oversized/local-only) is always kept.

### Data model

```
root (tabWorkspaces.v2)
├─ version, activeWorkspaceId
└─ workspaces[]
   ├─ id, name, color, createdAt, updatedAt
   ├─ sessionTabs[]   ← the live tab set (autosaved / restored)
   └─ groups[]        ← saved tab groups
      ├─ id, name, createdAt
      └─ tabs[]  { id, url, title, favIconUrl, pinned, addedAt }
```

Every tab record lives in exactly one array (a workspace's `sessionTabs` or one
group's `tabs`). Nothing is duplicated across the tree, so thousands of saved
tabs cost one record each. In sync the tree is split into one item per workspace
(so no single item exceeds the quota); the local mirror keeps it under one key.

Data from the earlier `tabWorkspaces.v1` schema is migrated automatically on
first load (its collections become groups), and existing local-only data is
seeded into sync the first time it loads after this version.

## Notes and limits

- Only `http`/`https` tabs are saved. Internal pages (`chrome://`, `edge://`,
  `about:`, extension pages) cannot be reliably reopened and are skipped.
- No application-level limit on workspaces or tabs; only the browser's own
  memory and storage limits apply.
- A single restore opens up to 1000 tabs at a time as a safety valve.
- Sync requires the browser to be signed in with sync enabled. When signed out,
  everything still works locally and syncs once you sign back in. A single
  workspace larger than ~8 KB (very many saved tabs) stays on that device; the
  rest of your workspaces still sync normally.
