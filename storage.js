// storage.js
// Pure data layer for the Tab Workspaces extension.
// Owns the persisted shape and all read/write access to chrome.storage.local.
// No UI, no tabs-API, no messaging concerns live here.
//
// Data model (single root object under STORAGE_KEY):
//
//   {
//     version: 2,
//     activeWorkspaceId: string | null,
//     workspaces: [
//       {
//         id, name, color, createdAt, updatedAt,
//         // "sessionTabs": the live tab set for this space. These are the
//         // tabs that autosave/restore when you switch or close the space
//         // (Workona: "a space is a saved browser window").
//         sessionTabs: [ Tab ],
//         // "groups": saved/organized tab groups (Workona sections/resources).
//         // These persist regardless of the live session.
//         groups: [ { id, name, createdAt, tabs: [ Tab ] } ]
//       }
//     ]
//   }
//
//   Tab = { id, url, title, favIconUrl, pinned, addedAt }
//
// Every tab record lives in exactly one array (one workspace's sessionTabs,
// or one group's tabs). Nothing is copied across the tree, so thousands of
// tabs cost one record each. The tree lives under a single key, so loading a
// workspace is one read and each mutation writes once.

const STORAGE_KEY = "tabWorkspaces.v2";
const LEGACY_KEY = "tabWorkspaces.v1";
const SCHEMA_VERSION = 2;
const DEFAULT_GROUP_NAME = "Saved";

const WORKSPACE_COLORS = [
  "#246bfe", "#12a150", "#c2410c", "#7c3aed",
  "#0891b2", "#be185d", "#ca8a04", "#4b5563"
];

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanName(value, fallback) {
  const name = String(value == null ? "" : value).trim();
  return name || fallback;
}

function emptyRoot() {
  return {
    version: SCHEMA_VERSION,
    activeWorkspaceId: null,
    workspaces: []
  };
}

// --- Normalization (tolerant of partial / legacy data) -----------------------

function normalizeTab(tab) {
  return {
    id: typeof tab.id === "string" ? tab.id : newId(),
    url: typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title : "",
    favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    pinned: Boolean(tab.pinned),
    addedAt: Number(tab.addedAt) || Date.now()
  };
}

function normalizeGroup(group) {
  const tabs = Array.isArray(group.tabs) ? group.tabs : [];
  return {
    id: typeof group.id === "string" ? group.id : newId(),
    name: cleanName(group.name, DEFAULT_GROUP_NAME),
    createdAt: Number(group.createdAt) || Date.now(),
    tabs: tabs.filter((t) => t && typeof t === "object").map(normalizeTab)
  };
}

function normalizeWorkspace(ws, index) {
  // Accept legacy "collections" as groups.
  const rawGroups = Array.isArray(ws.groups)
    ? ws.groups
    : Array.isArray(ws.collections)
      ? ws.collections
      : [];
  const groups = rawGroups.filter((g) => g && typeof g === "object").map(normalizeGroup);
  if (!groups.length) groups.push(newGroup(DEFAULT_GROUP_NAME));

  const sessionTabs = Array.isArray(ws.sessionTabs) ? ws.sessionTabs : [];

  return {
    id: typeof ws.id === "string" ? ws.id : newId(),
    name: cleanName(ws.name, `Workspace ${index + 1}`),
    color: typeof ws.color === "string" ? ws.color : WORKSPACE_COLORS[index % WORKSPACE_COLORS.length],
    createdAt: Number(ws.createdAt) || Date.now(),
    updatedAt: Number(ws.updatedAt) || Date.now(),
    sessionTabs: sessionTabs.filter((t) => t && typeof t === "object").map(normalizeTab),
    groups
  };
}

function normalizeRoot(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const workspaces = (Array.isArray(root.workspaces) ? root.workspaces : [])
    .filter((ws) => ws && typeof ws === "object")
    .map(normalizeWorkspace);

  const activeId = workspaces.some((ws) => ws.id === root.activeWorkspaceId)
    ? root.activeWorkspaceId
    : workspaces[0]
      ? workspaces[0].id
      : null;

  return { version: SCHEMA_VERSION, activeWorkspaceId: activeId, workspaces };
}

function newGroup(name) {
  return { id: newId(), name: cleanName(name, DEFAULT_GROUP_NAME), createdAt: Date.now(), tabs: [] };
}

