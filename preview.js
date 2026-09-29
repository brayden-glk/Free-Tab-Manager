// preview.js
// One passive, reusable workspace hover preview. It is intentionally separate
// from floating.js: previews never take focus, trap keys, replace a real menu,
// or intercept pointer input.

const OPEN_DELAY = 350;
const CLOSE_DELAY = 100;
const MAX_TABS = 6;
const VIEWPORT_MARGIN = 8;
const GAP = 8;

let card = null;
let openTimer = null;
let closeTimer = null;
let pending = null;
let visibleWorkspaceId = null;

function ensureCard() {
  if (card) return card;
  card = document.createElement("aside");
  card.className = "workspace-preview";
  card.setAttribute("aria-hidden", "true");
  card.hidden = true;
  document.body.appendChild(card);

  window.addEventListener("resize", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("pagehide", destroy, { once: true });
  return card;
}

function clearOpenTimer() {
  if (openTimer) clearTimeout(openTimer);
  openTimer = null;
}

function clearCloseTimer() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
}

function summarizeTabs(workspace) {
  const entries = [];
  let total = 0;
  const collect = (tabs, groupName) => {
    total += tabs.length;
    if (entries.length >= MAX_TABS) return;
    for (const tab of tabs) {
      entries.push({ tab, groupName });
      if (entries.length >= MAX_TABS) break;
    }
  };
  collect(workspace.sessionTabs || [], "Open tabs");
  for (const group of workspace.groups || []) collect(group.tabs || [], group.name);
  return { entries, total };
}

function render(workspace, faviconFor) {
  const node = ensureCard();
  node.replaceChildren();

  const header = document.createElement("div");
  header.className = "workspace-preview-head";
  const dot = document.createElement("span");
  dot.className = "workspace-preview-dot";
  dot.style.background = workspace.color;
  const title = document.createElement("strong");
  title.textContent = workspace.name;
  const summary = summarizeTabs(workspace);
  const count = document.createElement("span");
  count.className = "workspace-preview-count";
  count.textContent = `${summary.total} tab${summary.total === 1 ? "" : "s"}`;
  header.append(dot, title, count);
  node.append(header);

  const list = document.createElement("div");
  list.className = "workspace-preview-list";

  if (!summary.total) {
    const empty = document.createElement("p");
    empty.className = "workspace-preview-empty";
    empty.textContent = "No tabs stored";
    list.append(empty);
  } else {
    for (const { tab, groupName } of summary.entries) {
      const row = document.createElement("div");
      row.className = "workspace-preview-row";
      const image = document.createElement("img");
      image.className = "workspace-preview-favicon";
      image.alt = "";
      image.width = 16;
      image.height = 16;
      image.loading = "lazy";
      image.decoding = "async";
      image.src = faviconFor(tab);
      image.addEventListener("error", () => { image.style.visibility = "hidden"; }, { once: true });
      const text = document.createElement("span");
      text.className = "workspace-preview-text";
      const tabTitle = document.createElement("span");
      tabTitle.className = "workspace-preview-title";
      tabTitle.textContent = tab.title || tab.url;
      const group = document.createElement("span");
      group.className = "workspace-preview-group";
      group.textContent = groupName;
      text.append(tabTitle, group);
      row.append(image, text);
      list.append(row);
    }
  }
  node.append(list);

  const hiddenCount = Math.max(0, summary.total - summary.entries.length);
  if (hiddenCount) {
    const more = document.createElement("div");
    more.className = "workspace-preview-more";
    more.textContent = `+${hiddenCount} more`;
    node.append(more);
  }
}

function position(anchor) {
  if (!card || card.hidden) return;
  const a = anchor.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = a.right + GAP;
  if (left + rect.width + VIEWPORT_MARGIN > vw) left = a.left - rect.width - GAP;
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - rect.width - VIEWPORT_MARGIN));

  let top = a.top - 6;
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - rect.height - VIEWPORT_MARGIN));
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

export function schedule({ anchor, workspace, faviconFor }) {
  clearOpenTimer();
  clearCloseTimer();
  pending = { anchor, workspace, faviconFor };

  if (visibleWorkspaceId === workspace.id && card && !card.hidden) {
    position(anchor);
    return;
  }

  openTimer = setTimeout(() => {
    openTimer = null;
    const request = pending;
    if (!request || !request.anchor.isConnected) return;
    render(request.workspace, request.faviconFor);
    card.hidden = false;
    visibleWorkspaceId = request.workspace.id;
    position(request.anchor);
  }, OPEN_DELAY);
}

export function scheduleHide() {
  clearOpenTimer();
  clearCloseTimer();
  closeTimer = setTimeout(hide, CLOSE_DELAY);
}

export function hide() {
  clearOpenTimer();
  clearCloseTimer();
  pending = null;
  visibleWorkspaceId = null;
  if (!card) return;
  card.hidden = true;
  card.replaceChildren();
}

export function destroy() {
  hide();
  if (card) card.remove();
  card = null;
}

export function isVisible() {
  return Boolean(card && !card.hidden);
}

export const config = Object.freeze({ OPEN_DELAY, CLOSE_DELAY, MAX_TABS });
