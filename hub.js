// hub.js
// Controller for the dedicated hub page. Holds an in-memory copy of state,
// renders the sidebar + active workspace, and turns every UI action into a
// message to the background service worker (the source of truth). Live updates
// arrive via the "stateChanged" broadcast.
//
// All transient overlays (menus, context menus, confirm popovers, inline
// editors) go through floating.js, which guarantees a single open layer that
// dismisses reliably. render() always closes any open overlay first, so a
// state change or workspace switch can never leave a menu stuck on screen.

import { WORKSPACE_COLORS } from "./storage.js";
import * as fl from "./floating.js";
import * as preview from "./preview.js";

const TAB_RENDER_BATCH = 120;

const state = {
  root: { version: 2, activeWorkspaceId: null, workspaces: [] },
  openUrls: new Set(),
  searchQuery: "",
  searchResults: null,
  loading: true,
  drag: null,
  wsDrag: null,
  refreshQueued: false,
  refreshInFlight: false,
  refreshAgain: false,
  dirtyWhileEditing: false,
  editing: null,
  counts: new Map(),
  totalTabs: 0,
  listObserver: null,
  progressiveEntries: new Map()
};

const el = {};
document.addEventListener("DOMContentLoaded", init);

async function init() {
  cache();
  bindGlobal();
  render(); // paint loading/empty shell immediately

  const res = await send({ type: "getState" });
  if (res && res.ok) acceptState(res);
  state.loading = false;
  render();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "stateChanged") queueRefresh();
  });
  window.addEventListener("pagehide", cleanup, { once: true });
}

function cache() {
  const ids = [
    "searchInput", "clearInlineSearch", "spaceList", "footMeta", "newWorkspaceBtn",
    "searchView", "searchMeta", "clearSearchBtn", "searchWorkspaces", "searchTabs",
    "workspaceView", "wsBody", "wsColorDot", "wsName", "wsMeta",
    "saveSessionBtn", "restoreBtn", "wsMenuBtn",
    "openTabsList", "openTabsCount", "groupsHost", "addGroupBtn",
    "exportBtn", "importBtn", "importFile"
  ];
  for (const id of ids) el[id] = document.getElementById(id);
  el.tpl = {
    space: document.getElementById("spaceItemTemplate"),
    group: document.getElementById("groupTemplate"),
    tab: document.getElementById("tabTemplate")
  };
}

function bindGlobal() {
  el.newWorkspaceBtn.addEventListener("click", (e) => startCreateWorkspace(e.currentTarget));
  el.saveSessionBtn.addEventListener("click", () => onSaveSession(false));
  el.restoreBtn.addEventListener("click", () => onRestore(false));
  el.wsMenuBtn.addEventListener("click", (e) => openWorkspaceMenu(e.currentTarget));
  el.addGroupBtn.addEventListener("click", (e) => startCreateGroup(e.currentTarget));
  el.clearSearchBtn.addEventListener("click", clearSearch);
  el.clearInlineSearch.addEventListener("click", clearSearch);
  el.searchInput.addEventListener("input", debounce(onSearchInput, 140));
  el.exportBtn.addEventListener("click", onExport);
  el.importBtn.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", onImportFileChosen);

  // High-cardinality lists use delegation rather than per-row click/menu
  // closures. Drag listeners remain row-local because drag state is transient.
  // Handlers are wrapped in arrows so they resolve at event time, keeping
  // binding independent of declaration order.
  el.spaceList.addEventListener("click", (e) => onWorkspaceListClick(e));
  el.spaceList.addEventListener("contextmenu", (e) => onWorkspaceListContextMenu(e));
  el.spaceList.addEventListener("keydown", (e) => onWorkspaceListKeydown(e));
  el.spaceList.addEventListener("pointerover", (e) => onWorkspacePreviewEnter(e));
  el.spaceList.addEventListener("pointerout", (e) => onWorkspacePreviewLeave(e));
  el.spaceList.addEventListener("focusin", (e) => onWorkspacePreviewEnter(e));
  el.spaceList.addEventListener("focusout", (e) => onWorkspacePreviewLeave(e));
  el.wsBody.addEventListener("click", (e) => onWorkspaceBodyClick(e));
  el.wsBody.addEventListener("dblclick", (e) => onWorkspaceBodyDoubleClick(e));
  el.wsBody.addEventListener("contextmenu", (e) => onWorkspaceBodyContextMenu(e));
  el.searchTabs.addEventListener("click", (e) => onSearchTabsClick(e));
  el.searchTabs.addEventListener("dblclick", (e) => onSearchTabsDoubleClick(e));

  document.addEventListener("keydown", (e) => onKeydown(e));
}

// --- Derived helpers ---------------------------------------------------------

function activeWorkspace() {
  return workspaceById(state.root.activeWorkspaceId);
}
function workspaceById(id) {
  return state.root.workspaces.find((w) => w.id === id) || null;
}
function wsTabCount(ws) {
  return state.counts.get(ws.id) ?? (ws.sessionTabs.length + ws.groups.reduce((n, g) => n + g.tabs.length, 0));
}
function openUrlSet() {
  return state.openUrls;
}
function containerById(ws, containerId) {
  if (!ws) return null;
  return containerId === "session" ? { id: "session", name: "Open tabs", tabs: ws.sessionTabs }
    : ws.groups.find((g) => g.id === containerId) || null;
}
function tabByIds(workspaceId, containerId, tabId) {
  const ws = workspaceById(workspaceId);
  const container = containerById(ws, containerId);
  const tab = container && container.tabs.find((t) => t.id === tabId);
  return tab ? { ws, container, tab } : null;
}
function rebuildDerived() {
  state.counts = new Map();
  state.totalTabs = 0;
  for (const ws of state.root.workspaces) {
    const count = ws.sessionTabs.length + ws.groups.reduce((n, g) => n + g.tabs.length, 0);
    state.counts.set(ws.id, count);
    state.totalTabs += count;
  }
}
function acceptState(res) {
  if (res.root) state.root = res.root;
  if (Array.isArray(res.openUrls)) {
    state.openUrls = new Set(res.openUrls.filter(Boolean));
  } else if (Array.isArray(res.openTabs)) {
    state.openUrls = new Set(res.openTabs.map((tab) => tab.url).filter(Boolean));
  }
  rebuildDerived();
  if (state.searchQuery) state.searchResults = searchLocal(state.searchQuery);
}