// --- Root read/write ---------------------------------------------------------
//
// Durable data is stored in TWO places so it both survives switching browsers
// and never hits a hard limit:
//
//   * chrome.storage.sync  — synced across every browser signed into the same
//     account. It has tight quotas (~8 KB per item, ~100 KB total), so the tree
//     is SHARDED: one small index item plus one item per workspace.
//        SYNC_INDEX_KEY -> { version, activeWorkspaceId, order: [workspaceId] }
//        SYNC_WS_PREFIX + id -> a single workspace object
//     Any workspace too large for a sync item is skipped (kept local-only) so a
//     big workspace can never block sync of the others.
//
//   * chrome.storage.local — a full-fidelity mirror of the whole tree. It is the
//     source of truth for oversized workspaces and the fallback when sync is
//     empty or unavailable (e.g. the user is signed out).
//
// On read we reassemble from sync and fill any gaps (missing/oversized shards)
// from the local mirror, so no data is ever lost regardless of quota.

// --- Serialization: a single-writer lock ------------------------------------
//
// Every durable change is a read-modify-write (getRoot -> mutate in memory ->
// saveRoot). If two of these interleave, the later save silently discards the
// earlier one (the classic lost-update race). Because the service worker runs
// many of these concurrently (autosave on tab events, the hub's actions,
// workspace switches), we funnel EVERY write through one promise chain so they
// run strictly one after another. Reads that don't write don't need the lock.

let writeChain = Promise.resolve();

