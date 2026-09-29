// background.js
// Service worker: the single source of truth for state and the only place
// that touches the browser tabs/windows API.
//
// Responsibilities:
//   1. Manage the dedicated hub tab (singleton open/focus/reopen).
//   2. Track the live open tabs of the active workspace via tab events, and
//      autosave them into that workspace's sessionTabs (debounced).
//   3. Save / restore / switch workspaces against real browser tabs, deduping
//      against tabs that are already open.
//   4. Answer messages from the hub and broadcast state changes back to it.
//
// MV3 service workers are ephemeral, so nothing important is kept only in
// memory. Session-scoped facts (the hub tab id, which browser tab belongs to
// which workspace) live in chrome.storage.session; durable data lives in
// chrome.storage.local via storage.js.

import * as store from "./storage.js";

const HUB_URL = chrome.runtime.getURL("hub.html");
const RESTORE_LIMIT = 1000;

// Keys in chrome.storage.session (cleared when the browser restarts).
const SESSION_KEYS = {
  hubTabId: "hubTabId",
  suspendTracking: "suspendTracking", // set during programmatic restore/switch
  tabOwners: "tabOwners", // { [browserTabId]: workspaceId } ownership map
  // Workspace ids whose saved session has been "materialized" into the window
  // during this browser session (via switch/restore/save). ONLY these are
  // eligible for autosave-overwrite. This is what stops a fresh window (which
  // owns no real tabs yet) from clobbering a workspace's saved tabs with a
  // stray blank New Tab. Session-scoped, so it resets on browser restart.
  liveWorkspaces: "liveWorkspaces",
  // { [browserTabId]: intendedUrl } for tabs we just opened for a real URL that
  // have not finished navigating yet. While a tab is navigating, chrome reports
  // its url as about:blank/newtab, so a snapshot taken in that window would
  // record it as a blank "New Tab" and overwrite the real saved url. This map
  // lets a snapshot use the intended url until the tab actually reports it.
  pendingUrls: "pendingUrls"
};

// A blank browser tab (new-tab page / about:blank) is a real, ownable tab.
const NEW_TAB_URL = "about:newtab";

// --- Lifecycle ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await store.ensureDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  await store.ensureDefaults();
  // Bring back the workspace you were last in when the browser starts, without
  // needing to open the hub by hand. This opens the hub (pinned) and
  // materializes the active workspace's saved tabs into the window.
  await restoreLastWorkspaceOnStartup();
});

// On browser launch, open the hub and reopen the last-active workspace's tabs.
// onStartup can fire before any window has finished restoring, so we wait for a
// normal window to exist before creating tabs. Runs at most once per launch.
async function restoreLastWorkspaceOnStartup() {
  try {
    const root = await store.getRoot();
    if (!root.activeWorkspaceId) return; // nothing to restore
    await waitForNormalWindow();
    await openHub({ startup: true }); // hub tab + materialize last workspace
  } catch (_e) {
    // Best-effort: if startup restore fails, the user can still open the hub
    // manually, which materializes the same workspace.
  }
}

// Resolve once a normal (tabbed) browser window exists, so tab creation has a
// valid target. Polls briefly because onStartup may precede window restore.
async function waitForNormalWindow(maxWaitMs = 8000, stepMs = 250) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
      if (wins && wins.length) return true;
    } catch (_e) {
      // ignore and retry
    }
    await delay(stepMs);
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// When another signed-in browser changes workspace data, chrome.storage.sync
// fires here. Refresh any open hub so the change appears live. We ignore our
// own local mirror writes to avoid feedback loops.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const touched = Object.keys(changes).some(
    (key) => key === store.SYNC_INDEX_KEY || key.startsWith(store.SYNC_WS_PREFIX)
  );
  if (touched) broadcastState();
});

// Clicking the toolbar icon opens or focuses the hub (no popup is declared).
chrome.action.onClicked.addListener(() => {
  openHub();
});

// Keyboard command(s) declared in the manifest.
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-hub") openHub();
});

// --- Hub tab management (singleton) ------------------------------------------

async function getSession(key) {
  const data = await chrome.storage.session.get(key);
  return data[key];
}
async function setSession(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

// Open the hub if it does not exist, otherwise focus the existing one.
async function openHub({ startup = false } = {}) {
  const existing = await findHubTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await materializeActiveWorkspace({ startup });
    return existing;
  }
  const tab = await chrome.tabs.create({ url: HUB_URL, pinned: true });
  await setSession(SESSION_KEYS.hubTabId, tab.id);
  await materializeActiveWorkspace({ startup });
  return tab;
}