// --- Rendering ---------------------------------------------------------------

function queueRefresh() {
  if (state.editing) {
    state.dirtyWhileEditing = true;
    return;
  }
  if (state.refreshQueued || state.refreshInFlight) {
    state.refreshAgain = true;
    return;
  }
  state.refreshQueued = true;
  setTimeout(runRefresh, 90);
}

async function runRefresh() {
  state.refreshQueued = false;
  if (state.editing) {
    state.dirtyWhileEditing = true;
    return;
  }
  state.refreshInFlight = true;
  try {
    const res = await send({ type: "getState" });
    if (res && res.ok) {
      acceptState(res);
      render();
    }
  } finally {
    state.refreshInFlight = false;
    if (state.refreshAgain) {
      state.refreshAgain = false;
      queueRefresh();
    }
  }
}

function render() {
  // Transient UI always follows current state; never leave stale overlays or
  // previews attached to nodes that are about to be replaced.
  fl.closeAll();
  preview.hide();
  resetProgressiveRendering();

  renderSidebar();
  const searching = Boolean(state.searchQuery);
  el.clearInlineSearch.hidden = !searching;
  el.searchView.hidden = !searching;
  el.workspaceView.hidden = searching;
  if (searching) renderSearch();
  else renderWorkspace();
}

function renderSidebar() {
  el.spaceList.replaceChildren();
  const activeId = state.root.activeWorkspaceId;

  if (!state.root.workspaces.length && !state.loading) {
    const hint = document.createElement("p");
    hint.className = "rail-empty";
    hint.textContent = "No workspaces yet";
    el.spaceList.appendChild(hint);
  }

  for (const ws of state.root.workspaces) {
    const node = el.tpl.space.content.firstElementChild.cloneNode(true);
    node.dataset.workspaceId = ws.id;
    const active = ws.id === activeId;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-current", active ? "true" : "false");
    node.title = active ? `${ws.name} (current workspace)` : `Switch to ${ws.name}`;
    node.querySelector(".space-dot").style.background = ws.color;
    node.querySelector(".space-name").textContent = ws.name;
    const count = node.querySelector(".space-count");
    count.textContent = String(wsTabCount(ws));

    // Click, keyboard, context-menu, and preview behavior are delegated from
    // #spaceList so large workspace lists do not allocate handlers per row.
    bindWorkspaceDrag(node, ws);
    el.spaceList.append(node);
  }

  const total = state.root.workspaces.length;
  const tabs = state.totalTabs;
  el.footMeta.textContent = total
    ? `${total} workspace${total === 1 ? "" : "s"} · ${tabs} tab${tabs === 1 ? "" : "s"}`
    : "";
}

function workspaceEventContext(event) {
  const row = event.target.closest(".space-item[data-workspace-id]");
  if (!row || !el.spaceList.contains(row)) return null;
  const ws = workspaceById(row.dataset.workspaceId);
  return ws ? { row, ws } : null;
}

function onWorkspaceListClick(event) {
  const ctx = workspaceEventContext(event);
  if (!ctx) return;
  preview.hide();
  const menuBtn = event.target.closest(".space-menu");
  if (menuBtn) {
    event.stopPropagation();
    openWorkspaceMenu(menuBtn, ctx.ws);
    return;
  }
  selectWorkspace(ctx.ws.id);
}

function onWorkspaceListContextMenu(event) {
  const ctx = workspaceEventContext(event);
  if (!ctx) return;
  event.preventDefault();
  preview.hide();
  fl.openMenu({ x: event.clientX, y: event.clientY }, workspaceMenuItems(ctx.ws, ctx.row));
}

function onWorkspaceListKeydown(event) {
  const ctx = workspaceEventContext(event);
  if (!ctx || event.target.closest("button, input")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    preview.hide();
    selectWorkspace(ctx.ws.id);
  } else if (event.key === "F10" && event.shiftKey) {
    event.preventDefault();
    preview.hide();
    fl.openMenu({ anchor: ctx.row, align: "left" }, workspaceMenuItems(ctx.ws, ctx.row));
  }
}

function onWorkspacePreviewEnter(event) {
  const ctx = workspaceEventContext(event);
  if (!ctx || event.target.closest(".space-menu")) return;
  if (event.type === "pointerover" && ctx.row.contains(event.relatedTarget)) return;
  if (state.drag || state.wsDrag || state.editing || fl.isOpen()) return;
  preview.schedule({ anchor: ctx.row, workspace: ctx.ws, faviconFor });
}

function onWorkspacePreviewLeave(event) {
  const ctx = workspaceEventContext(event);
  if (!ctx) return;
  if ((event.type === "pointerout" || event.type === "focusout") && ctx.row.contains(event.relatedTarget)) return;
  preview.scheduleHide();
}