// Run `task` after all previously queued writes complete, and before any queued
// later. Failures are contained so one rejected task can't break the chain.
function withWriteLock(task) {
  const run = writeChain.then(task, task);
  // Keep the chain alive regardless of this task's success/failure.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

const SYNC_INDEX_KEY = "tw:index";
const SYNC_WS_PREFIX = "tw:ws:";
// Conservative ceiling for a single sync item (Chrome's QUOTA_BYTES_PER_ITEM is
// 8192 including the key). Workspaces whose serialized size exceeds this stay
// local-only rather than throwing.
const SYNC_ITEM_LIMIT = 7800;

function syncWsKey(id) {
  return SYNC_WS_PREFIX + id;
}

function approxItemBytes(key, value) {
  // Chrome measures the JSON of the value plus the key length.
  return key.length + JSON.stringify(value).length;
}

async function safeSyncGet(keys) {
  try {
    if (!chrome.storage.sync) return null;
    return await chrome.storage.sync.get(keys);
  } catch (_e) {
    return null; // signed out / sync disabled / transient error
  }
}

// Reassemble the root from sharded sync data. Returns null if sync has no index.
async function readSyncRoot() {
  const indexWrap = await safeSyncGet(SYNC_INDEX_KEY);
  if (!indexWrap) return null;
  const index = indexWrap[SYNC_INDEX_KEY];
  if (!index || !Array.isArray(index.order)) return null;

  const keys = index.order.map(syncWsKey);
  const shards = keys.length ? await safeSyncGet(keys) : {};
  const workspaces = [];
  const missing = [];
  for (const id of index.order) {
    const ws = shards ? shards[syncWsKey(id)] : null;
    if (ws && typeof ws === "object") workspaces.push(ws);
    else missing.push(id); // oversized/local-only or not yet synced
  }
  return {
    root: { version: SCHEMA_VERSION, activeWorkspaceId: index.activeWorkspaceId ?? null, workspaces },
    missing,
    rawOrder: index.order.slice()
  };
}

async function readLocalRoot() {
  const current = await chrome.storage.local.get(STORAGE_KEY);
  if (current[STORAGE_KEY]) return normalizeRoot(current[STORAGE_KEY]);

  const legacy = await chrome.storage.local.get(LEGACY_KEY);
  if (legacy[LEGACY_KEY]) {
    const migrated = normalizeRoot(legacy[LEGACY_KEY]);
    await chrome.storage.local.set({ [STORAGE_KEY]: migrated });
    await chrome.storage.local.remove(LEGACY_KEY);
    return migrated;
  }
  return null;
}

export async function getRoot() {
  const local = await readLocalRoot();
  const synced = await readSyncRoot();

  // No synced data yet: use local (or empty), and seed sync from it so the next
  // browser sees it. This also performs the one-time local -> sync migration.
  if (!synced) {
    const root = local || emptyRoot();
    if (local && local.workspaces.length) await pushRootToSync(root).catch(() => {});
    return root;
  }

  // Merge sync + local per workspace, choosing the FRESHER copy by updatedAt.
  //
  // Sync is not blindly authoritative: writes push to sync on a debounce, so
  // for up to ~1.5s the local mirror holds newer data than sync. Blindly
  // trusting sync there would overwrite the user's most recent tabs. Comparing
  // updatedAt keeps whichever side is newer, so a recent local change is never
  // lost to a stale sync copy, and a genuine cross-browser sync update still
  // wins once it is newer.
  const localById = new Map((local ? local.workspaces : []).map((ws) => [ws.id, ws]));
  const syncById = new Map(synced.root.workspaces.map((ws) => [ws.id, ws]));

  // Union of ids from the sync index order and any local-only ids, so a
  // workspace present on either side is never dropped by a transient read.
  const orderedIds = [];
  const seen = new Set();
  for (const id of synced.rawOrder) {
    if (!seen.has(id)) { seen.add(id); orderedIds.push(id); }
  }
  for (const ws of (local ? local.workspaces : [])) {
    if (!seen.has(ws.id)) { seen.add(ws.id); orderedIds.push(ws.id); }
  }

  const workspaces = [];
  for (const id of orderedIds) {
    const s = syncById.get(id);
    const l = localById.get(id);
    if (s && l) {
      // Both present: keep the newer by updatedAt (ties prefer local, which is
      // written first and is the full-fidelity copy).
      workspaces.push((Number(l.updatedAt) || 0) >= (Number(s.updatedAt) || 0) ? l : s);
    } else if (s) {
      workspaces.push(s);
    } else if (l) {
      // In the index but shard missing (oversized/local-only), or local-only
      // and not yet in sync. Either way, keep local so nothing disappears.
      workspaces.push(l);
    }
  }

  // Choose the active workspace pointer. Prefer LOCAL's active id when it is
  // valid: the local mirror is written synchronously on every switch, while the
  // sync copy lags behind the debounced push, so trusting sync here would snap
  // the user back to the previously-active workspace during that window. Fall
  // back to sync's active id (e.g. a fresh install reading another browser's
  // data), then to the first workspace.
  const isValid = (id) => id && workspaces.some((ws) => ws.id === id);
  let activeId = null;
  if (local && isValid(local.activeWorkspaceId)) activeId = local.activeWorkspaceId;
  else if (isValid(synced.root.activeWorkspaceId)) activeId = synced.root.activeWorkspaceId;
  else activeId = workspaces[0] ? workspaces[0].id : null;

  const merged = normalizeRoot({
    version: SCHEMA_VERSION,
    activeWorkspaceId: activeId,
    workspaces
  });

  // Refresh the local mirror only when the merge actually resolved to something
  // different, so ordinary reads don't churn local storage. This write is done
  // under the caller's write lock (mutate/replace*) or as a lone read; a lone
  // read refreshing the mirror is idempotent and safe.
  const mergedJson = JSON.stringify(merged);
  if (!local || JSON.stringify(local) !== mergedJson) {
    await chrome.storage.local.set({ [STORAGE_KEY]: merged }).catch(() => {});
  }
  return merged;
}

// Write the whole tree: mirror to local immediately, then push to sync on a
// short debounce. Debouncing coalesces bursts of autosaves (tab events) into a
// single sync write, staying well under chrome.storage.sync's write-rate quota.
async function saveRoot(root) {
  await chrome.storage.local.set({ [STORAGE_KEY]: root });
  scheduleSyncPush(root);
  return root;
}

let pendingSyncRoot = null;
let syncPushTimer = null;
const SYNC_PUSH_DELAY = 1500;

function scheduleSyncPush(root) {
  pendingSyncRoot = root;
  if (syncPushTimer) return;
  syncPushTimer = setTimeout(() => {
    syncPushTimer = null;
    const toPush = pendingSyncRoot;
    pendingSyncRoot = null;
    if (toPush) pushRootToSync(toPush).catch(() => {});
  }, SYNC_PUSH_DELAY);
}

// Force any debounced sync push to happen now and wait for it. Used at critical
// hand-off points (e.g. right before a switch closes the outgoing tabs) so the
// just-saved state is durable cross-browser, not merely queued. The local
// mirror is already written synchronously by saveRoot, so local durability does
// not depend on this; it only accelerates the sync leg. Best-effort: sync
// errors (offline/quota) are swallowed because local already holds the data.
export async function flushPendingSync() {
  if (syncPushTimer) {
    clearTimeout(syncPushTimer);
    syncPushTimer = null;
  }
  const toPush = pendingSyncRoot;
  pendingSyncRoot = null;
  if (toPush) await pushRootToSync(toPush).catch(() => {});
}

// Push the full tree to sync as an index + per-workspace shards. Removes shards
// for deleted workspaces. Oversized workspaces are skipped (kept local-only)
// but still listed in the index so read-side merge can restore them.
async function pushRootToSync(root) {
  if (!chrome.storage.sync) return;

  const order = root.workspaces.map((ws) => ws.id);
  const setItems = {
    [SYNC_INDEX_KEY]: {
      version: SCHEMA_VERSION,
      activeWorkspaceId: root.activeWorkspaceId,
      order
    }
  };

  for (const ws of root.workspaces) {
    const key = syncWsKey(ws.id);
    if (approxItemBytes(key, ws) <= SYNC_ITEM_LIMIT) {
      setItems[key] = ws;
    }
    // else: too large for a sync item; leave it out of the write. It stays in
    // the local mirror and the index keeps its id so reads can fall back.
  }

  // Remove shards for workspaces that no longer exist.
  const existing = await safeSyncGet(null);
  const removeKeys = [];
  if (existing) {
    const liveKeys = new Set(root.workspaces.map((ws) => syncWsKey(ws.id)));
    for (const key of Object.keys(existing)) {
      if (key.startsWith(SYNC_WS_PREFIX) && !liveKeys.has(key)) removeKeys.push(key);
    }
  }

  try {
    if (removeKeys.length) await chrome.storage.sync.remove(removeKeys);
    await chrome.storage.sync.set(setItems);
  } catch (_e) {
    // Quota/offline/signed-out: local mirror already holds everything.
  }
}

async function mutate(fn) {
  // The read-modify-write runs under the write lock so a concurrent mutation
  // can never read the same root, mutate its own copy, and clobber ours.
  return withWriteLock(async () => {
    const root = await getRoot();
    const result = fn(root);
    await saveRoot(root);
    return { root, result };
  });
}

function findWorkspace(root, workspaceId) {
  return root.workspaces.find((ws) => ws.id === workspaceId) || null;
}

function findGroup(workspace, groupId) {
  if (!workspace) return null;
  return workspace.groups.find((g) => g.id === groupId) || null;
}

// A container is either a workspace's live session ("session") or a group.
// This lets tab operations treat both uniformly.
function findContainer(workspace, containerId) {
  if (!workspace) return null;
  if (containerId === "session") return { kind: "session", tabs: workspace.sessionTabs };
  const group = findGroup(workspace, containerId);
  return group ? { kind: "group", tabs: group.tabs, group } : null;
}

function touch(workspace) {
  if (workspace) workspace.updatedAt = Date.now();
}

export async function ensureDefaults() {
  // getRoot() resolves sync + local, performs legacy migration, and seeds sync
  // from existing local data. If there is genuinely nothing yet, persist an
  // empty root so the local mirror exists.
  const root = await getRoot();
  if (!root.workspaces.length) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (!stored[STORAGE_KEY]) await chrome.storage.local.set({ [STORAGE_KEY]: emptyRoot() });
  }
}