// On the first hub open of a browser session, bring the active workspace's
// saved tabs into the window so the window reflects that workspace and autosave
// starts tracking it automatically (no manual "Save" needed). Does nothing if
// the workspace is already live, has no saved tabs, or nothing is active.
//
// On the startup path ({ startup: true }) we also clear any leftover unowned
// tabs — e.g. the browser's own "continue where you left off" tabs — so the
// window shows only the workspace you were last in. On the manual open path we
// stay non-destructive and only remove a leftover blank placeholder.
async function materializeActiveWorkspace({ startup = false } = {}) {
  const root = await store.getRoot();
  const activeId = root.activeWorkspaceId;
  if (!activeId) return;
  if (await isWorkspaceLive(activeId)) return;

  const ws = root.workspaces.find((w) => w.id === activeId);
  if (!ws) return;

  // No saved tabs: just adopt whatever is already in the window as this
  // workspace's live session and mark it live so autosave persists it.
  if (!ws.sessionTabs.length) {
    await claimAllWindowTabs(activeId);
    await markWorkspaceLive(activeId);
    scheduleAutosave();
    return;
  }

  // Open the saved tabs (reusing any already open) and assign them to this
  // workspace, then mark it live.
  await beginSuspend();
  try {
    await openWorkspaceTabs(ws.sessionTabs, activeId, { newWindow: false });
    await markWorkspaceLive(activeId);
    if (startup) {
      // Startup: window should reflect only the restored workspace. Browsers
      // restore their own tabs (a blank New Tab, "continue where you left off")
      // asynchronously, so a stray unowned tab can appear after this first pass.
      // Run one immediate cleanup, then a second one shortly after to sweep any
      // late-arriving unowned tabs, so none is left leading the row.
      await closeUnownedTabs();
      delay(1200).then(() => closeUnownedTabs().catch(() => {}));
    } else {
      // Manual open: only drop a leftover blank placeholder so we don't append
      // a phantom New Tab on the next autosave.
      await closeUnownedBlankTabs();
    }
  } finally {
    await endSuspend();
  }
  await broadcastState();
}

// Close every non-hub tab in the window that no workspace owns. Keeps the
// window alive if these would be the last tabs. Used on startup so the browser
// restores exactly the last-used workspace and nothing else.
async function closeUnownedTabs() {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const owners = await getTabOwners();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ids = tabs
    .filter((t) => t.id !== hubId && owners[t.id] == null)
    .map((t) => t.id);
  if (!ids.length) return 0;
  await ensureWindowSurvives(ids);
  await chrome.tabs.remove(ids);
  return ids.length;
}

// Close blank/new-tab pages in the window that no workspace owns. Never closes
// the hub. Keeps the window alive if these would be the last tabs.
async function closeUnownedBlankTabs() {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const owners = await getTabOwners();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ids = tabs
    .filter((t) => t.id !== hubId && owners[t.id] == null && isBlankTabUrl(t.url))
    .map((t) => t.id);
  if (!ids.length) return 0;
  await ensureWindowSurvives(ids);
  await chrome.tabs.remove(ids);
  return ids.length;
}

// Resolve the current hub tab, tolerating a stale stored id.
async function findHubTab() {
  const storedId = await getSession(SESSION_KEYS.hubTabId);
  if (storedId != null) {
    try {
      const tab = await chrome.tabs.get(storedId);
      if (tab && tab.url && tab.url.startsWith(HUB_URL)) return tab;
    } catch (_e) {
      // fall through to a query
    }
  }
  // Query for any tab already showing the hub (handles worker restarts).
  const matches = await chrome.tabs.query({ url: `${HUB_URL}*` });
  if (matches.length) {
    await setSession(SESSION_KEYS.hubTabId, matches[0].id);
    return matches[0];
  }
  return null;
}

async function isHubTabId(tabId) {
  const storedId = await getSession(SESSION_KEYS.hubTabId);
  return storedId != null && tabId === storedId;
}

// --- Tab ownership (which browser tab belongs to which workspace) ------------
//
// The window is a shared surface, but each browser tab belongs to exactly one
// workspace. This map is what makes workspaces independent: autosave only reads
// the active workspace's own tabs, and switching only closes those tabs.
// Tab IDs are session-scoped, so the map lives in chrome.storage.session.

async function getTabOwners() {
  const owners = await getSession(SESSION_KEYS.tabOwners);
  return owners && typeof owners === "object" ? owners : {};
}

async function setTabOwners(owners) {
  await setSession(SESSION_KEYS.tabOwners, owners);
}