function renderWorkspace() {
  const ws = activeWorkspace();
  if (!ws) {
    el.wsName.textContent = state.loading ? "Loading…" : "No workspace";
    el.wsColorDot.style.visibility = "hidden";
    el.openTabsList.replaceChildren();
    el.openTabsCount.textContent = "";
    el.groupsHost.replaceChildren(
      state.loading
        ? skeletonList(4)
        : emptyState({
            icon: true,
            title: "Create your first workspace",
            message: "A workspace holds the tabs for one project. Create one, then click “Save open tabs” to fill it. Click a workspace in the sidebar anytime to switch your browser to its tabs.",
            actionLabel: "New workspace",
            onAction: (btn) => startCreateWorkspace(btn)
          })
    );
    setHeadEnabled(false);
    return;
  }

  setHeadEnabled(true);
  el.wsColorDot.style.visibility = "visible";
  el.wsColorDot.style.background = ws.color;
  el.wsName.textContent = ws.name;
  el.wsName.title = ws.name;
  el.wsMeta.textContent =
    `${ws.groups.length} group${ws.groups.length === 1 ? "" : "s"} · ${wsTabCount(ws)} tab${wsTabCount(ws) === 1 ? "" : "s"}`;

  const openSet = openUrlSet();
  renderTabList(el.openTabsList, ws.sessionTabs, ws, "session", openSet,
    "No tabs here yet. Click “Save open tabs” to add the tabs open in this window.");
  el.openTabsCount.textContent = String(ws.sessionTabs.length);
  markDropContainer(el.openTabsList.closest(".section"), ws.id, "session");

  el.groupsHost.replaceChildren();
  for (const group of ws.groups) {
    el.groupsHost.append(renderGroup(ws, group, openSet));
  }
}

function renderGroup(ws, group, openSet) {
  const node = el.tpl.group.content.firstElementChild.cloneNode(true);
  node.dataset.container = group.id;
  node.dataset.workspaceId = ws.id;
  const nameEl = node.querySelector(".group-name");
  nameEl.textContent = group.name;
  nameEl.title = group.name;
  node.querySelector(".group-count").textContent = String(group.tabs.length);

  const list = node.querySelector(".group-tabs");
  renderTabList(list, group.tabs, ws, group.id, openSet, "Drag tabs here to group them.");
  markDropContainer(node, ws.id, group.id);
  return node;
}

function renderTabList(host, tabs, ws, containerId, openSet, emptyMsg) {
  renderProgressiveList(
    host,
    tabs,
    (tab) => renderTab(ws, containerId, tab, openSet.has(tab.url)),
    () => emptyState({ message: emptyMsg, compact: true })
  );
}

function resetProgressiveRendering() {
  if (state.listObserver) state.listObserver.disconnect();
  state.listObserver = null;
  state.progressiveEntries.clear();
}

function ensureListObserver() {
  if (state.listObserver || typeof IntersectionObserver === "undefined") return state.listObserver;
  state.listObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const payload = state.progressiveEntries.get(entry.target);
      if (payload) appendProgressiveBatch(payload);
    }
  }, { root: null, rootMargin: "300px 0px" });
  return state.listObserver;
}

function renderProgressiveList(host, items, makeNode, makeEmpty) {
  host.replaceChildren();
  if (!items.length) {
    host.append(makeEmpty());
    return;
  }

  const payload = { host, items, makeNode, index: 0, sentinel: null };
  appendProgressiveBatch(payload);
}

function appendProgressiveBatch(payload) {
  const end = Math.min(payload.items.length, payload.index + TAB_RENDER_BATCH);
  const fragment = document.createDocumentFragment();
  for (; payload.index < end; payload.index += 1) {
    fragment.append(payload.makeNode(payload.items[payload.index]));
  }

  if (payload.sentinel && payload.sentinel.isConnected) {
    payload.host.insertBefore(fragment, payload.sentinel);
  } else {
    payload.host.append(fragment);
  }

  if (payload.index >= payload.items.length) {
    if (payload.sentinel) {
      state.listObserver?.unobserve(payload.sentinel);
      state.progressiveEntries.delete(payload.sentinel);
      payload.sentinel.remove();
    }
    return;
  }

  if (!payload.sentinel) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "progressive-more";
    more.addEventListener("click", () => appendProgressiveBatch(payload));
    payload.sentinel = more;
    payload.host.append(more);
    const observer = ensureListObserver();
    if (observer) {
      state.progressiveEntries.set(more, payload);
      observer.observe(more);
    }
  }
  payload.sentinel.textContent = `Show ${Math.min(TAB_RENDER_BATCH, payload.items.length - payload.index)} more`;
}

function renderTab(ws, containerId, tab, isOpen) {
  const node = el.tpl.tab.content.firstElementChild.cloneNode(true);
  node.dataset.tabId = tab.id;
  node.dataset.workspaceId = ws.id;
  node.dataset.containerId = containerId;
  node.classList.toggle("is-open", isOpen);

  const fav = node.querySelector(".tab-favicon");
  fav.loading = "lazy";
  fav.decoding = "async";
  fav.src = faviconFor(tab);
  fav.addEventListener("error", () => { fav.style.visibility = "hidden"; });

  const titleEl = node.querySelector(".tab-title");
  titleEl.textContent = tab.title || tab.url;
  node.querySelector(".tab-url").textContent = prettyUrl(tab.url);
  node.title = `${tab.title || ""}\n${tab.url}`;

  // Click, menu, double-click, and context-menu actions are delegated from
  // #wsBody; only drag behavior remains attached to the row.
  bindTabDrag(node, ws, containerId, tab);
  return node;
}

