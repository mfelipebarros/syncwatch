// Top frame only. Docks the chat (an extension-origin iframe, so site scripts
// and hotkeys can't see what's typed) flush against the right edge of the page.
// While open it reserves its width: the page is narrowed to the left of it, so
// the sidebar never covers anything. A subtle edge tab shows/hides it.
(() => {
  if (window.__swUI) return;
  window.__swUI = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);
  const PANEL_W = 340;

  let host = null, dock = null, tab = null, badge = null, tabIcon = null, frame = null;
  let open = true;
  let hidden = true; // whole overlay not shown (not in a party and not requested)
  let unread = 0;
  let building = null;
  let origWidth = null; // the page's own inline width on <html>, restored on collapse

  const CSS = `
    *{box-sizing:border-box}
    .dock{position:fixed;top:0;bottom:0;right:0;width:${PANEL_W}px;pointer-events:none;
      transition:transform .3s cubic-bezier(.22,.8,.3,1);will-change:transform}
    .dock.closed{transform:translateX(${PANEL_W}px)}
    .panel{position:absolute;inset:0;pointer-events:auto;overflow:hidden;
      background:rgba(24,16,20,.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);backdrop-filter:blur(22px) saturate(1.6);
      border-left:1px solid rgba(255,255,255,.12);box-shadow:-12px 0 40px rgba(0,0,0,.28)}
    iframe{width:100%;height:100%;border:0;background:transparent;color-scheme:light;display:block}
    .tab{position:absolute;left:-20px;top:50%;margin-top:-32px;width:20px;height:64px;padding:0;
      border:1px solid rgba(255,255,255,.1);border-right:0;border-radius:10px 0 0 10px;color:#fff;cursor:pointer;
      pointer-events:auto;display:flex;align-items:center;justify-content:center;opacity:.38;
      background:rgba(24,16,20,.55);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
      transition:opacity .2s,background .2s}
    .tab:hover{opacity:1;background:rgba(244,63,94,.72)}
    .badge{position:absolute;top:6px;left:5px;width:8px;height:8px;border-radius:50%;background:#fb7185;
      box-shadow:0 0 0 2px rgba(24,16,20,.85);display:none}
    .badge.show{display:block}`;

  // Reserve (or release) the sidebar's width: narrow <html> and tell the
  // fullscreen emulation (content/fs-main.js) how much room to leave.
  function applyReserve() {
    const de = document.documentElement;
    if (!de) return;
    const w = host && !hidden && open ? PANEL_W : 0;
    de.setAttribute("data-sw-reserve", String(w));
    if (w) {
      if (origWidth === null) origWidth = [de.style.getPropertyValue("width"), de.style.getPropertyPriority("width")];
      de.style.setProperty("width", `calc(100% - ${w}px)`, "important");
    } else if (origWidth !== null) {
      de.style.removeProperty("width");
      if (origWidth[0]) de.style.setProperty("width", origWidth[0], origWidth[1]);
      origWidth = null;
    }
    // keep the dock left of a classic (non-overlay) page scrollbar
    if (dock) dock.style.right = Math.max(0, window.innerWidth - de.clientWidth) + "px";
  }

  function renderTab() {
    tabIcon.textContent = "";
    tabIcon.appendChild(swIcon(open ? "chevron-right" : "chevron-left", 14));
    badge.classList.toggle("show", !open && unread > 0);
    tab.title = open ? "Hide chat" : unread ? `Show chat (${unread} new)` : "Show chat";
  }

  function setOpen(v) {
    open = v;
    if (v) unread = 0;
    dock.classList.toggle("closed", !v);
    renderTab();
    applyReserve();
    try { chrome.storage.local.set({ swOpen: v }); } catch {}
  }

  async function build() {
    if (host) return true;
    if (building) return building;
    building = (async () => {
      const st = await send({ cmd: "status" });
      if (!st) return false;
      const saved = await chrome.storage.local.get("swOpen").catch(() => ({}));
      open = saved.swOpen !== false;

      host = document.createElement("div");
      host.style.cssText = "all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;

      dock = document.createElement("div");
      dock.className = "dock";
      const panel = document.createElement("div");
      panel.className = "panel";
      frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("chat/chat.html") + "?tab=" + st.tabId;
      frame.allow = "clipboard-write";
      panel.appendChild(frame);

      tab = document.createElement("button");
      tab.className = "tab";
      tabIcon = document.createElement("span");
      tabIcon.style.cssText = "display:grid;place-items:center";
      badge = document.createElement("span");
      badge.className = "badge";
      tab.append(tabIcon, badge);
      tab.addEventListener("click", () => setOpen(!open));

      dock.append(panel, tab);
      root.append(style, dock);
      dock.classList.toggle("closed", !open);
      renderTab();
      document.documentElement.appendChild(host);
      window.addEventListener("resize", applyReserve);
      return true;
    })();
    const ok = await building;
    building = null;
    return ok;
  }

  async function show(forceOpen) {
    if (!(await build())) return;
    host.style.display = "block";
    hidden = false;
    if (forceOpen !== undefined) setOpen(forceOpen);
    else applyReserve();
  }

  function hide() {
    hidden = true;
    if (host) host.style.display = "none";
    applyReserve();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.evt) {
      case "joined":
        // Reconnects also send "joined"; only pop the chat open the first time.
        if (hidden) show(true);
        break;
      case "left":
        hide();
        break;
      case "toggle-ui":
        if (hidden) show(true);
        else setOpen(!open);
        break;
      case "ui":
        if (msg.hide) hide();
        else if (msg.open !== undefined && host) setOpen(msg.open);
        break;
      case "chat":
        if (host && !hidden && !open && !msg.system) { unread++; renderTab(); }
        break;
    }
  });

  // Already in a party (page reload, or invite auto-join finished first).
  send({ cmd: "status" }).then((st) => { if (st?.active) show(); });
})();