// --- Workspace operations ----------------------------------------------------

export async function createWorkspace(name) {
  const { root, result } = await mutate((root) => {
    const ws = normalizeWorkspace(
      { name: cleanName(name, `Workspace ${root.workspaces.length + 1}`) },
      root.workspaces.length
    );
    ws.groups = [newGroup(DEFAULT_GROUP_NAME)];
    ws.sessionTabs = [];
    root.workspaces.push(ws);
    root.activeWorkspaceId = ws.id;
    return ws;
  });
  return { root, workspace: result };
}

export async function renameWorkspace(workspaceId, name) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    if (!ws) throw new Error("Workspace not found.");
    ws.name = cleanName(name, ws.name);
    touch(ws);
  });
  return { root };
}

export async function setWorkspaceColor(workspaceId, color) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    if (!ws) throw new Error("Workspace not found.");
    if (typeof color === "string") ws.color = color;
    touch(ws);
  });
  return { root };
}

export async function deleteWorkspace(workspaceId) {
  const { root } = await mutate((root) => {
    const index = root.workspaces.findIndex((ws) => ws.id === workspaceId);
    if (index === -1) throw new Error("Workspace not found.");
    root.workspaces.splice(index, 1);
    if (root.activeWorkspaceId === workspaceId) {
      root.activeWorkspaceId = root.workspaces[0] ? root.workspaces[0].id : null;
    }
  });
  return { root };
}