function searchLocal(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { query: "", workspaces: [], tabs: [] };
  const workspaces = [];
  const tabs = [];

  const consider = (ws, container, tab, containerHit) => {
    if (containerHit || tab.title.toLowerCase().includes(q) || tab.url.toLowerCase().includes(q)) {
      tabs.push({ workspaceId: ws.id, containerId: container.id, tabId: tab.id });
    }
  };

  for (const ws of state.root.workspaces) {
    if (ws.name.toLowerCase().includes(q)) workspaces.push({ id: ws.id, name: ws.name, color: ws.color });
    const session = { id: "session", name: "Open tabs", tabs: ws.sessionTabs };
    for (const tab of session.tabs) consider(ws, session, tab, false);
    for (const group of ws.groups) {
      const hit = group.name.toLowerCase().includes(q);
      for (const tab of group.tabs) consider(ws, group, tab, hit);
    }
  }
  return { query: q, workspaces, tabs };
}

function resolveSearchMatch(match) {
  const resolved = tabByIds(match.workspaceId, match.containerId, match.tabId);
  return resolved ? { ...resolved, match } : null;
}

function renderSearch() {
  const r = state.searchResults || { workspaces: [], tabs: [] };
  const total = r.workspaces.length + r.tabs.length;
  el.searchMeta.textContent = `${total} result${total === 1 ? "" : "s"} for “${state.searchQuery}”`;

  el.searchWorkspaces.replaceChildren();
  for (const w of r.workspaces) {
    const chip = document.createElement("button");
    chip.className = "ws-chip";
    chip.type = "button";
    chip.dataset.workspaceId = w.id;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = w.color || "var(--accent)";
    chip.append(dot, document.createTextNode(w.name));
    chip.addEventListener("click", () => { clearSearch(); viewWorkspace(w.id); });
    el.searchWorkspaces.append(chip);
  }

  const resolvedMatches = r.tabs.map(resolveSearchMatch).filter(Boolean);
  renderProgressiveList(
    el.searchTabs,
    resolvedMatches,
    ({ ws, container, tab }) => {
      const node = el.tpl.tab.content.firstElementChild.cloneNode(true);
      node.setAttribute("draggable", "false");
      node.classList.add("static");
      node.classList.toggle("is-open", state.openUrls.has(tab.url));
      node.dataset.url = tab.url;
      const fav = node.querySelector(".tab-favicon");
      fav.loading = "lazy";
      fav.decoding = "async";
      fav.src = faviconFor(tab);
      fav.addEventListener("error", () => { fav.style.visibility = "hidden"; }, { once: true });
      node.querySelector(".tab-title").textContent = tab.title || tab.url;
      node.querySelector(".tab-url").textContent = `${ws.name} › ${container.name}`;
      node.querySelector(".tab-menu").remove();
      return node;
    },
    () => emptyState({ message: "No matching tabs.", compact: true })
  );
}

function tabRowContext(row) {
  if (!row) return null;
  const resolved = tabByIds(row.dataset.workspaceId, row.dataset.containerId, row.dataset.tabId);
  return resolved ? { ...resolved, row, titleEl: row.querySelector(".tab-title") } : null;
}

function onWorkspaceBodyClick(event) {
  const groupNode = event.target.closest(".group[data-container]");
  if (groupNode) {
    const ws = workspaceById(groupNode.dataset.workspaceId);
    const group = ws && ws.groups.find((g) => g.id === groupNode.dataset.container);
    if (ws && group && event.target.closest(".group-open")) {
      onOpenContainer(ws, group.id);
      return;
    }
    const groupMenu = event.target.closest(".group-menu");
    if (ws && group && groupMenu) {
      fl.openMenu({ anchor: groupMenu }, [
        { label: "Open all tabs", onClick: () => onOpenContainer(ws, group.id) },
        { label: "Rename group", onClick: () => startRenameGroup(ws.id, group, groupNode.querySelector(".group-name")) },
        { sep: true },
        { label: "Delete group", danger: true, onClick: () => confirmDeleteGroup(groupMenu, ws.id, group) }
      ]);
      return;
    }
  }

  const row = event.target.closest(".tab-row[data-tab-id]");
  const ctx = tabRowContext(row);
  if (!ctx) return;
  const menu = event.target.closest(".tab-menu");
  if (menu) {
    fl.openMenu({ anchor: menu }, tabMenuItems(ctx.ws, ctx.container.id, ctx.tab, state.openUrls.has(ctx.tab.url), ctx.titleEl));
    return;
  }
  // Clicking anywhere else on the row opens (or focuses) the tab, like Workona.
  onOpenTab(ctx.tab.url);
}

function onWorkspaceBodyDoubleClick() {
  // Single-click already opens; nothing extra needed on double-click.
}

function onWorkspaceBodyContextMenu(event) {
  const ctx = tabRowContext(event.target.closest(".tab-row[data-tab-id]"));
  if (!ctx) return;
  event.preventDefault();
  fl.openMenu(
    { x: event.clientX, y: event.clientY },
    tabMenuItems(ctx.ws, ctx.container.id, ctx.tab, state.openUrls.has(ctx.tab.url), ctx.titleEl)
  );
}

function onSearchTabsClick(event) {
  const row = event.target.closest(".tab-row[data-url]");
  if (row) onOpenTab(row.dataset.url);
}

function onSearchTabsDoubleClick() {
  // Single-click opens; no double-click behavior needed.
}

// --- Menu item builders ------------------------------------------------------

function workspaceMenuItems(ws, anchor = el.wsMenuBtn) {
  const nameEl = document.querySelector(`.space-item[data-workspace-id="${ws.id}"] .space-name`);
  return [
    { label: "Open in new window", onClick: () => onRestore(true, ws.id) },
    { label: "Save current tabs here", onClick: () => onSaveSessionInto(ws.id) },
    { sep: true },
    { label: "Rename", onClick: () => startRenameWorkspace(ws, nameEl) },
    { label: "Change color", onClick: () => onRecolor(ws) },
    { sep: true },
    { label: "Delete workspace", danger: true,
      onClick: () => confirmDeleteWorkspace(anchor, ws) }
  ];
}