// The owner map is mutated both by serialized window operations AND by tab
// event handlers (onCreated/onRemoved) that fire outside the serializer. A
// plain get-modify-set would race between those two sources and lose entries.
// updateTabOwners runs each read-modify-write on one chain so they can't clash.
let ownersChain = Promise.resolve();
function updateTabOwners(mutator) {
  const run = ownersChain.then(async () => {
    const owners = await getTabOwners();
    const changed = mutator(owners);
    if (changed !== false) await setTabOwners(owners);
    return owners;
  });
  ownersChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- Pending-navigation URL map ----------------------------------------------
//
// A tab we just opened for a real url reports about:blank/newtab until its
// navigation commits. This map remembers the url we intend a tab to hold so a
// snapshot taken mid-navigation records the real url instead of a blank New Tab.
// Entries are cleared once the tab actually reports the intended url (or a
// different non-blank url), and on tab close.

let pendingUrlsChain = Promise.resolve();

async function getPendingUrls() {
  const map = await getSession(SESSION_KEYS.pendingUrls);
  return map && typeof map === "object" ? map : {};
}

function updatePendingUrls(mutator) {
  const run = pendingUrlsChain.then(async () => {
    const map = await getPendingUrls();
    const changed = mutator(map);
    if (changed !== false) await setSession(SESSION_KEYS.pendingUrls, map);
    return map;
  });
  pendingUrlsChain = run.then(() => undefined, () => undefined);
  return run;
}

async function setPendingUrl(tabId, url) {
  if (tabId == null || !url || isBlankTabUrl(url)) return;
  await updatePendingUrls((map) => { map[tabId] = url; });
}

async function clearPendingUrl(tabId) {
  await updatePendingUrls((map) => {
    if (!(tabId in map)) return false;
    delete map[tabId];
  });
}

// The url a tab should be treated as holding: its live url if that's already a
// real (non-blank) url, otherwise any pending intended url we recorded for it.
function effectiveUrl(tab, pending) {
  if (tab && !isBlankTabUrl(tab.url)) return tab.url;
  const intended = pending ? pending[tab.id] : null;
  return intended || tab.url;
}

// --- "Live" workspaces (materialized into the window this session) -----------
//
// A workspace is "live" once its saved tabs have actually been opened into the
// current browser window (by switching to it, restoring it, or saving into it).
// Autosave only overwrites the saved session of a live workspace. Before a
// workspace is live, its stored sessionTabs are authoritative and untouchable,
// so opening the hub on a blank New Tab can never erase a saved workspace.

async function getLiveWorkspaces() {
  const list = await getSession(SESSION_KEYS.liveWorkspaces);
  return Array.isArray(list) ? list : [];
}

async function isWorkspaceLive(workspaceId) {
  if (!workspaceId) return false;
  const list = await getLiveWorkspaces();
  return list.includes(workspaceId);
}

async function markWorkspaceLive(workspaceId) {
  if (!workspaceId) return;
  const list = await getLiveWorkspaces();
  if (list.includes(workspaceId)) return;
  list.push(workspaceId);
  await setSession(SESSION_KEYS.liveWorkspaces, list);
}

// Assign a browser tab to a workspace.
async function assignTab(tabId, workspaceId) {
  if (tabId == null || !workspaceId) return;
  await updateTabOwners((owners) => {
    if (owners[tabId] === workspaceId) return false; // no change
    owners[tabId] = workspaceId;
  });
}

// Forget a browser tab (on close).
async function unassignTab(tabId) {
  await updateTabOwners((owners) => {
    if (!(tabId in owners)) return false; // no change
    delete owners[tabId];
  });
}

// Browser tab IDs currently owned by a workspace, in window order.
async function ownedTabIds(workspaceId) {
  const owners = await getTabOwners();
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((t) => t.id !== hubId && owners[t.id] === workspaceId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);
}

// Any tab in the window that we have not yet assigned to a workspace. Newly
// created tabs (including blank New Tabs) start unowned and are claimed by the
// active workspace on the next tab event.
async function claimUnownedTabsForActive() {
  const root = await store.getRoot();
  const activeId = root.activeWorkspaceId;
  if (!activeId) return;
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await updateTabOwners((owners) => {
    let changed = false;
    for (const t of tabs) {
      if (t.id === hubId) continue;
      if (owners[t.id] == null) {
        owners[t.id] = activeId;
        changed = true;
      }
    }
    return changed;
  });
}

// --- Live open-tab tracking --------------------------------------------------

let autosaveTimer = null;

// Debounced autosave of the active workspace's live browser tabs. Mirrors
// Workona's "tabs are constantly autosaved" behavior.
function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    autosaveActiveSession().catch(() => {});
  }, 600);
}

// Cancel any pending debounced autosave. Called at the start of switch/restore/
// materialize so a save queued for the outgoing workspace can't fire mid-switch.
// Even if one slips through, the storage write is serialized and guarded by
// expectedWorkspaceId, so this is defense-in-depth, not the sole protection.
function cancelAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

// Enter/leave a "programmatic tab surgery" section. While suspended, tab events
// don't autosave and pending autosaves are cancelled. Returns/restores cleanly
// even if the body throws, so tracking is never left stuck off.
async function beginSuspend() {
  cancelAutosave();
  await setSession(SESSION_KEYS.suspendTracking, true);
}
async function endSuspend() {
  await setSession(SESSION_KEYS.suspendTracking, false);
}

// --- Window-operation serializer ---------------------------------------------
//
// switchWorkspace / restoreWorkspace / materialize / saveCurrentSession all
// perform multi-step surgery on the SHARED browser window and the SHARED tab-
// ownership map (open some tabs, close others, reassign owners). If two of them
// run concurrently — which is exactly what happens when you spam the workspace
// list — they interleave: one closes tabs the other just opened, ownership gets
// crossed (tabs "merge" into the wrong workspace), and operating on a tab id a
// sibling already closed throws. Funnelling every such operation through one
// promise chain makes them run strictly one-at-a-time, so the window is only
// ever mutated by a single operation.

let opChain = Promise.resolve();