export async function setActiveWorkspace(workspaceId) {
  const { root } = await mutate((root) => {
    if (workspaceId && findWorkspace(root, workspaceId)) {
      root.activeWorkspaceId = workspaceId;
    } else if (workspaceId === null) {
      root.activeWorkspaceId = null;
    }
  });
  return { root };
}

export async function reorderWorkspaces(orderedIds) {
  const { root } = await mutate((root) => {
    root.workspaces.sort(byOrder(orderedIds, (ws) => ws.id));
  });
  return { root };
}

// --- Export / Import (portable backup across any browser) --------------------

const EXPORT_FORMAT = "tab-workspaces-export";
const EXPORT_VERSION = 1;

// Produce a plain, self-describing snapshot of every workspace and its tabs.
// This is the portable format used to move data between browsers that do not
// share a sync backend (e.g. Brave <-> Edge <-> Chrome).
export async function exportData() {
  const root = await getRoot();
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    activeWorkspaceId: root.activeWorkspaceId,
    workspaces: root.workspaces
  };
}

// Pull a normalized list of workspaces out of an imported payload. Accepts both
// the export envelope and a raw root object, and re-mints all ids so an import
// never collides with or overwrites existing workspaces by id.
function workspacesFromPayload(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  return list
    .filter((ws) => ws && typeof ws === "object")
    .map((ws, index) => {
      const normalized = normalizeWorkspace(ws, index);
      // Fresh ids everywhere so merge/replace can't clash with current data.
      normalized.id = newId();
      normalized.groups = normalized.groups.map((g) => ({ ...g, id: newId() }));
      return normalized;
    });
}

// Import workspaces from a parsed payload.
//   mode "merge"   -> append the imported workspaces to the existing ones
//   mode "replace" -> discard existing workspaces and use only the imported ones
// Returns { root, imported } where imported is the count of added workspaces.
export async function importData(payload, mode = "merge") {
  const incoming = workspacesFromPayload(payload);
  if (!incoming.length) throw new Error("No workspaces found in the imported file.");

  const { root, result } = await mutate((root) => {
    if (mode === "replace") {
      root.workspaces = incoming;
    } else {
      root.workspaces = root.workspaces.concat(incoming);
    }
    // Keep a valid active workspace: prefer the current one, else the first.
    if (!root.workspaces.some((ws) => ws.id === root.activeWorkspaceId)) {
      root.activeWorkspaceId = root.workspaces[0] ? root.workspaces[0].id : null;
    }
    return incoming.length;
  });
  return { root, imported: result };
}

// --- Group (tab group) operations --------------------------------------------

export async function createGroup(workspaceId, name) {
  const { root, result } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    if (!ws) throw new Error("Workspace not found.");
    const group = newGroup(name || `Group ${ws.groups.length + 1}`);
    ws.groups.push(group);
    touch(ws);
    return group;
  });
  return { root, group: result };
}

export async function renameGroup(workspaceId, groupId, name) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    const group = findGroup(ws, groupId);
    if (!group) throw new Error("Group not found.");
    group.name = cleanName(name, group.name);
    touch(ws);
  });
  return { root };
}

export async function deleteGroup(workspaceId, groupId) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    if (!ws) throw new Error("Workspace not found.");
    const index = ws.groups.findIndex((g) => g.id === groupId);
    if (index === -1) throw new Error("Group not found.");
    ws.groups.splice(index, 1);
    if (!ws.groups.length) ws.groups.push(newGroup(DEFAULT_GROUP_NAME));
    touch(ws);
  });
  return { root };
}

// --- Tab operations (containerId is "session" or a group id) -----------------