function openWorkspaceMenu(anchor, ws) {
  const target = ws || activeWorkspace();
  if (!target) return;
  preview.hide();
  fl.openMenu({ anchor, align: "right" }, workspaceMenuItems(target, anchor));
}

function tabMenuItems(ws, containerId, tab, isOpen, titleEl) {
  const items = [
    { label: isOpen ? "Focus tab" : "Open tab", onClick: () => onOpenTab(tab.url) },
    { label: "Rename", onClick: () => startRenameTab(ws.id, containerId, tab, titleEl) },
    { label: "Copy URL", onClick: () => copyText(tab.url) }
  ];

  const targets = [];
  for (const w of state.root.workspaces) {
    const containers = [{ id: "session", name: "Open tabs" }, ...w.groups.map((g) => ({ id: g.id, name: g.name }))];
    for (const c of containers) {
      if (w.id === ws.id && c.id === containerId) continue;
      targets.push({ w, c });
    }
  }
  if (targets.length) {
    items.push({ sep: true }, { header: true, label: "Move to" });
    for (const t of targets.slice(0, 10)) {
      items.push({
        label: `${t.w.name} › ${t.c.name}`,
        onClick: () => doMoveTab(ws.id, containerId, tab.id, t.w.id, t.c.id)
      });
    }
  }
  if (isOpen) {
    items.push({ sep: true }, {
      label: "Close browser tab",
      onClick: async () => { await send({ type: "closeOpenTab", url: tab.url }); toast("Closed the browser tab."); }
    });
  }
  items.push({ sep: true }, {
    label: "Remove from workspace", danger: true,
    onClick: () => onRemoveTab(ws.id, containerId, tab.id)
  });
  return items;
}

// --- Inline editors (replace prompt) -----------------------------------------

function endEditing() {
  state.editing = null;
  if (state.dirtyWhileEditing) {
    state.dirtyWhileEditing = false;
    // Coalesce the deferred passive update with any mutation caused by commit.
    setTimeout(queueRefresh, 180);
  }
}

