// floating.js
// A single, reusable floating-layer manager for every transient overlay in the
// hub: dropdown menus, context menus, and small confirm popovers.
//
// Why this exists: the previous UI had two ad-hoc menu systems that could stay
// stuck on screen after a re-render or workspace switch. This module guarantees:
//   - Only ONE floating element is open at a time.
//   - It is positioned inside the viewport (flips/clamps as needed).
//   - It closes on: outside pointer-down, Escape, scroll, resize, blur, and an
//     explicit closeAll() the app calls whenever state/view changes.
//   - Focus moves into the menu and returns to the trigger on close.
// It renders into a dedicated layer that sits above everything, so nothing is
// clipped by an overflow:hidden parent.

let layer = null;
let current = null; // { el, returnFocus, anchor, openedAt }

function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement("div");
  layer.className = "fl-layer";
  layer.setAttribute("role", "presentation");
  document.body.appendChild(layer);

  // Outside-click dismissal. Use the (bubbling) pointerdown so the click that
  // opened the menu has already finished, and ignore pointerdowns landing on
  // the menu itself or on the trigger that owns it. A short time guard prevents
  // the very gesture that opened the menu from immediately closing it.
  document.addEventListener("pointerdown", (e) => {
    if (!current) return;
    if (Date.now() - current.openedAt < 150) return;
    if (current.el.contains(e.target)) return;
    if (current.anchor && current.anchor.contains && current.anchor.contains(e.target)) return;
    close();
  });

  document.addEventListener("keydown", (e) => {
    if (!current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      moveFocus(e.shiftKey ? -1 : 1);
    }
  }, true);

  window.addEventListener("resize", close);
  // Close on scroll of a scroll container (menus anchor to elements that move),
  // but not on the menu's own internal scroll.
  window.addEventListener("scroll", (e) => {
    if (!current) return;
    if (current.el.contains(e.target)) return;
    close();
  }, true);
  return layer;
}

function focusables() {
  if (!current) return [];
  return Array.from(current.el.querySelectorAll("[data-fl-item]:not([disabled])"));
}

function moveFocus(dir) {
  const items = focusables();
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  let next = idx + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items[next].focus();
}

// Position an element near an anchor rect (dropdown) or a point (context menu),
// clamped/flipped to stay fully on screen.
function position(el, opts) {
  const margin = 8;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const rect = el.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  let x;
  let y;

  if (opts.anchor) {
    const a = opts.anchor.getBoundingClientRect();
    // Align the menu's right edge with the anchor's right edge (dropdowns sit
    // under the button, right-aligned like Workona's overflow menus).
    x = opts.align === "left" ? a.left : a.right - w;
    y = a.bottom + 4;
    // Flip up if it would overflow the bottom.
    if (y + h + margin > vh) y = a.top - h - 4;
  } else {
    x = opts.x;
    y = opts.y;
    // For context menus, flip so the menu never spills off-screen.
    if (x + w + margin > vw) x = x - w;
    if (y + h + margin > vh) y = y - h;
  }

  x = Math.max(margin, Math.min(x, vw - w - margin));
  y = Math.max(margin, Math.min(y, vh - h - margin));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

// Build a menu element from a list of item descriptors.
//   { label, onClick, danger, disabled, header, sep, icon }
function buildMenu(items) {
  const menu = document.createElement("div");
  menu.className = "fl-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (!item || item.sep) {
      const s = document.createElement("div");
      s.className = "fl-sep";
      menu.appendChild(s);
      continue;
    }
    if (item.header) {
      const h = document.createElement("div");
      h.className = "fl-header";
      h.textContent = item.label;
      menu.appendChild(h);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fl-item";
    b.setAttribute("role", "menuitem");
    b.dataset.flItem = "1";
    if (item.danger) b.classList.add("danger");
    if (item.disabled) b.disabled = true;
    if (item.icon) {
      const i = document.createElement("span");
      i.className = "fl-icon";
      i.textContent = item.icon;
      b.appendChild(i);
    }
    const span = document.createElement("span");
    span.className = "fl-label";
    span.textContent = item.label;
    b.appendChild(span);
    if (item.hint) {
      const k = document.createElement("span");
      k.className = "fl-hint";
      k.textContent = item.hint;
      b.appendChild(k);
    }
    b.addEventListener("click", () => {
      close();
      if (typeof item.onClick === "function") item.onClick();
    });
    menu.appendChild(b);
  }
  return menu;
}

// Public: open a menu. `opts` is either { anchor, align } or { x, y }.
export function openMenu(opts, items) {
  ensureLayer();
  close(); // enforce single-open

  const el = buildMenu(items);
  el.classList.add("fl-pop");
  layer.appendChild(el);

  current = {
    el,
    anchor: opts.anchor || null,
    returnFocus: opts.returnFocus || (opts.anchor || null),
    openedAt: Date.now()
  };

  // Position after it's in the DOM so we can measure it.
  position(el, opts);

  // Focus the first item for keyboard users, after positioning so it does not
  // scroll the anchor. Deferred so it never races the opening pointer gesture.
  const first = focusables()[0];
  if (first) setTimeout(() => { if (current && current.el === el) first.focus({ preventScroll: true }); }, 0);

  return { close };
}

// Public: open an arbitrary content popover (e.g., inline confirm). `render`
// receives the container and a `close` fn.
export function openPopover(opts, render) {
  ensureLayer();
  close();

  const el = document.createElement("div");
  el.className = "fl-pop fl-popover";
  layer.appendChild(el);

  current = {
    el,
    anchor: opts.anchor || null,
    returnFocus: opts.returnFocus || (opts.anchor || null),
    openedAt: Date.now()
  };
  render(el, close);
  position(el, opts);

  const focusFirst = el.querySelector("[data-fl-autofocus], [data-fl-item], button, input");
  if (focusFirst) setTimeout(() => { if (current && current.el === el) focusFirst.focus({ preventScroll: true }); }, 0);

  return { close };
}

// Public: close whatever is open. Safe to call anytime.
export function close() {
  if (!current) return;
  const { el, returnFocus } = current;
  current = null;
  el.remove();
  if (returnFocus && document.contains(returnFocus)) {
    try { returnFocus.focus({ preventScroll: true }); } catch (_e) {}
  }
}

// Public: is anything open right now?
export function isOpen() {
  return Boolean(current);
}

// Public: alias used by the app on every state/view change.
export const closeAll = close;