function runExclusive(task) {
  const run = opChain.then(task, task);
  opChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- Switch coalescing -------------------------------------------------------
//
// Spamming switches should not replay every intermediate hop (open/close churn,
// and pointless work). We remember the LATEST requested target; when a switch
// finishes, if the desired target has since changed, we run exactly one more
// switch to the newest target. Rapid A->B->C->D collapses to "end up at D".

let desiredWorkspaceId = null;
let switchRunning = false;

async function requestSwitch(targetId, sender) {
  desiredWorkspaceId = targetId;
  // If a switch is already draining toward the latest target, just update the
  // target above and let the running loop pick it up.
  if (switchRunning) {
    const root = await store.getRoot();
    return { ok: true, root, opened: 0, reused: 0, coalesced: true };
  }

  switchRunning = true;
  let last = { ok: true };
  let didWork = false;
  try {
    // Drain: keep switching until the window matches the most recent request.
    while (true) {
      const root = await store.getRoot();
      const target = desiredWorkspaceId;
      if (!target || root.activeWorkspaceId === target) break;
      last = await runExclusive(() => switchWorkspaceExclusive(target, sender));
      didWork = true;
      if (!last.ok) break;
    }
  } finally {
    switchRunning = false;
  }

  // Always converge the hub on the final drained state. During coalescing,
  // intermediate callers returned early with a stale root and per-hop broadcasts
  // are suppressed for the hub sender, so without this the hub could be left
  // showing an intermediate workspace. Broadcasting the final state (with fresh
  // open-tab indicators) guarantees the UI matches the window.
  if (didWork) {
    const finalRoot = await store.getRoot();
    if (last && last.ok) last = { ...last, root: finalRoot };
    await broadcastState();
  }
  return last;
}

// Run any other window-mutating operation (save / restore) so it can never
// interleave with switching. We first let any in-flight switch drain to its
// final target (bounded), then run the task on the exclusive chain. This keeps
// a save/restore from landing between two switch hops.
async function runWindowOp(task) {
  await waitForSwitchDrain();
  return runExclusive(task);
}

async function waitForSwitchDrain(maxWaitMs = 10000, stepMs = 40) {
  const deadline = Date.now() + maxWaitMs;
  while (switchRunning && Date.now() < deadline) {
    await delay(stepMs);
  }
}

async function trackingSuspended() {
  return Boolean(await getSession(SESSION_KEYS.suspendTracking));
}

async function autosaveActiveSession() {
  if (await trackingSuspended()) return;
  const root = await store.getRoot();
  const activeId = root.activeWorkspaceId;
  if (!activeId) return;

  // Only autosave a workspace that has been materialized into this window. A
  // workspace with saved tabs that hasn't been opened yet this session must be
  // left alone, otherwise a stray blank New Tab would overwrite its real tabs.
  if (!(await isWorkspaceLive(activeId))) return;

  // New tabs (including blank ones) are claimed by the active workspace, then
  // we snapshot ONLY that workspace's tabs — never the whole window. This is
  // what keeps workspaces from merging.
  await claimUnownedTabsForActive();
  const liveTabs = await readOwnedTabs(activeId);

  // Re-check suspension right before writing: a switch may have begun after we
  // read the tabs. The storage write is also serialized and verifies the active
  // workspace still matches `activeId` (expectedWorkspaceId), so a snapshot for
  // the old workspace can never be written onto the new one.
  if (await trackingSuspended()) return;
  const result = await store.replaceActiveSessionTabs(liveTabs, {
    preserveNonEmpty: true,
    expectedWorkspaceId: activeId
  });
  if (result.changed) await broadcastState();
}

// Read the savable tabs the given workspace owns, in window order.
async function readOwnedTabs(workspaceId) {
  const owners = await getTabOwners();
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const pending = await getPendingUrls();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((t) => t.id !== hubId && owners[t.id] === workspaceId)
    .sort((a, b) => a.index - b.index)
    .map((t) => withEffectiveUrl(t, pending))
    .filter((t) => isSavableUrl(t.url))
    .map(tabToRecord);
}

// Read every savable tab in the current window (regardless of ownership). Used
// only for the explicit "Save open tabs" action.
async function readWindowTabs() {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const pending = await getPendingUrls();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((t) => t.id !== hubId)
    .sort((a, b) => a.index - b.index)
    .map((t) => withEffectiveUrl(t, pending))
    .filter((t) => isSavableUrl(t.url))
    .map(tabToRecord);
}

// Return a shallow copy of the tab whose url is the effective url (the intended
// pending url while it is still navigating), so snapshots never record a real
// tab as a blank New Tab just because its navigation has not committed yet.
function withEffectiveUrl(tab, pending) {
  const url = effectiveUrl(tab, pending);
  if (url === tab.url) return tab;
  return { ...tab, url, title: tab.title && !isBlankTabUrl(tab.url) ? tab.title : url };
}

// Register tab listeners once. These keep the live session in sync without
// polling. Events on the hub tab itself are ignored.
chrome.tabs.onCreated.addListener((tab) => {
  onTabEvent(tab.id);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Once a tab commits a real (non-blank) url, its intended-url placeholder is
  // no longer needed — the live url is now authoritative.
  if (changeInfo.url && !isBlankTabUrl(changeInfo.url)) {
    clearPendingUrl(tabId).catch(() => {});
  }
  if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl || changeInfo.pinned != null) {
    onTabEvent(tabId);
  }
});
chrome.tabs.onMoved.addListener((tabId) => onTabEvent(tabId));

async function onTabEvent(tabId) {
  if (await isHubTabId(tabId)) return;
  await claimTabForActive(tabId);
  scheduleAutosave();
}

// Claim a single tab for the active workspace if it is not already owned. Only
// claims once the active workspace is live (materialized this session), so tabs
// opened before materialization stay unowned and don't get attached to a
// workspace whose saved session hasn't been brought into the window yet.
async function claimTabForActive(tabId) {
  if (tabId == null || await isHubTabId(tabId)) return;
  if (await trackingSuspended()) return; // switch/restore assigns ownership itself
  const owners = await getTabOwners();
  if (owners[tabId] != null) return;
  const root = await store.getRoot();
  const activeId = root.activeWorkspaceId;
  if (activeId && await isWorkspaceLive(activeId)) await assignTab(tabId, activeId);
}

async function handleTabRemoved(tabId) {
  if (await isHubTabId(tabId)) {
    // Hub was closed: forget its id so the next open creates a fresh one.
    await setSession(SESSION_KEYS.hubTabId, null);
    return;
  }
  await unassignTab(tabId);
  await clearPendingUrl(tabId);
  scheduleAutosave();
}

// --- Save / restore / switch -------------------------------------------------