// Turn a label element into an input; commit on Enter/blur, cancel on Escape.
function inlineEdit(labelEl, currentValue, onCommit) {
  fl.closeAll();
  const editId = `edit-${Date.now()}`;
  state.editing = editId;

  const input = document.createElement("input");
  input.className = "inline-edit";
  input.value = currentValue;
  input.setAttribute("aria-label", "Edit name");
  input.spellcheck = false;

  const parent = labelEl.parentNode;
  parent.replaceChild(input, labelEl);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    endEditing();
    const value = input.value.trim();
    if (input.parentNode === parent) parent.replaceChild(labelEl, input);
    if (commit && value && value !== currentValue) onCommit(value);
    else if (commit && !value) { /* ignore empty */ }
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

// Create-new inline editors use a transient input placed where the item lives.
function startCreateWorkspace() {
  // Add a temporary row at the top of the sidebar to name the new workspace.
  fl.closeAll();
  const editId = `new-ws-${Date.now()}`;
  state.editing = editId;

  const row = document.createElement("div");
  row.className = "space-item is-creating";
  const dot = document.createElement("span");
  dot.className = "space-dot";
  dot.style.background = WORKSPACE_COLORS[state.root.workspaces.length % WORKSPACE_COLORS.length];
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.placeholder = "Workspace name";
  row.append(dot, input);
  el.spaceList.prepend(row);
  input.focus();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    endEditing();
    const value = input.value.trim();
    row.remove();
    if (commit && value) apply(await send({ type: "createWorkspace", name: value }));
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function startCreateGroup() {
  const ws = activeWorkspace();
  if (!ws) return;
  fl.closeAll();
  state.editing = `new-group-${Date.now()}`;

  const section = document.createElement("section");
  section.className = "section is-creating";
  const head = document.createElement("div");
  head.className = "section-head";
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.placeholder = "New group name";
  head.append(input);
  section.append(head);
  el.groupsHost.prepend(section);
  input.focus();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    endEditing();
    const value = input.value.trim();
    section.remove();
    if (commit && value) apply(await send({ type: "createGroup", workspaceId: ws.id, name: value }));
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function startRenameWorkspace(ws, nameEl) {
  // Prefer the given element; otherwise edit the sidebar name, or fall back to
  // the header title when the workspace is active (e.g. sidebar collapsed).
  let target = nameEl
    || document.querySelector(`.space-item[data-workspace-id="${ws.id}"] .space-name`);
  if (!target && ws.id === state.root.activeWorkspaceId) target = el.wsName;
  if (!target) return;
  inlineEdit(target, ws.name, async (value) => {
    apply(await send({ type: "renameWorkspace", workspaceId: ws.id, name: value }));
  });
}
function startRenameGroup(workspaceId, group, nameEl) {
  inlineEdit(nameEl, group.name, async (value) => {
    apply(await send({ type: "renameGroup", workspaceId, groupId: group.id, name: value }));
  });
}
function startRenameTab(workspaceId, containerId, tab, titleEl) {
  inlineEdit(titleEl, tab.title || tab.url, async (value) => {
    apply(await send({ type: "renameTab", workspaceId, containerId, tabId: tab.id, title: value }));
  });
}

// --- Confirm popover (replaces confirm() for destructive actions only) -------

function confirmPopover(anchor, message, confirmLabel, onConfirm) {
  fl.openPopover({ anchor, align: "right" }, (box, close) => {
    box.classList.add("confirm");
    const p = document.createElement("p");
    p.textContent = message;
    const row = document.createElement("div");
    row.className = "confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.dataset.flAutofocus = "1";
    cancel.addEventListener("click", () => close());
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "danger-solid";
    ok.textContent = confirmLabel;
    ok.addEventListener("click", () => { close(); onConfirm(); });
    row.append(cancel, ok);
    box.append(p, row);
  });
}

function confirmDeleteWorkspace(anchor, ws) {
  const n = wsTabCount(ws);
  confirmPopover(anchor, `Delete “${ws.name}” and its ${n} saved tab${n === 1 ? "" : "s"}? Open browser tabs stay open.`,
    "Delete", async () => apply(await send({ type: "deleteWorkspace", workspaceId: ws.id })));
}
function confirmDeleteGroup(anchor, workspaceId, group) {
  confirmPopover(anchor, `Delete group “${group.name}” and its ${group.tabs.length} tab${group.tabs.length === 1 ? "" : "s"}?`,
    "Delete", async () => apply(await send({ type: "deleteGroup", workspaceId, groupId: group.id })));
}

// --- Actions -----------------------------------------------------------------

// Clicking a workspace switches to it, the way Workona does: the previous
// space's live tabs are autosaved and the chosen space's tabs open (reusing
// anything already open). We optimistically show the new space immediately so
// the UI feels instant, then reconcile with the authoritative result.
function selectWorkspace(workspaceId) {
  if (state.root.activeWorkspaceId === workspaceId) return;
  state.root.activeWorkspaceId = workspaceId;
  render();
  onSwitchWorkspace(workspaceId, { silent: true });
}

// Jumping to a workspace from search switches to it, just like the sidebar,
// so the active workspace and its browser tabs always stay in sync.
function viewWorkspace(workspaceId) {
  selectWorkspace(workspaceId);
}

async function onRecolor(ws) {
  const i = WORKSPACE_COLORS.indexOf(ws.color);
  const next = WORKSPACE_COLORS[(i + 1) % WORKSPACE_COLORS.length];
  apply(await send({ type: "setWorkspaceColor", workspaceId: ws.id, color: next }));
}

async function onSaveSession(asGroup) {
  const ws = activeWorkspace();
  el.saveSessionBtn.disabled = true;
  el.saveSessionBtn.classList.add("is-busy");
  const label = el.saveSessionBtn.textContent;
  el.saveSessionBtn.textContent = "Saving…";
  try {
    const res = await send({ type: "saveCurrentSession", workspaceId: ws ? ws.id : null, asGroup: Boolean(asGroup) });
    if (!res.ok) return toast(res.error || "Nothing to save.");
    apply(res);
    toast(`Saved ${res.saved} tab${res.saved === 1 ? "" : "s"}${asGroup ? " as a group" : ""}.`);
  } finally {
    el.saveSessionBtn.disabled = false;
    el.saveSessionBtn.classList.remove("is-busy");
    el.saveSessionBtn.textContent = label;
  }
}

async function onSaveSessionInto(workspaceId) {
  const res = await send({ type: "saveCurrentSession", workspaceId, asGroup: true });
  if (!res.ok) return toast(res.error || "Nothing to save.");
  apply(res);
  toast(`Saved ${res.saved} tab${res.saved === 1 ? "" : "s"} to this workspace.`);
}

// --- Export / Import (move workspaces between browsers) ----------------------

async function onExport() {
  const res = await send({ type: "exportData" });
  if (!res || !res.ok) return toast((res && res.error) || "Could not export.");
  const json = JSON.stringify(res.data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tab-workspaces-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = res.data.workspaces ? res.data.workspaces.length : 0;
  toast(`Exported ${count} workspace${count === 1 ? "" : "s"}.`);
}

async function onImportFileChosen(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = ""; // allow re-importing the same file later
  if (!file) return;

  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch (_e) {
    return toast("That file isn't valid JSON.");
  }
  const count = Array.isArray(payload.workspaces) ? payload.workspaces.length : 0;
  if (!count) return toast("No workspaces found in that file.");

  // Let the user choose how the imported workspaces combine with existing ones.
  promptImportMode(el.importBtn, count, (mode) => runImport(payload, mode));
}

function promptImportMode(anchor, count, onChoose) {
  fl.openPopover({ anchor, align: "left" }, (box, close) => {
    box.classList.add("confirm");
    const p = document.createElement("p");
    p.textContent = `Import ${count} workspace${count === 1 ? "" : "s"}?`;
    const row = document.createElement("div");
    row.className = "confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Cancel";
    cancel.dataset.flAutofocus = "1";
    cancel.addEventListener("click", () => close());

    const merge = document.createElement("button");
    merge.type = "button";
    merge.className = "secondary";
    merge.textContent = "Add to mine";
    merge.title = "Keep your current workspaces and add the imported ones";
    merge.addEventListener("click", () => { close(); onChoose("merge"); });

    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "danger-solid";
    replace.textContent = "Replace all";
    replace.title = "Remove your current workspaces and use only the imported ones";
    replace.addEventListener("click", () => { close(); onChoose("replace"); });

    row.append(cancel, merge, replace);
    box.append(p, row);
  });
}

async function runImport(payload, mode) {
  const res = await send({ type: "importData", payload, mode });
  if (!res || !res.ok) return toast((res && res.error) || "Could not import.");
  apply(res);
  toast(`Imported ${res.imported} workspace${res.imported === 1 ? "" : "s"}.`);
}

async function onRestore(newWindow, workspaceId) {
  const id = workspaceId || (activeWorkspace() && activeWorkspace().id);
  if (!id) return;
  const res = await send({ type: "restoreWorkspace", workspaceId: id, newWindow });
  if (!res.ok) return toast(res.error || "Nothing to open.");
  apply(res);
  toast(`Opened ${res.opened}${res.reused ? `, reused ${res.reused}` : ""} tab${res.opened === 1 ? "" : "s"}.`);
}

async function onOpenContainer(ws, containerId) {
  const container = containerId === "session"
    ? { tabs: ws.sessionTabs }
    : ws.groups.find((g) => g.id === containerId);
  if (!container || !container.tabs.length) return toast("Nothing to open.");
  let opened = 0;
  for (const tab of container.tabs) {
    const r = await send({ type: "openTab", url: tab.url });
    if (r.ok && !r.reused) opened += 1;
  }
  toast(`Opened ${opened} tab${opened === 1 ? "" : "s"}.`);
}

function onOpenTab(url) {
  send({ type: "openTab", url }).then((r) => {
    if (r && r.ok && r.reused) toast("Focused the open tab.");
  });
}
async function onRemoveTab(workspaceId, containerId, tabId) {
  apply(await send({ type: "removeTab", workspaceId, containerId, tabId }));
}
async function doMoveTab(fromWs, fromContainer, tabId, toWs, toContainer) {
  apply(await send({
    type: "moveTab",
    fromWorkspaceId: fromWs, fromContainerId: fromContainer, tabId,
    toWorkspaceId: toWs, toContainerId: toContainer
  }));
}
async function onSwitchWorkspace(workspaceId, { silent = false } = {}) {
  const res = await send({ type: "switchWorkspace", workspaceId });
  if (!res.ok) return toast(res.error || "Could not switch.");
  apply(res);
  if (silent && !res.opened && !res.reused) return; // nothing to announce
  const opened = res.opened
    ? `Opened ${res.opened}${res.reused ? `, reused ${res.reused}` : ""} tab${res.opened === 1 ? "" : "s"}`
    : (res.reused ? `${res.reused} tab${res.reused === 1 ? "" : "s"} already open` : "Switched workspace");
  toast(opened);
}

// --- Drag & drop -------------------------------------------------------------

function bindTabDrag(node, ws, containerId, tab) {
  node.addEventListener("dragstart", (e) => {
    fl.closeAll();
    preview.hide();
    state.drag = { tabId: tab.id, fromContainerId: containerId, fromWorkspaceId: ws.id };
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", tab.url); } catch (_e) {}
  });
  node.addEventListener("dragend", () => { node.classList.remove("dragging"); state.drag = null; clearDropHints(); });
  node.addEventListener("dragover", (e) => {
    if (!state.drag) return;
    e.preventDefault();
    const before = isBeforeMidpoint(e, node);
    node.classList.toggle("drop-before", before);
    node.classList.toggle("drop-after", !before);
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
  node.addEventListener("drop", (e) => {
    e.stopPropagation();
    const before = isBeforeMidpoint(e, node);
    onDropOnTab(ws.id, containerId, tab.id, before);
  });
}

function markDropContainer(sectionNode, workspaceId, containerId) {
  if (!sectionNode) return;
  sectionNode.addEventListener("dragover", (e) => {
    if (!state.drag) return;
    e.preventDefault();
    sectionNode.classList.add("drop-target");
  });
  sectionNode.addEventListener("dragleave", (e) => {
    if (!sectionNode.contains(e.relatedTarget)) sectionNode.classList.remove("drop-target");
  });
  sectionNode.addEventListener("drop", (e) => {
    sectionNode.classList.remove("drop-target");
    if (e.target.closest(".tab-row")) return;
    onDropOnContainer(workspaceId, containerId);
  });
}

function bindWorkspaceDrag(node, ws) {
  node.addEventListener("dragstart", (e) => {
    if (state.drag) return;
    fl.closeAll();
    preview.hide();
    state.wsDrag = { workspaceId: ws.id };
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  node.addEventListener("dragend", () => { node.classList.remove("dragging"); state.wsDrag = null; clearDropHints(); });
  node.addEventListener("dragover", (e) => {
    if (state.drag || state.wsDrag) { e.preventDefault(); node.classList.add("drag-over"); }
  });
  node.addEventListener("dragleave", () => node.classList.remove("drag-over"));
  node.addEventListener("drop", () => {
    node.classList.remove("drag-over");
    if (state.drag) onDropTabOnWorkspace(ws.id);
    else if (state.wsDrag) onDropWorkspaceReorder(ws.id);
  });
}

async function onDropOnTab(workspaceId, containerId, targetTabId, before) {
  const drag = state.drag;
  clearDropHints();
  if (!drag) return;
  const ws = activeWorkspace();
  const container = containerId === "session" ? { tabs: ws.sessionTabs } : ws.groups.find((g) => g.id === containerId);
  if (!container) return;

  let index = container.tabs.findIndex((t) => t.id === targetTabId);
  if (index < 0) index = container.tabs.length;
  const toIndex = before ? index : index + 1;

  if (drag.fromWorkspaceId === workspaceId && drag.fromContainerId === containerId) {
    const ids = container.tabs.map((t) => t.id);
    const from = ids.indexOf(drag.tabId);
    if (from === -1) return;
    ids.splice(from, 1);
    const adj = from < toIndex ? toIndex - 1 : toIndex;
    ids.splice(Math.max(0, Math.min(adj, ids.length)), 0, drag.tabId);
    apply(await send({ type: "reorderTabs", workspaceId, containerId, orderedIds: ids }));
    return;
  }
  apply(await send({
    type: "moveTab",
    fromWorkspaceId: drag.fromWorkspaceId, fromContainerId: drag.fromContainerId, tabId: drag.tabId,
    toWorkspaceId: workspaceId, toContainerId: containerId, toIndex
  }));
}

async function onDropOnContainer(workspaceId, containerId) {
  const drag = state.drag;
  clearDropHints();
  if (!drag) return;
  if (drag.fromWorkspaceId === workspaceId && drag.fromContainerId === containerId) return;
  apply(await send({
    type: "moveTab",
    fromWorkspaceId: drag.fromWorkspaceId, fromContainerId: drag.fromContainerId, tabId: drag.tabId,
    toWorkspaceId: workspaceId, toContainerId: containerId
  }));
}

async function onDropTabOnWorkspace(targetWorkspaceId) {
  const drag = state.drag;
  clearDropHints();
  if (!drag || drag.fromWorkspaceId === targetWorkspaceId) return;
  const targetWs = state.root.workspaces.find((w) => w.id === targetWorkspaceId);
  const toContainerId = targetWs && targetWs.groups[0] ? targetWs.groups[0].id : "session";
  apply(await send({
    type: "moveTab",
    fromWorkspaceId: drag.fromWorkspaceId, fromContainerId: drag.fromContainerId, tabId: drag.tabId,
    toWorkspaceId: targetWorkspaceId, toContainerId
  }));
}

async function onDropWorkspaceReorder(targetWorkspaceId) {
  const drag = state.wsDrag;
  clearDropHints();
  if (!drag || drag.workspaceId === targetWorkspaceId) return;
  const ids = state.root.workspaces.map((w) => w.id);
  const from = ids.indexOf(drag.workspaceId);
  const to = ids.indexOf(targetWorkspaceId);
  if (from === -1 || to === -1) return;
  ids.splice(from, 1);
  ids.splice(to, 0, drag.workspaceId);
  apply(await send({ type: "reorderWorkspaces", orderedIds: ids }));
}

// --- Search ------------------------------------------------------------------

function onSearchInput() {
  const q = el.searchInput.value.trim();
  state.searchQuery = q;
  state.searchResults = q ? searchLocal(q) : null;
  render();
}
function clearSearch() {
  state.searchQuery = "";
  state.searchResults = null;
  el.searchInput.value = "";
  render();
}

// --- Keyboard ----------------------------------------------------------------

function onKeydown(e) {
  const typing = /^(input|textarea|select)$/i.test(document.activeElement.tagName)
    || document.activeElement.isContentEditable;
  // Escape is handled inside floating.js when a layer is open; here we handle
  // search + input blur only.
  if (e.key === "Escape") {
    if (fl.isOpen()) return; // floating manager will close it
    if (state.searchQuery) { clearSearch(); return; }
    if (typing) document.activeElement.blur();
    return;
  }
  if (typing || fl.isOpen()) return;

  if (e.key === "/") { e.preventDefault(); el.searchInput.focus(); return; }
  if (e.key.toLowerCase() === "n") { e.preventDefault(); startCreateWorkspace(); return; }
  if (e.key.toLowerCase() === "s") { e.preventDefault(); onSaveSession(false); return; }
  if (/^[1-9]$/.test(e.key)) {
    const ws = state.root.workspaces[Number(e.key) - 1];
    if (ws) { e.preventDefault(); selectWorkspace(ws.id); }
    return;
  }
  if (e.key === "j" || e.key === "k") {
    const list = state.root.workspaces;
    const i = list.findIndex((w) => w.id === state.root.activeWorkspaceId);
    const next = e.key === "j" ? i + 1 : i - 1;
    if (list[next]) { e.preventDefault(); selectWorkspace(list[next].id); }
  }
}

// --- Shared plumbing ---------------------------------------------------------

function apply(res) {
  if (!res) return;
  if (!res.ok) return toast(res.error || "Something went wrong.");
  acceptState(res);
  render();
}

function setHeadEnabled(enabled) {
  el.restoreBtn.disabled = !enabled;
  el.wsMenuBtn.disabled = !enabled;
  el.addGroupBtn.disabled = !enabled;
  el.saveSessionBtn.disabled = false;
}

function emptyState({ icon, title, message, actionLabel, onAction, compact }) {
  const wrap = document.createElement("div");
  wrap.className = compact ? "empty compact" : "empty";
  if (icon) {
    const img = document.createElement("img");
    img.className = "empty-logo";
    img.src = "assets/logo.svg";
    img.alt = "";
    img.width = 44; img.height = 44;
    wrap.append(img);
  }
  if (title) { const h = document.createElement("h3"); h.textContent = title; wrap.append(h); }
  const p = document.createElement("p");
  p.textContent = message;
  wrap.append(p);
  if (actionLabel) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = actionLabel;
    b.addEventListener("click", () => onAction(b));
    wrap.append(b);
  }
  return wrap;
}

function skeletonList(rows) {
  const wrap = document.createElement("div");
  wrap.className = "skeleton";
  for (let i = 0; i < rows; i++) {
    const r = document.createElement("div");
    r.className = "skeleton-row";
    wrap.append(r);
  }
  return wrap;
}

function clearDropHints() {
  document.querySelectorAll(".drop-before, .drop-after, .drop-target, .drag-over")
    .forEach((n) => n.classList.remove("drop-before", "drop-after", "drop-target", "drag-over"));
}
function isBeforeMidpoint(e, node) {
  const rect = node.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2;
}

let toastTimer = null;
function toast(message) {
  let t = document.getElementById("toast");
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); t.hidden = true; }, 2400);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast("Copied URL."), () => toast("Couldn't copy."));
}

function faviconFor(tab) {
  if (tab.favIconUrl) return tab.favIconUrl;
  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", tab.url);
    url.searchParams.set("size", "32");
    return url.toString();
  } catch (_e) { return ""; }
}
function prettyUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch (_e) { return url; }
}
function debounce(fn, wait) {
  let t = null;
  return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
function cleanup() {
  preview.destroy();
  resetProgressiveRendering();
  if (toastTimer) clearTimeout(toastTimer);
}

function send(message) { return chrome.runtime.sendMessage(message); }
