// Runs in EVERY frame (incl. cross-origin iframes). Finds the main <video>,
// reports local play/pause/seek/rate changes and applies remote ones.
(() => {
  if (window.__swVideo) return;
  window.__swVideo = true;

  const MIN_DURATION = 90; // seconds; shorter clips are treated as ads/previews
  const myId = Math.random().toString(36).slice(2);
  let active = false; // joined a room in this tab
  let enabled = true; // false when the user pinned a video in another frame
  let pinned = null; // manually picked <video> in this frame
  let video = null;
  let pending = null; // remote state received before a usable video existed
  let suppressUntil = 0;
  let scanTimer = null;
  const EVENTS = ["play", "pause", "seeked", "ratechange"];

  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  };
  const notify = (text) => send({ cmd: "notify", text });

  function* allVideos(root = document) {
    for (const v of root.querySelectorAll("video")) yield v;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) yield* allVideos(el.shadowRoot);
    }
  }

  function eligible(v) {
    if (v === pinned) return true;
    const d = v.duration;
    return !Number.isNaN(d) && (d >= MIN_DURATION || d === Infinity);
  }

  function pickVideo() {
    if (pinned && pinned.isConnected) return pinned;
    let best = null, bestScore = 0;
    for (const v of allVideos()) {
      if (!eligible(v)) continue;
      const r = v.getBoundingClientRect();
      const score = r.width * r.height;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  function onLocalEvent() {
    // YouTube plays ads in the same <video> element, so re-check eligibility
    // on every event: short clips (ads) must never be synced.
    if (!active || !enabled || Date.now() < suppressUntil || !video || !eligible(video)) return;
    const v = video;
    send({
      cmd: "send",
      payload: { type: "state", playing: !v.paused, time: v.currentTime, rate: v.playbackRate },
    });
  }

  function attach(v) {
    if (v === video) return;
    if (video) EVENTS.forEach((e) => video.removeEventListener(e, onLocalEvent));
    video = v;
    if (video) EVENTS.forEach((e) => video.addEventListener(e, onLocalEvent));
  }

  // `at` is when the state was received; used to compensate for waiting time.
  function apply(s, at = Date.now()) {
    if (!active || !enabled) return;
    const v = pickVideo();
    attach(v);
    if (!v || !eligible(v)) { pending = { s, at }; return; } // retry when a video shows up
    pending = null;
    suppressUntil = Date.now() + 900;
    let time = s.time;
    if (s.playing) time += ((Date.now() - at) / 1000) * s.rate;
    if (Math.abs(v.playbackRate - s.rate) > 0.01) v.playbackRate = s.rate;
    if (Math.abs(v.currentTime - time) > 0.7) v.currentTime = time;
    if (s.playing && v.paused) {
      v.play().catch((e) => {
        if (e.name === "NotAllowedError") notify("Browser blocked autoplay. Click the page once to allow playback.");
      });
    } else if (!s.playing && !v.paused) {
      v.pause();
    }
  }

  function rescan() {
    if (pending) return apply(pending.s, pending.at);
    attach(pickVideo());
  }

  function start() {
    if (active) return;
    active = true;
    document.documentElement?.setAttribute("data-sw-party", "1"); // read by content/fs-main.js
    refreshHover();
    rescan();
    scanTimer = setInterval(rescan, 1000);
    document.addEventListener("loadedmetadata", rescan, true);
  }

  function stop() {
    active = false;
    document.documentElement?.removeAttribute("data-sw-party");
    refreshHover();
    pending = null;
    clearInterval(scanTimer);
    document.removeEventListener("loadedmetadata", rescan, true);
    attach(null);
  }

  // Manual picker: next click on a video in any frame pins it.
  function pickMode() {
    const handler = (e) => {
      const hit = document.elementsFromPoint(e.clientX, e.clientY);
      let v = hit.find((el) => el.tagName === "VIDEO");
      if (!v) v = [...allVideos()].find((x) => {
        const r = x.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (!v) return; // click was in an empty area of this frame; keep listening
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      pinned = v;
      enabled = true;
      rescan();
      send({ cmd: "broadcast", msg: { evt: "pinned", fid: myId } });
      notify("Video selected.");
    };
    const cleanup = () => document.removeEventListener("click", handler, true);
    document.addEventListener("click", handler, true);
    setTimeout(cleanup, 15000);
  }

  // ---- Hover button -------------------------------------------------------
  // A round SyncWatch button appears in the top-right corner of a real video
  // while the mouse moves over it. One click starts a party and opens the chat.
  const HOVER_HIDE_MS = 2500;
  let hover = null; // { host, btn, toast }
  let hoverTimer = null;
  let toastTimer = null;
  let overBtn = false;
  let lastMove = 0;

  function ensureHover() {
    if (hover) return hover;
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .btn{position:fixed;display:none;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border-radius:50%;
        color:#fff;cursor:pointer;background:rgba(24,16,20,.5);border:1px solid rgba(255,255,255,.18);
        -webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);
        box-shadow:0 8px 24px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.1);transition:background .18s,transform .18s}
      .btn:hover{background:rgba(244,63,94,.85);transform:scale(1.06)}
      .btn.on{border-color:rgba(251,113,133,.9);box-shadow:0 0 0 3px rgba(244,63,94,.28),0 8px 24px rgba(0,0,0,.4)}
      .btn.show{display:flex}
      .toast{position:fixed;display:none;width:max-content;max-width:260px;padding:9px 12px;border-radius:12px;color:#fff;
        font:500 13px/1.4 system-ui,-apple-system,sans-serif;pointer-events:none;background:rgba(24,16,20,.6);
        border:1px solid rgba(255,255,255,.14);-webkit-backdrop-filter:blur(16px) saturate(1.6);backdrop-filter:blur(16px) saturate(1.6);
        box-shadow:0 8px 24px rgba(0,0,0,.4)}
      .toast.show{display:block}`;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.appendChild(swIcon("users-plus", 22));
    const toast = document.createElement("div");
    toast.className = "toast";
    root.append(style, btn, toast);

    // Keep the click away from the site's own player controls.
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) {
      btn.addEventListener(t, (e) => e.stopPropagation());
    }
    btn.addEventListener("mouseenter", () => { overBtn = true; clearTimeout(hoverTimer); });
    btn.addEventListener("mouseleave", () => { overBtn = false; hoverTimer = setTimeout(hideHover, HOVER_HIDE_MS); });
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (active) { send({ cmd: "broadcast", msg: { evt: "toggle-ui" } }); return; }
      showToast("Starting party…");
      let r = null;
      try { r = await chrome.runtime.sendMessage({ cmd: "quickstart" }); } catch {}
      if (!r?.ok) { showToast("Couldn't start the party."); return; }
      let copied = false;
      try { await navigator.clipboard.writeText(r.link); copied = true; } catch {}
      showToast(copied ? "Party started. Invite link copied!" : "Party started. Copy the invite link from the chat.");
    });
    hover = { host, btn, toast };
    return hover;
  }

  function mountHover() {
    if (!hover) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
    if (parent && hover.host.parentNode !== parent) parent.appendChild(hover.host);
  }
  document.addEventListener("fullscreenchange", mountHover);

  function refreshHover() {
    if (!hover) return;
    hover.btn.classList.toggle("on", active);
    hover.btn.title = active ? "SyncWatch: show or hide chat" : "SyncWatch: start a watch party";
    hover.btn.textContent = "";
    hover.btn.appendChild(swIcon(active ? "message-circle" : "users-plus", 22));
  }

  function showHover(v) {
    const h = ensureHover();
    mountHover();
    const r = v.getBoundingClientRect();
    const right = window.innerWidth - Math.min(r.right, window.innerWidth) + 12;
    const top = Math.max(r.top, 0) + 12;
    h.btn.style.right = right + "px";
    h.btn.style.top = top + "px";
    h.toast.style.right = right + "px";
    h.toast.style.top = top + 48 + "px";
    refreshHover();
    h.btn.classList.add("show");
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(hideHover, HOVER_HIDE_MS);
  }

  function hideHover() {
    if (overBtn || !hover) return;
    hover.btn.classList.remove("show");
  }

  function showToast(text) {
    if (!hover) return;
    hover.toast.textContent = text;
    hover.toast.classList.add("show");
    hover.btn.classList.add("show");
    clearTimeout(toastTimer);
    clearTimeout(hoverTimer);
    toastTimer = setTimeout(() => { hover.toast.classList.remove("show"); hideHover(); }, 3500);
  }

  // Video under the cursor, even when the site stacks overlays on top of it
  // (and when the <video> lives inside a shadow root).
  function videoAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === "VIDEO") return el;
      if (el.shadowRoot) {
        for (const v of el.shadowRoot.querySelectorAll("video")) {
          const r = v.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
        }
      }
    }
    return null;
  }

  window.addEventListener(
    "mousemove",
    (e) => {
      const now = Date.now();
      if (now - lastMove < 100) return;
      lastMove = now;
      if (document.fullscreenElement?.tagName === "VIDEO") return; // can't draw over it
      const v = videoAt(e.clientX, e.clientY);
      if (!v || !eligible(v)) return;
      const r = v.getBoundingClientRect();
      if (r.width >= 240 && r.height >= 135) showHover(v);
    },
    { capture: true, passive: true }
  );

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.evt) {
      case "joined":
        start();
        if (msg.state) apply(msg.state);
        break;
      case "state":
        apply(msg);
        break;
      case "left":
        stop();
        break;
      case "pick-mode":
        pickMode();
        break;
      case "pinned":
        if (msg.fid !== myId) { enabled = false; pinned = null; } else enabled = true;
        break;
    }
  });

  // Frame loaded after the room was joined (or page navigated): re-sync status.
  try {
    chrome.runtime.sendMessage({ cmd: "status" }).then((r) => { if (r?.active) start(); }).catch(() => {});
  } catch {}
})();