// Create a brand-new workspace and switch the browser window to it. Creating a
// workspace makes it active, so the window must reflect it: the outgoing
// workspace's tabs are persisted (if it was materialized this session) and then
// closed, and the new — empty — workspace becomes live with a single fresh blank
// tab. Runs exclusively (via runWindowOp) so this window surgery can't race a
// switch/save/restore. Mirrors switchWorkspaceExclusive's "switch to an empty
// workspace" path, but for a freshly created target.
async function createWorkspaceAndSwitch(message, sender) {
  // Capture the outgoing workspace BEFORE creating, because createWorkspace sets
  // the new workspace active — after that the old id is no longer the active one.
  const before = await store.getRoot();
  const outgoingId = before.activeWorkspaceId;

  const created = await store.createWorkspace(message.name);
  const newId = created.workspace.id;

  await beginSuspend();
  try {
    // Persist + close the outgoing workspace's own tabs so the window is cleared
    // for the new workspace. A new workspace has no saved tabs, so we always keep
    // the window alive (leaving one blank placeholder if these were the last tabs).
    if (outgoingId && outgoingId !== newId) {
      if (await isWorkspaceLive(outgoingId)) {
        await claimUnownedTabsForActive(); // adopt any strays before saving
        const outgoingTabs = await readOwnedTabs(outgoingId);
        await store.replaceSessionTabs(outgoingId, outgoingTabs);
        await store.flushPendingSync().catch(() => {});
        await closeOwnedTabs(outgoingId, { keepWindowAlive: true });
      } else {
        // Outgoing was never materialized this session: its saved state must not
        // be touched, so just clear the window's stray tabs.
        await closeAllNonHubTabs({ keepWindowAlive: true });
      }
    } else {
      // No outgoing workspace (first ever): clear any stray tabs so the new
      // workspace starts clean, keeping the window alive.
      await closeAllNonHubTabs({ keepWindowAlive: true });
    }

    // The new workspace is now materialized in the window (its blank placeholder
    // tab), so mark it live and let autosave adopt that tab as its first tab.
    await markWorkspaceLive(newId);
    await claimUnownedTabsForActive();

    await maybeBroadcast(sender);
    const root = await store.getRoot();
    return { ok: true, root, workspaceId: newId };
  } finally {
    await endSuspend();
  }
}

// Snapshot the current window into a workspace's live session. If a workspace
// is given, we save only the tabs it owns (isolation); when creating a brand
// new workspace from the current window, we adopt the whole window and claim
// those tabs for the new workspace.
async function saveCurrentSession(message, sender) {
  let workspaceId = message.workspaceId;
  let root = await store.getRoot();
  let liveTabs;

  if (!workspaceId) {
    // First-time capture: the whole window becomes the new workspace.
    liveTabs = await readWindowTabs();
    if (!liveTabs.length) return { ok: false, error: "No savable tabs in this window." };
    const created = await store.createWorkspace(message.workspaceName || defaultSessionName());
    root = created.root;
    workspaceId = created.workspace.id;
    await store.setActiveWorkspace(workspaceId);
    await claimAllWindowTabs(workspaceId);
    await markWorkspaceLive(workspaceId);
  } else {
    // Saving into an existing workspace captures only what that workspace owns,
    // plus any currently unowned tabs in the window (freshly opened here).
    // Saving into an existing workspace materializes it: the window's current
    // (and previously unowned) tabs now belong to it, so it becomes live and
    // autosave will keep tracking it from here on.
    await markWorkspaceLive(workspaceId);
    await claimUnownedTabsForActive();
    liveTabs = await readOwnedTabs(workspaceId);
    if (!liveTabs.length) return { ok: false, error: "This workspace has no open tabs to save." };
  }

  const replaced = await store.replaceSessionTabs(workspaceId, liveTabs);
  root = replaced.root;

  if (message.asGroup) {
    const g = await store.createGroup(workspaceId, message.groupName || defaultSessionName());
    root = (await store.addTabs(workspaceId, g.group.id, liveTabs)).root;
  }

  await maybeBroadcast(sender);
  return { ok: true, root, saved: liveTabs.length, workspaceId };
}

// Open all of a workspace's saved tabs in the current window (without closing
// anything). Used by the "Open all tabs" / new-window actions.
async function restoreWorkspace(message, sender) {
  const root = await store.getRoot();
  const ws = root.workspaces.find((w) => w.id === message.workspaceId);
  if (!ws) return { ok: false, error: "Workspace not found." };
  if (!ws.sessionTabs.length) return { ok: false, error: "This workspace has no saved tabs." };

  await beginSuspend();
  try {
    const opened = await openWorkspaceTabs(ws.sessionTabs, ws.id, { newWindow: message.newWindow === true });
    const activated = await store.setActiveWorkspace(ws.id);
    await markWorkspaceLive(ws.id); // its tabs are now in a window; autosave may track it
    await maybeBroadcast(sender);
    return { ok: true, root: activated.root, opened: opened.opened, reused: opened.reused };
  } finally {
    await endSuspend();
  }
}

