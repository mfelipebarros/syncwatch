// Top frame only. The movable miniatures for voice/video.
//
// The video itself is drawn by the click-through "stage" iframe (stage/stage.js).
// This script draws, on the page, ONE interactive container on top of it that
// holds a frame for every participant whose camera is on: drag it anywhere on
// screen, resize it from the corner, and use the mic/camera buttons that appear
// on your own tile. With several cameras on, the tiles are grouped in a grid
// inside that same container. People with the camera off get no tile at all.
// It tells the stage where each tile is.
(() => {
  if (window.__swMedia) return;
  window.__swMedia = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);
  const ASPECT = 16 / 9;
  const DEF_W = 208, MIN_W = 140, MAX_W = 640, GAP = 6, PAD = 6, EDGE = 12;

  let host = null, layer = null, frame = null, stageWin = null;
  let roster = [];
  let blocked = false;
  const els = new Map(); // id -> { el, label, micBtn, camBtn, banner }
  // The one container: x/y/w are its position and width; el/grip/pill are its DOM.
  const group = { x: 0, y: 0, w: 0, h: 0, z: 1, placed: false, el: null, grip: null, pill: null };
  let raf = 0;
  let savedW = 0; // last width the user chose

  const CSS = `
    *{box-sizing:border-box}
    .layer{position:fixed;inset:0;pointer-events:none}
    .group{position:fixed;display:none;pointer-events:auto;border-radius:14px;cursor:grab;touch-action:none;user-select:none}
    /* No background or backdrop-filter here: the video is drawn by the stage iframe BENEATH
       this container, so anything that tints or blurs the backdrop would blur the cameras. */
    .group.multi{border-radius:18px;border:1px solid rgba(255,255,255,.22);box-shadow:0 14px 40px rgba(0,0,0,.45),inset 0 0 0 1px rgba(24,16,20,.35)}
    .group.drag{cursor:grabbing}
    .tile{position:absolute;border-radius:12px;border:1px solid rgba(255,255,255,.2)}
    .group:not(.multi) .tile{border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
    .name{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 44px);display:flex;align-items:center;gap:5px;padding:3px 9px 3px 7px;border-radius:999px;
      font:500 11.5px/1.4 system-ui,-apple-system,sans-serif;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      background:rgba(24,16,20,.55);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
    .name .m{display:none;color:#fb7185}
    .tile.muted .name .m{display:inline-flex}
    .bar{position:absolute;top:8px;right:8px;display:flex;gap:6px;opacity:0;transition:opacity .15s}
    .tile:hover .bar{opacity:1}
    .btn{width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,.16);border-radius:50%;color:#fff;cursor:pointer;display:grid;place-items:center;
      background:rgba(24,16,20,.6);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
    .btn:hover{background:rgba(244,63,94,.85)}
    .btn.off{background:rgba(244,63,94,.9);border-color:transparent}
    .grip{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;opacity:0;transition:opacity .15s;
      background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.8) 50%,rgba(255,255,255,.8) 58%,transparent 58%,transparent 70%,rgba(255,255,255,.8) 70%,rgba(255,255,255,.8) 78%,transparent 78%)}
    .group:hover .grip{opacity:1}
    .banner{position:absolute;left:8px;right:8px;top:8px;padding:5px 9px;border:0;border-radius:10px;cursor:pointer;color:#fff;
      font:600 11.5px/1.3 system-ui,sans-serif;background:rgba(244,63,94,.92);display:none}
    .banner.show{display:block}
    .pill{position:fixed;display:none;pointer-events:auto;padding:8px 14px;border:0;border-radius:999px;cursor:pointer;color:#fff;
      font:600 12.5px/1.3 system-ui,sans-serif;background:rgba(244,63,94,.92);box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .pill.show{display:block}`;

  function vw() { return document.documentElement.clientWidth || window.innerWidth; }
  function vh() { return window.innerHeight; }
  const reserve = () => Number(document.documentElement.getAttribute("data-sw-reserve")) || 0;
  const visible = () => roster.filter((r) => r.cam); // camera on = has a tile

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;

    // The stage covers the viewport and ignores the mouse.
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    frame = document.createElement("iframe");
    send({ cmd: "status" }).then((st) => {
      frame.src = chrome.runtime.getURL("stage/stage.html") + "?tab=" + (st?.tabId ?? "");
    });
    frame.allow = "camera; microphone; autoplay";
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:light;pointer-events:none;";
    frame.addEventListener("load", () => { stageWin = frame.contentWindow; postLayout(); });
    wrap.appendChild(frame);

    layer = document.createElement("div");
    layer.className = "layer";

    group.el = document.createElement("div");
    group.el.className = "group";
    group.grip = document.createElement("div");
    group.grip.className = "grip";
    group.el.appendChild(group.grip);
    wireGroup();

    group.pill = document.createElement("button");
    group.pill.className = "pill";
    group.pill.textContent = "Click to hear audio";
    group.pill.addEventListener("click", unmute);

    layer.append(group.el, group.pill);
    root.append(style, wrap, layer);
    document.documentElement.appendChild(host);
    window.addEventListener("resize", schedule);
  }

  function destroy() {
    if (host) host.remove();
    document.documentElement.removeAttribute("data-sw-tiles");
    host = layer = frame = stageWin = null;
    els.clear();
    Object.assign(group, { placed: false, el: null, grip: null, pill: null });
  }

  function unmute() {
    try { stageWin && stageWin.postMessage({ sw: "stage-unmute" }, "*"); } catch {}
  }

  // ---- layout -----------------------------------------------------------

  // Grid for n tiles inside a container of width w: one column up to 3 tiles,
  // two columns from 4. A lone tile fills the container without padding.
  function metrics(n, w) {
    const cols = n >= 4 ? 2 : 1;
    if (cols === 2) w = Math.max(w, 340); // two columns need room or the tiles get tiny
    const rows = Math.max(1, Math.ceil(n / cols));
    const pad = n > 1 ? PAD : 0;
    const tw = n <= 1 ? w : Math.floor((w - 2 * pad - (cols - 1) * GAP) / cols);
    const th = Math.round(tw / ASPECT);
    const h = n <= 1 ? th : rows * th + (rows - 1) * GAP + 2 * pad;
    return { cols, rows, pad, tw, th, w, h };
  }

  function clampGroup(m) {
    group.x = Math.min(Math.max(group.x, 0), Math.max(0, vw() - m.w));
    group.y = Math.min(Math.max(group.y, 0), Math.max(0, vh() - m.h));
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; applyLayout(); postLayout(); });
  }

  function tileRects(list, m) {
    return list.map((r, i) => ({
      id: r.id,
      x: m.pad + (i % m.cols) * (m.tw + GAP),
      y: m.pad + Math.floor(i / m.cols) * (m.th + GAP),
      w: m.tw,
      h: m.th,
    }));
  }

  function applyLayout() {
    if (!group.el) return;
    const list = visible();
    updatePill(list);
    if (!list.length) { group.el.style.display = "none"; return; }
    const m = metrics(list.length, group.w);
    clampGroup(m);
    group.h = m.h;
    Object.assign(group.el.style, {
      display: "block", left: group.x + "px", top: group.y + "px", width: m.w + "px", height: m.h + "px", zIndex: String(group.z),
    });
    group.el.classList.toggle("multi", list.length > 1);
    for (const t of tileRects(list, m)) {
      const e = els.get(t.id);
      if (e) Object.assign(e.el.style, { left: t.x + "px", top: t.y + "px", width: t.w + "px", height: t.h + "px" });
    }
  }

  function postLayout() {
    if (!stageWin || !group.el) return;
    const list = visible();
    const m = metrics(list.length, group.w);
    const tiles = list.length
      ? tileRects(list, m).map((t) => ({ id: t.id, x: group.x + t.x, y: group.y + t.y, w: t.w, h: t.h, z: group.z }))
      : [];
    try { stageWin.postMessage({ sw: "stage-layout", tiles }, "*"); } catch {}
  }

  // "Click to hear audio" has no tile to sit on when nobody has a camera on.
  function updatePill(list) {
    if (!group.pill) return;
    const remoteShown = list.some((r) => !r.self);
    group.pill.classList.toggle("show", blocked && !remoteShown);
    group.pill.style.right = reserve() + EDGE + 20 + "px";
    group.pill.style.bottom = EDGE + 20 + "px";
  }

  // ---- container: drag + resize ------------------------------------------

  function wireGroup() {
    const el = group.el;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target === group.grip) return;
      group.z += 1;
      const sx = e.clientX - group.x, sy = e.clientY - group.y;
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add("drag");
      const move = (ev) => { group.x = ev.clientX - sx; group.y = ev.clientY - sy; schedule(); };
      const up = () => {
        el.classList.remove("drag");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      schedule();
      e.preventDefault();
    });

    group.grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const startW = group.w, startX = e.clientX;
      try { group.grip.setPointerCapture(e.pointerId); } catch {}
      const move = (ev) => {
        group.w = Math.min(MAX_W, Math.max(MIN_W, startW + (ev.clientX - startX)));
        schedule();
      };
      const up = () => {
        group.grip.removeEventListener("pointermove", move);
        group.grip.removeEventListener("pointerup", up);
        group.grip.removeEventListener("pointercancel", up);
        savedW = group.w;
        try { chrome.storage.local.set({ swTileW: group.w }); } catch {}
      };
      group.grip.addEventListener("pointermove", move);
      group.grip.addEventListener("pointerup", up);
      group.grip.addEventListener("pointercancel", up);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ---- tiles --------------------------------------------------------------

  function iconBtn(name, title) {
    const b = document.createElement("button");
    b.className = "btn";
    b.title = title;
    b.appendChild(swIcon(name, 16));
    return b;
  }

  function setIcon(btn, name) {
    btn.textContent = "";
    btn.appendChild(swIcon(name, 16));
  }

  function makeTile(r) {
    const el = document.createElement("div");
    el.className = "tile";
    const name = document.createElement("div");
    name.className = "name";
    const mutedIcon = document.createElement("span");
    mutedIcon.className = "m";
    mutedIcon.appendChild(swIcon("microphone-off", 13));
    const label = document.createElement("span");
    name.append(mutedIcon, label);

    const bar = document.createElement("div");
    bar.className = "bar";
    let micBtn = null, camBtn = null;
    if (r.self) {
      micBtn = iconBtn("microphone", "Mute / unmute");
      camBtn = iconBtn("video", "Turn camera off");
      bar.append(micBtn, camBtn);
      micBtn.addEventListener("click", () => send({ cmd: "broadcast", msg: { evt: "media-cmd", mic: !(roster.find((x) => x.self)?.mic) } }));
      camBtn.addEventListener("click", () => send({ cmd: "broadcast", msg: { evt: "media-cmd", cam: false } }));
      for (const b of [micBtn, camBtn]) b.addEventListener("pointerdown", (e) => e.stopPropagation());
    }

    const banner = document.createElement("button");
    banner.className = "banner";
    banner.textContent = "Click to hear audio";
    banner.addEventListener("pointerdown", (e) => e.stopPropagation());
    banner.addEventListener("click", unmute);

    el.append(name, bar, banner);
    group.el.insertBefore(el, group.grip);
    return { el, label, micBtn, camBtn, banner };
  }

  function render() {
    build(); // the stage stays up even with no tiles, so incoming calls can be answered
    const list = visible();
    // content/fs-main.js emulates fullscreen whenever something of ours must stay on screen
    document.documentElement.setAttribute("data-sw-tiles", list.length ? "1" : "0");
    const shown = new Set(list.map((r) => r.id));
    for (const [id, e] of els) {
      if (!shown.has(id)) { e.el.remove(); els.delete(id); }
    }
    if (!list.length) {
      group.placed = false; // next time a camera comes on, start from the default corner again
      group.h = 0;
    } else if (group.placed && group.h) {
      // The container grows/shrinks as cameras come and go: keep its bottom edge
      // where it was if it sits in the lower half of the screen, else its top.
      const nh = metrics(list.length, group.w).h;
      if (nh !== group.h && group.y + group.h / 2 > vh() / 2) group.y -= nh - group.h;
    } else if (!group.placed) {
      group.w = savedW || DEF_W;
      const m = metrics(list.length, group.w);
      group.x = vw() - reserve() - m.w - EDGE - 20;
      group.y = vh() - m.h - EDGE - 20;
      group.placed = true;
    }
    for (const r of list) {
      let e = els.get(r.id);
      if (!e) { e = makeTile(r); els.set(r.id, e); }
      e.label.textContent = r.self ? `${r.name} (you)` : r.name;
      e.el.classList.toggle("muted", !r.mic);
      if (r.self) {
        setIcon(e.micBtn, r.mic ? "microphone" : "microphone-off");
        e.micBtn.classList.toggle("off", !r.mic);
      }
      e.banner.classList.toggle("show", blocked && !r.self);
    }
    schedule();
  }

  chrome.storage.local.get("swTileW").then((v) => {
    if (v.swTileW >= MIN_W && v.swTileW <= MAX_W) savedW = v.swTileW;
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.evt) {
      case "joined":
        build();
        break;
      case "rtc-roster":
        roster = msg.roster || [];
        blocked = !!msg.blocked;
        render();
        break;
      case "left":
        roster = [];
        destroy();
        break;
    }
  });

  // The stage must exist whenever we are in a party so incoming calls can be
  // answered even if this user never turns on a mic or camera.
  send({ cmd: "status" }).then((st) => { if (st?.active) build(); });
})();
