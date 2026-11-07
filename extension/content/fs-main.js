// Runs in the PAGE's own JS world (manifest "world": "MAIN") so it can wrap the
// fullscreen API before the site calls it.
//
// Why: Chrome forces a fullscreen element to cover the whole screen, and no page
// CSS can override that, so a chat sidebar could never sit beside the video.
// While a party is active and the chat is open we emulate it instead: the page
// really goes fullscreen, but the element the site asked for is only stretched
// over the area left of the sidebar. Outside a party, or with the chat hidden,
// every call passes straight through to the browser.
//
// Flags are shared with the isolated content scripts through <html> attributes:
//   data-sw-party="1"     this frame is in a party (set by content/video.js)
//   data-sw-reserve="340" px the sidebar occupies (set by content/ui.js, top frame)
(() => {
  if (window.__swFs) return;
  window.__swFs = true;

  const DOC = Document.prototype;
  const EL = Element.prototype;
  const isTop = window.top === window;
  const root = () => document.documentElement;
  const partyOn = () => root()?.getAttribute("data-sw-party") === "1";
  const reserve = () => Number(root()?.getAttribute("data-sw-reserve")) || 0;
  // Emulate only when something of ours has to stay visible in fullscreen: the open chat
  // dock, or camera tiles (they live on the page, which native fullscreen would hide).
  const wantOverlay = () => reserve() > 0 || root()?.getAttribute("data-sw-tiles") === "1";

  const origReq = EL.requestFullscreen || EL.webkitRequestFullscreen;
  const origExit = DOC.exitFullscreen || DOC.webkitExitFullscreen;
  if (!origReq || !origExit) return;

  // Original getters, captured before we wrap them.
  const orig = {};
  const ELEMENT_PROPS = ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement"];
  const FLAG_PROPS = ["fullscreen", "webkitIsFullScreen", "webkitFullscreen"];
  for (const n of [...ELEMENT_PROPS, ...FLAG_PROPS]) orig[n] = Object.getOwnPropertyDescriptor(DOC, n);
  const realFsEl = () => (orig.fullscreenElement || orig.webkitFullscreenElement)?.get.call(document) ?? null;

  // pseudo = { el, saved: [[node, styleAttr]], child: Window|null }
  let pseudo = null;

  const FIX = (w) =>
    "position:fixed!important;top:0!important;left:0!important;right:auto!important;bottom:auto!important;" +
    `width:calc(100vw - ${w}px)!important;height:100vh!important;max-width:none!important;max-height:none!important;` +
    "min-width:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;" +
    "z-index:2147483646!important;background:#000!important;transform:none!important;box-sizing:border-box!important;";

  function stretch(el, w, saved) {
    saved.push([el, el.getAttribute("style")]);
    el.style.cssText += ";" + FIX(w);
    if (el.tagName === "VIDEO") el.style.setProperty("object-fit", "contain", "important");
    // position:fixed is relative to the nearest transformed/filtered ancestor.
    for (let p = el.parentElement; p && p !== root(); p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (
        cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" ||
        (cs.contain && cs.contain !== "none") || /transform|filter|perspective/.test(cs.willChange) ||
        (cs.backdropFilter && cs.backdropFilter !== "none")
      ) {
        saved.push([p, p.getAttribute("style")]);
        p.style.cssText += ";transform:none!important;filter:none!important;perspective:none!important;contain:none!important;will-change:auto!important;backdrop-filter:none!important";
      }
    }
  }

  function restore(saved) {
    for (const [n, s] of saved.slice().reverse()) {
      if (s == null) n.removeAttribute("style");
      else n.setAttribute("style", s);
    }
  }

  const fireChange = () => {
    for (const t of ["fullscreenchange", "webkitfullscreenchange"]) {
      document.dispatchEvent(new Event(t, { bubbles: true }));
    }
  };

  function endPseudo(notifyChild) {
    if (!pseudo) return;
    const p = pseudo;
    pseudo = null;
    restore(p.saved);
    if (notifyChild && p.child) { try { p.child.postMessage({ sw: "fs-end" }, "*"); } catch {} }
  }

  // The chat was opened/collapsed while emulating: resize the stretched element.
  let watching = false;
  function watchReserve() {
    if (watching || !root()) return;
    watching = true;
    new MutationObserver(() => {
      if (pseudo && isTop) pseudo.el.style.setProperty("width", `calc(100vw - ${reserve()}px)`, "important");
    }).observe(root(), { attributes: true, attributeFilter: ["data-sw-reserve"] });
  }

  // ---- wrapped API --------------------------------------------------------

  async function enterTop(el) {
    endPseudo(true);
    const saved = [];
    pseudo = { el, saved, child: null };
    stretch(el, reserve(), saved);
    watchReserve();
    try {
      if (!realFsEl()) await origReq.call(root(), { navigationUI: "hide" });
      else fireChange();
    } catch (err) {
      endPseudo(false);
      throw err;
    }
  }

  // The element lives in an iframe: ask the top frame to stretch the iframe and
  // go fullscreen, then fill our own viewport.
  function enterInner(el) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        removeEventListener("message", onMsg);
        if (ok) {
          endPseudo(false);
          const saved = [];
          pseudo = { el, saved, child: null };
          stretch(el, 0, saved);
          fireChange();
          resolve();
        } else {
          origReq.call(el).then(resolve, reject); // top frame declined: native behaviour
        }
      };
      const onMsg = (e) => {
        if (e.source === parent && e.data && e.data.sw === "fs-reply" && e.data.id === id) finish(e.data.ok);
      };
      const timer = setTimeout(() => finish(false), 700);
      addEventListener("message", onMsg);
      parent.postMessage({ sw: "fs-enter", id }, "*");
    });
  }

  function patchedRequest(...args) {
    try {
      if (this !== root() && partyOn() && (!isTop || wantOverlay())) {
        return isTop ? enterTop(this) : enterInner(this);
      }
    } catch {}
    return origReq.apply(this, args);
  }

  function patchedExit(...args) {
    if (!pseudo) return origExit.apply(this, args);
    if (isTop) {
      const wasReal = !!realFsEl();
      endPseudo(true);
      return wasReal ? origExit.call(document) : Promise.resolve();
    }
    endPseudo(false);
    try { parent.postMessage({ sw: "fs-exit" }, "*"); } catch {}
    fireChange();
    return Promise.resolve();
  }

  const def = (obj, name, value) => Object.defineProperty(obj, name, { value, writable: true, configurable: true });
  def(EL, "requestFullscreen", patchedRequest);
  if (EL.webkitRequestFullscreen) def(EL, "webkitRequestFullscreen", patchedRequest);
  def(DOC, "exitFullscreen", patchedExit);
  if (DOC.webkitExitFullscreen) def(DOC, "webkitExitFullscreen", patchedExit);

  for (const n of ELEMENT_PROPS) {
    const d = orig[n];
    if (d?.get) Object.defineProperty(DOC, n, { ...d, get() { return pseudo && pseudo.el.isConnected ? pseudo.el : d.get.call(this); } });
  }
  for (const n of FLAG_PROPS) {
    const d = orig[n];
    if (d?.get) Object.defineProperty(DOC, n, { ...d, get() { return pseudo ? true : d.get.call(this); } });
  }

  // Esc (or the browser) left real fullscreen: undo the emulation BEFORE site
  // listeners run (this capture listener is registered first, at document_start).
  document.addEventListener("fullscreenchange", () => {
    if (isTop && pseudo && !realFsEl()) endPseudo(true);
  }, true);

  addEventListener("pagehide", () => endPseudo(false));

  // ---- cross-frame messages ----------------------------------------------
  addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.sw !== "string") return;

    if (isTop && d.sw === "fs-enter") {
      const reply = (ok) => { try { e.source.postMessage({ sw: "fs-reply", id: d.id, ok }, "*"); } catch {} };
      const iframe = [...document.querySelectorAll("iframe,frame")].find((f) => f.contentWindow === e.source);
      const w = reserve();
      if (!iframe || !partyOn() || !wantOverlay()) return reply(false);
      endPseudo(true);
      const saved = [];
      pseudo = { el: iframe, saved, child: e.source };
      stretch(iframe, w, saved);
      watchReserve();
      try {
        if (!realFsEl()) await origReq.call(root(), { navigationUI: "hide" });
        reply(true);
      } catch {
        endPseudo(false);
        reply(false);
      }
    } else if (isTop && d.sw === "fs-exit") {
      if (pseudo && pseudo.child === e.source) {
        const wasReal = !!realFsEl();
        endPseudo(false);
        if (wasReal) origExit.call(document).catch(() => {});
      }
    } else if (!isTop && d.sw === "fs-end" && e.source === parent) {
      if (pseudo) { endPseudo(false); fireChange(); }
    }
  });
})();