// Perform ONE switch, non-destructively. This is the exclusive worker invoked
// only through runExclusive() (see requestSwitch), so it is guaranteed to be
// the sole operation mutating the window at a time:
//   1. Persist the outgoing workspace's own tabs (never overwriting its saved
//      tabs with an empty snapshot).
//   2. Only after that save is durably committed, close the outgoing tabs.
//   3. Open the target's saved tabs as freshly owned tabs, in saved order.
// Tracking is suspended for the duration so our own open/close churn can't race
// autosave, and every browser-tabs call is fault-tolerant so a tab that a
// previous (already-drained) operation removed can never throw here.
async function switchWorkspaceExclusive(targetId, sender) {
  const root = await store.getRoot();
  const target = root.workspaces.find((w) => w.id === targetId);
  if (!target) return { ok: false, error: "Workspace not found." };
  if (root.activeWorkspaceId === targetId) {
    return { ok: true, root, opened: 0, reused: 0 };
  }

  await beginSuspend();
  try {
    const outgoingId = root.activeWorkspaceId;
    const targetHasTabs = target.sessionTabs.length > 0;

    // 1 + 2. Persist the outgoing workspace, THEN close its tabs. We capture the
    // outgoing session only if that workspace was materialized this session;
    // otherwise the window holds tabs that don't belong to it and we must not
    // touch its saved state. The save uses the default empty-guard, so if
    // ownership was transiently lost (empty snapshot) the workspace's saved tabs
    // are preserved rather than wiped — then we still close whatever is owned.
    if (outgoingId && outgoingId !== targetId) {
      if (await isWorkspaceLive(outgoingId)) {
        await claimUnownedTabsForActive(); // adopt any strays before saving
        const outgoingTabs = await readOwnedTabs(outgoingId);
        // Persist first and wait for it to complete before closing anything, so
        // a crash between save and close can never drop the outgoing tabs.
        await store.replaceSessionTabs(outgoingId, outgoingTabs);
        await store.flushPendingSync().catch(() => {});
        await closeOwnedTabs(outgoingId, { keepWindowAlive: !targetHasTabs });
      } else {
        // Outgoing was never opened this session: clear its stray tabs from the
        // window without saving them into it (its saved state stays untouched).
        await closeAllNonHubTabs({ keepWindowAlive: !targetHasTabs });
      }
    }

    // 3. Make the target active, then open its saved tabs as target-owned tabs.
    const activated = await store.setActiveWorkspace(targetId);
    const opened = targetHasTabs
      ? await openWorkspaceTabs(target.sessionTabs, targetId, { newWindow: false })
      : { opened: 0, reused: 0 };
    await markWorkspaceLive(targetId); // now materialized in the window

    await maybeBroadcast(sender);
    return { ok: true, root: activated.root, opened: opened.opened, reused: opened.reused };
  } finally {
    await endSuspend();
  }
}

// Close every browser tab currently owned by a workspace (never the hub). When
// keepWindowAlive is set and these are the last tabs, open one placeholder so
// the window/hub survives (used only when switching to an empty workspace).
async function closeOwnedTabs(workspaceId, { keepWindowAlive = false } = {}) {
  const ids = await ownedTabIds(workspaceId);
  if (!ids.length) return 0;
  if (keepWindowAlive) await ensureWindowSurvives(ids);
  await safeTabRemove(ids);
  // Always drop ownership for these ids regardless of whether the tab still
  // existed, so the owner map can't leak stale entries.
  await updateTabOwners((owners) => { for (const id of ids) delete owners[id]; });
  return ids.length;
}

// Close every non-hub tab in the current window and forget their ownership.
// Used when switching away from a workspace that was never materialized this
// session (so the window's tabs don't belong to it and must not be saved).
async function closeAllNonHubTabs({ keepWindowAlive = false } = {}) {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const ids = tabs.filter((t) => t.id !== hubId).map((t) => t.id);
  if (!ids.length) return 0;
  if (keepWindowAlive) await ensureWindowSurvives(ids);
  await safeTabRemove(ids);
  await updateTabOwners((owners) => { for (const id of ids) delete owners[id]; });
  return ids.length;
}

// If closing `ids` would leave only the hub tab, open one placeholder blank tab
// first so the window does not close. The placeholder is unowned and becomes
// the empty workspace's first New Tab.
async function ensureWindowSurvives(idsToClose) {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const all = await chrome.tabs.query({ currentWindow: true });
  const remaining = all.filter((t) => t.id !== hubId && !idsToClose.includes(t.id));
  if (remaining.length === 0) {
    await safeTabCreate({ active: false });
  }
}

// Open a workspace's saved tab records as browser tabs and assign ownership to
// that workspace. Reuses an already-open tab with the same URL when possible.
async function openWorkspaceTabs(records, workspaceId, { newWindow }) {
  const list = records.slice(0, RESTORE_LIMIT);
  if (!list.length) return { opened: 0, reused: 0 };

  if (newWindow) {
    const first = list[0];
    const win = await chrome.windows.create({ url: openableUrl(first.url), focused: true });
    // The window's initial tab is the first record.
    let opened = 1;
    for (const rec of list.slice(1)) {
      const created = await safeTabCreate({ windowId: win.id, url: openableUrl(rec.url), active: false });
      if (created) opened += 1;
    }
    return { opened, reused: 0 };
  }

  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const existing = (await chrome.tabs.query({ currentWindow: true })).filter((t) => t.id !== hubId);
  const currentOwners = await getTabOwners();

  // Index reusable open tabs by URL (only tabs not owned by another workspace).
  const reusableByUrl = new Map();
  for (const t of existing) {
    const key = isBlankTabUrl(t.url) ? NEW_TAB_URL : t.url;
    if (!reusableByUrl.has(key)) reusableByUrl.set(key, []);
    reusableByUrl.get(key).push(t);
  }

  let opened = 0;
  let reused = 0;
  // Collect the resulting browser tab ids in the SAVED order so we can enforce
  // that exact order in the window afterwards, plus the ownership assignments to
  // apply atomically at the end. `pending` records the intended real url for
  // tabs we just created so a snapshot taken before they finish loading records
  // the real url, not a blank New Tab.
  const orderedTabIds = [];
  const assignments = [];
  const pending = []; // [{ id, url }]
  for (const rec of list) {
    const key = isBlankTabUrl(rec.url) ? NEW_TAB_URL : rec.url;
    const pool = reusableByUrl.get(key);
    const match = pool && pool.shift();
    if (match) {
      assignments.push(match.id);
      orderedTabIds.push(match.id);
      reused += 1;
    } else {
      const created = await safeTabCreate({ url: openableUrl(rec.url), active: false });
      if (created) {
        assignments.push(created.id);
        orderedTabIds.push(created.id);
        if (!isBlankTabUrl(rec.url)) pending.push({ id: created.id, url: rec.url });
        opened += 1;
      }
    }
  }
  // Apply ownership under the owner lock so a concurrent onRemoved can't clobber
  // it. void currentOwners: kept only to preserve prior reuse semantics.
  void currentOwners;
  await updateTabOwners((owners) => {
    for (const id of assignments) owners[id] = workspaceId;
  });
  // Record intended urls for freshly-created, still-navigating tabs.
  if (pending.length) {
    await updatePendingUrls((map) => { for (const p of pending) map[p.id] = p.url; });
  }

  // Enforce the saved order AND anchor the workspace's tabs to the FRONT of the
  // window (right after the pinned hub). Reused tabs keep whatever position the
  // browser restored them to and new tabs are appended, so without this the
  // order would not match the saved order. Anchoring to the front — rather than
  // the end — matters on browser startup: the browser may restore its own blank
  // "New Tab" (or "continue where you left off" tabs) that we do not own and
  // that settle asynchronously. Appending workspace tabs to the end would leave
  // such a stray tab sitting at index 0, first in the row. Placing the
  // workspace's tabs first guarantees they lead regardless of any stray tab.
  await reorderTabsInWindow(orderedTabIds);

  return { opened, reused };
}