// Add many tabs to a container at once. Skips URLs already present in that
// same container to avoid duplicates on repeat saves.
export async function addTabs(workspaceId, containerId, tabs) {
  const { root, result } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    const container = findContainer(ws, containerId);
    if (!container) throw new Error("Container not found.");

    const existingUrls = new Set(container.tabs.map((t) => t.url));
    let added = 0;
    for (const raw of tabs || []) {
      const tab = normalizeTab({
        id: newId(),
        url: raw.url,
        title: raw.title,
        favIconUrl: raw.favIconUrl,
        pinned: raw.pinned,
        addedAt: Date.now()
      });
      if (!tab.url || existingUrls.has(tab.url)) continue;
      existingUrls.add(tab.url);
      container.tabs.push(tab);
      added += 1;
    }
    touch(ws);
    return { added };
  });
  return { root, added: result.added };
}

// Compare only fields represented by a browser session. IDs and timestamps are
// storage identity, not browser state.
function sameSessionTabs(existing, rawTabs) {
  if (existing.length !== rawTabs.length) return false;
  return existing.every((tab, index) => {
    const raw = rawTabs[index];
    return tab.url === raw.url
      && tab.title === (raw.title || raw.url || "")
      && tab.favIconUrl === (raw.favIconUrl || "")
      && tab.pinned === Boolean(raw.pinned);
  });
}

function buildSessionTabs(existing, rawTabs) {
  // Preserve IDs/addedAt for matching URLs, even if order changes. Queues keep
  // duplicate URLs deterministic without retaining any additional state.
  const byUrl = new Map();
  for (const tab of existing) {
    if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
    byUrl.get(tab.url).push(tab);
  }

  return rawTabs
    .filter((tab) => tab && tab.url)
    .map((raw) => {
      const previous = byUrl.get(raw.url)?.shift();
      return normalizeTab({
        id: previous?.id || newId(),
        url: raw.url,
        title: raw.title || raw.url,
        favIconUrl: raw.favIconUrl || "",
        pinned: raw.pinned,
        addedAt: previous?.addedAt || Date.now()
      });
    });
}

// Replace a workspace's live session inside an already-loaded root.
//
// Safety guard (allowEmpty=false, the default): if the incoming snapshot is
// empty but the workspace currently has saved tabs, we DO NOT overwrite. An
// empty snapshot almost always means a transient loss of tab ownership (a rapid
// switch, a cleared session map, a mid-transition window) rather than a real
// "the user closed everything" — so treating it as authoritative would silently
// wipe the workspace. Callers that truly intend to clear pass allowEmpty=true.
function replaceSessionInRoot(root, workspaceId, tabs, { allowEmpty = false } = {}) {
  const ws = findWorkspace(root, workspaceId);
  if (!ws) throw new Error("Workspace not found.");
  const rawTabs = (tabs || []).filter((tab) => tab && tab.url);
  if (!allowEmpty && !rawTabs.length && ws.sessionTabs.length) {
    return { root, changed: false };
  }
  if (sameSessionTabs(ws.sessionTabs, rawTabs)) return { root, changed: false };
  ws.sessionTabs = buildSessionTabs(ws.sessionTabs, rawTabs);
  touch(ws);
  return { root, changed: true };
}

// Replace one workspace's session, serialized and re-reading the freshest root
// under the write lock so it can't race with autosave or another switch. Writes
// only when something actually changed.
export async function replaceSessionTabs(workspaceId, tabs, opts = {}) {
  return withWriteLock(async () => {
    const root = await getRoot();
    const res = replaceSessionInRoot(root, workspaceId, tabs, opts);
    if (res.changed) await saveRoot(root);
    return res;
  });
}

// Autosave-specialized path: replace the active workspace's session, serialized
// under the write lock and re-reading the freshest root.
//
// expectedWorkspaceId guards against a stale autosave: the caller snapshots the
// window believing workspace X is active, but by the time this runs a switch
// may have made Y active. If the active workspace no longer matches what was
// snapshotted, we skip the write so an old snapshot can never land on the wrong
// workspace. preserveNonEmpty keeps an empty snapshot from wiping a populated
// session (save/close/restore semantics).
export async function replaceActiveSessionTabs(tabs, { preserveNonEmpty = true, expectedWorkspaceId = null } = {}) {
  return withWriteLock(async () => {
    const root = await getRoot();
    const workspaceId = root.activeWorkspaceId;
    if (!workspaceId) return { root, changed: false, workspaceId: null };
    if (expectedWorkspaceId && expectedWorkspaceId !== workspaceId) {
      // Active workspace changed since the snapshot was taken; drop it.
      return { root, changed: false, workspaceId, skipped: true };
    }
    const rawTabs = (tabs || []).filter((tab) => tab && tab.url);
    const res = replaceSessionInRoot(root, workspaceId, rawTabs, { allowEmpty: !preserveNonEmpty });
    if (res.changed) await saveRoot(root);
    return { ...res, workspaceId };
  });
}