// Order the given tabs left-to-right to match `tabIds`, anchored to the front
// of the window immediately after the pinned hub tab. Pinned tabs always sort
// before unpinned ones, so we place the first tab at the lowest unpinned index
// and lay the rest out sequentially after it. Explicit leading indices (rather
// than "move to end") keep the workspace's tabs first even when the browser has
// left an unowned tab at the front.
async function reorderTabsInWindow(tabIds) {
  if (!tabIds || !tabIds.length) return;
  // Count pinned tabs (e.g. the hub) so we insert right after them; the tabs API
  // rejects moving an unpinned tab to an index occupied by pinned tabs.
  let base = 0;
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    base = tabs.filter((t) => t.pinned).length;
  } catch (_e) {
    base = 0;
  }
  let index = base;
  for (const id of tabIds) {
    await safeTabMove(id, { index });
    index += 1;
  }
}

// --- Fault-tolerant browser-tabs wrappers ------------------------------------
//
// Tab ids can become invalid at any moment (the user closes a tab, or an event
// races our operation). The tabs API rejects the WHOLE call if any id is stale
// — and chrome.tabs.remove([...]) rejects the entire batch if one id is gone.
// These wrappers swallow "no tab with id"-style errors so one vanished tab can
// never abort an operation (which is what was crashing rapid switches).

async function safeTabRemove(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
  let removed = 0;
  // Remove one at a time so a single stale id can't fail the rest.
  for (const id of list) {
    try {
      await chrome.tabs.remove(id);
      removed += 1;
    } catch (_e) {
      // Already closed; ignore.
    }
  }
  return removed;
}

async function safeTabMove(id, moveProps) {
  try {
    await chrome.tabs.move(id, moveProps);
    return true;
  } catch (_e) {
    return false;
  }
}

async function safeTabCreate(props) {
  try {
    return await chrome.tabs.create(props);
  } catch (_e) {
    return null;
  }
}

// A saved record's URL as something chrome.tabs.create can open. Blank/new-tab
// records open a real new tab (no explicit URL).
function openableUrl(url) {
  return isBlankTabUrl(url) ? undefined : url;
}

// Claim every non-hub tab in the current window for a workspace.
async function claimAllWindowTabs(workspaceId) {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const tabs = await chrome.tabs.query({ currentWindow: true });
  await updateTabOwners((owners) => {
    for (const t of tabs) {
      if (t.id === hubId) continue;
      owners[t.id] = workspaceId;
    }
  });
}

// Open a single saved tab, focusing it if it's already open. The opened/focused
// tab is assigned to the active workspace so it counts as that space's tab.
async function openSingleTab(url) {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const root = await store.getRoot();
  const activeId = root.activeWorkspaceId;

  // Blank/new-tab records can't be matched by URL query; always open fresh.
  if (!isBlankTabUrl(url)) {
    const matches = await chrome.tabs.query({ url });
    const match = matches.find((t) => t.id !== hubId);
    if (match) {
      await chrome.tabs.update(match.id, { active: true });
      if (match.windowId != null) await chrome.windows.update(match.windowId, { focused: true });
      if (activeId) await assignTab(match.id, activeId);
      return { ok: true, reused: true };
    }
  }

  const created = await chrome.tabs.create({ url: openableUrl(url), active: true });
  if (activeId) await assignTab(created.id, activeId);
  return { ok: true, reused: false };
}

// Close the real browser tab(s) for a given URL in the current window.
async function closeOpenTab(url) {
  const hubId = await getSession(SESSION_KEYS.hubTabId);
  const matches = await chrome.tabs.query({ currentWindow: true, url });
  const ids = matches.filter((t) => t.id !== hubId).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  return { ok: true, closed: ids.length };
}

// --- Messaging ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false, error: "Unknown request." };

  switch (message.type) {
    case "getState": {
      const root = await store.getRoot();
      // "Open" indicators reflect the active workspace's own live tabs only.
      const liveTabs = root.activeWorkspaceId ? await readOwnedTabs(root.activeWorkspaceId) : [];
      const openUrls = [...new Set(liveTabs.map((tab) => tab.url))];
      return { ok: true, root, openUrls };
    }
    case "getOpenTabs": {
      return { ok: true, openTabs: await readWindowTabs() };
    }

    // Workspaces
    case "createWorkspace":
      // Creating a workspace makes it the active one, so the browser window must
      // switch to it: persist + close the outgoing workspace's tabs and give the
      // new (empty) workspace a fresh window. Serialized against switches/saves so
      // it can't interleave with other window surgery.
      return runWindowOp(() => createWorkspaceAndSwitch(message, sender));
    case "renameWorkspace": {
      const { root } = await store.renameWorkspace(message.workspaceId, message.name);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "setWorkspaceColor": {
      const { root } = await store.setWorkspaceColor(message.workspaceId, message.color);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "deleteWorkspace": {
      const { root } = await store.deleteWorkspace(message.workspaceId);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "setActiveWorkspace": {
      const { root } = await store.setActiveWorkspace(message.workspaceId);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "reorderWorkspaces": {
      const { root } = await store.reorderWorkspaces(message.orderedIds || []);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "switchWorkspace":
      // Coalesced + serialized: rapid spamming collapses to the final target and
      // never runs two switches against the window at once.
      return requestSwitch(message.workspaceId, sender);

    // Export / import (portable backup across browsers)
    case "exportData": {
      const data = await store.exportData();
      return { ok: true, data };
    }
    case "importData": {
      const { root, imported } = await store.importData(message.payload, message.mode || "merge");
      await maybeBroadcast(sender);
      return { ok: true, root, imported };
    }

    // Groups
    case "createGroup": {
      const { root, group } = await store.createGroup(message.workspaceId, message.name);
      await maybeBroadcast(sender);
      return { ok: true, root, groupId: group.id };
    }
    case "renameGroup": {
      const { root } = await store.renameGroup(message.workspaceId, message.groupId, message.name);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "deleteGroup": {
      const { root } = await store.deleteGroup(message.workspaceId, message.groupId);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }

    // Tabs
    case "addTabs": {
      const { root, added } = await store.addTabs(
        message.workspaceId,
        message.containerId,
        message.tabs || []
      );
      await maybeBroadcast(sender);
      return { ok: true, root, added };
    }
    case "renameTab": {
      const { root } = await store.renameTab(
        message.workspaceId,
        message.containerId,
        message.tabId,
        message.title
      );
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "removeTab": {
      const { root } = await store.removeTab(
        message.workspaceId,
        message.containerId,
        message.tabId
      );
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "reorderTabs": {
      const { root } = await store.reorderTabs(
        message.workspaceId,
        message.containerId,
        message.orderedIds || []
      );
      await maybeBroadcast(sender);
      return { ok: true, root };
    }
    case "moveTab": {
      const { root } = await store.moveTab(message);
      await maybeBroadcast(sender);
      return { ok: true, root };
    }

    // Session capture / restore. Serialized against switches and each other so
    // they can never mutate the window concurrently.
    case "saveCurrentSession":
      return runWindowOp(() => saveCurrentSession(message, sender));
    case "restoreWorkspace":
      return runWindowOp(() => restoreWorkspace(message, sender));

    // Browser tab actions
    case "openTab":
      return openSingleTab(message.url);
    case "closeOpenTab":
      return closeOpenTab(message.url);
    case "openHub": {
      const tab = await openHub();
      return { ok: true, hubTabId: tab.id };
    }

    // Search
    case "search": {
      const root = await store.getRoot();
      return { ok: true, results: store.searchRoot(root, message.query), root };
    }

    default:
      return { ok: false, error: `Unsupported request: ${message.type}` };
  }
}

// Hub-initiated mutations already return authoritative state to the singleton
// hub, so broadcasting the same full tree would cause a second transfer/render.
// Other senders still receive the broadcast behavior.
async function maybeBroadcast(sender) {
  if (sender && typeof sender.url === "string" && sender.url.startsWith(HUB_URL)) return;
  await broadcastState();
}

// Notify any open hub page that state changed so it can re-render. The hub
// listens for this and pulls fresh state. Errors (no receiver) are ignored.
async function broadcastState() {
  try {
    await chrome.runtime.sendMessage({ type: "stateChanged" });
  } catch (_e) {
    // No hub listening; safe to ignore.
  }
}

// --- Helpers -----------------------------------------------------------------

// A tab is savable if it is web content OR a blank/new tab. Internal browser
// pages other than the new-tab page (settings, extensions, devtools, etc.) are
// still excluded because they cannot be reliably reopened.
function isSavableUrl(url) {
  if (isBlankTabUrl(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_e) {
    return false;
  }
}

function isBlankTabUrl(url) {
  if (!url) return true; // brand-new tab often reports an empty URL
  return url === "about:blank"
    || url === "about:newtab"
    || url === "chrome://newtab/"
    || url === "edge://newtab/"
    || url.startsWith("chrome://newtab")
    || url.startsWith("edge://newtab");
}

// Convert a live browser tab into a persistable record. Blank tabs are stored
// with a canonical new-tab URL so they survive switching and restarts.
function tabToRecord(t) {
  const blank = isBlankTabUrl(t.url);
  return {
    url: blank ? NEW_TAB_URL : t.url,
    title: blank ? "New Tab" : (t.title || t.url),
    favIconUrl: blank ? "" : (t.favIconUrl || ""),
    pinned: Boolean(t.pinned)
  };
}

function defaultSessionName() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Session ${date} ${time}`;
}