export async function renameTab(workspaceId, containerId, tabId, title) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    const container = findContainer(ws, containerId);
    const tab = container && container.tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error("Tab not found.");
    tab.title = cleanName(title, tab.title);
    touch(ws);
  });
  return { root };
}

export async function removeTab(workspaceId, containerId, tabId) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    const container = findContainer(ws, containerId);
    if (!container) throw new Error("Container not found.");
    const index = container.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) throw new Error("Tab not found.");
    container.tabs.splice(index, 1);
    touch(ws);
  });
  return { root };
}

export async function reorderTabs(workspaceId, containerId, orderedIds) {
  const { root } = await mutate((root) => {
    const ws = findWorkspace(root, workspaceId);
    const container = findContainer(ws, containerId);
    if (!container) throw new Error("Container not found.");
    container.tabs.sort(byOrder(orderedIds, (t) => t.id));
    touch(ws);
  });
  return { root };
}

// Move a tab between any two containers, in any workspaces, optional position.
export async function moveTab({
  fromWorkspaceId,
  fromContainerId,
  tabId,
  toWorkspaceId,
  toContainerId,
  toIndex
}) {
  const { root } = await mutate((root) => {
    const fromWs = findWorkspace(root, fromWorkspaceId);
    const fromContainer = findContainer(fromWs, fromContainerId);
    if (!fromContainer) throw new Error("Source container not found.");

    const index = fromContainer.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) throw new Error("Tab not found.");

    const toWs = findWorkspace(root, toWorkspaceId);
    const toContainer = findContainer(toWs, toContainerId);
    if (!toContainer) throw new Error("Target container not found.");

    const [tab] = fromContainer.tabs.splice(index, 1);

    // Guard against duplicating a URL in the destination container.
    const dupe = toContainer.tabs.find((t) => t.url === tab.url && t.id !== tab.id);
    if (dupe) {
      touch(fromWs);
      touch(toWs);
      return;
    }

    const insertAt =
      Number.isInteger(toIndex) && toIndex >= 0 && toIndex <= toContainer.tabs.length
        ? toIndex
        : toContainer.tabs.length;
    toContainer.tabs.splice(insertAt, 0, tab);
    touch(fromWs);
    touch(toWs);
  });
  return { root };
}

// --- Search ------------------------------------------------------------------

export function searchRoot(root, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { query: "", workspaces: [], tabs: [] };

  const workspaceMatches = [];
  const tabMatches = [];

  const consider = (ws, containerId, containerName, tab, containerHit) => {
    if (
      containerHit ||
      tab.title.toLowerCase().includes(q) ||
      tab.url.toLowerCase().includes(q)
    ) {
      tabMatches.push({
        tab,
        workspaceId: ws.id,
        workspaceName: ws.name,
        containerId,
        containerName
      });
    }
  };

  for (const ws of root.workspaces) {
    if (ws.name.toLowerCase().includes(q)) {
      workspaceMatches.push({ id: ws.id, name: ws.name, color: ws.color });
    }
    for (const tab of ws.sessionTabs) consider(ws, "session", "Open tabs", tab, false);
    for (const group of ws.groups) {
      const hit = group.name.toLowerCase().includes(q);
      for (const tab of group.tabs) consider(ws, group.id, group.name, tab, hit);
    }
  }

  return { query: q, workspaces: workspaceMatches, tabs: tabMatches };
}

// --- Helpers -----------------------------------------------------------------

function byOrder(orderedIds, getId) {
  const rank = new Map(orderedIds.map((id, i) => [id, i]));
  return (a, b) => {
    const ra = rank.has(getId(a)) ? rank.get(getId(a)) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(getId(b)) ? rank.get(getId(b)) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  };
}

export {
  STORAGE_KEY, LEGACY_KEY, DEFAULT_GROUP_NAME, WORKSPACE_COLORS,
  SYNC_INDEX_KEY, SYNC_WS_PREFIX
};
