// The "stage": an extension-origin iframe covering the page (see content/media-ui.js).
// It captures the microphone/camera (so Chrome asks permission once for the
// extension, not for every site), holds the WebRTC mesh to the other participants
// and draws their video where the page overlay tells it to. It is click-through;
// all interaction (drag, resize, buttons) happens in the overlay on the page.
//
// Control comes ONLY from chrome.runtime messages, which web pages cannot forge,
// except layout/unmute hints via postMessage (harmless: positions and "resume playback").
const tabId = Number(new URLSearchParams(location.search).get("tab"));
const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const call = (m) => chrome.runtime.sendMessage({ ...m, tabId }).catch(() => undefined);

let myId = null;
let myName = "Me";
let list = []; // [{id,name}] everyone in the room
let mesh = null;
let iceServers = DEFAULT_ICE;

let audioTrack = null;
let videoTrack = null;
let micOn = false; // audioTrack exists AND is unmuted
const selfStream = new MediaStream();
const remoteState = new Map(); // id -> { mic, cam } as reported by that participant
const layout = new Map(); // id -> { x, y, w, h, z } from the page overlay
const tiles = new Map(); // id -> { el, video, label }
let blocked = false; // browser refused to autoplay remote audio
let lastRosterJson = "";

const nameOf = (id) => list.find((p) => p.id === id)?.name || "Guest";
const sig = (to, data) => call({ cmd: "send", payload: { type: "rtc", ...(to ? { to } : {}), data } });
const notify = (text) => call({ cmd: "notify", text });

// ---- mesh ---------------------------------------------------------------

function makeMesh() {
  const a = audioTrack, v = videoTrack;
  if (mesh) mesh.closeAll();
  mesh = createMesh({
    myId,
    iceServers,
    send: sig,
    onChange: () => refresh(),
    log: (...args) => console.debug("[mesh]", ...args),
  });
  if (a) mesh.setLocal("audio", a);
  if (v) mesh.setLocal("video", v);
}

function connectAll() {
  for (const p of list) if (p.id !== myId) mesh.peerAppeared(p.id);
}

function sendState(to) {
  sig(to, { state: { mic: micOn, cam: !!videoTrack } });
}

// ---- local media --------------------------------------------------------

function explain(e, what) {
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return `${what} is blocked. Allow it for SyncWatch (or this site may forbid it) and try again.`;
  }
  if (e && e.name === "NotFoundError") return `No ${what.toLowerCase()} found.`;
  return `Couldn't start the ${what.toLowerCase()}.`;
}

async function setMic(on) {
  if (!mesh) return;
  try {
    if (on && !audioTrack) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      audioTrack = s.getAudioTracks()[0];
      audioTrack.onended = () => { audioTrack = null; micOn = false; mesh.setLocal("audio", null); afterMediaChange(); };
      mesh.setLocal("audio", audioTrack);
      connectAll();
    }
    micOn = on && !!audioTrack;
    if (audioTrack) audioTrack.enabled = micOn;
  } catch (e) {
    notify(explain(e, "Microphone"));
  }
  afterMediaChange();
}

async function setCam(on) {
  if (!mesh) return;
  try {
    if (on && !videoTrack) {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      });
      videoTrack = s.getVideoTracks()[0];
      videoTrack.onended = () => { stopCam(); afterMediaChange(); };
      selfStream.addTrack(videoTrack);
      mesh.setLocal("video", videoTrack);
      connectAll();
    } else if (!on) {
      stopCam();
    }
  } catch (e) {
    notify(explain(e, "Camera"));
  }
  afterMediaChange();
}

function stopCam() {
  if (!videoTrack) return;
  selfStream.removeTrack(videoTrack);
  videoTrack.stop(); // releases the camera (and its indicator light)
  videoTrack = null;
  mesh && mesh.setLocal("video", null);
}

function afterMediaChange() {
  sendState();
  refresh();
}

// ---- roster + tiles -----------------------------------------------------

function buildRoster() {
  const out = [];
  if (audioTrack || videoTrack) out.push({ id: myId, self: true, name: myName, mic: micOn, cam: !!videoTrack });
  if (mesh) {
    for (const [id, p] of mesh.peers) {
      const st = remoteState.get(id) || {};
      if (p.stream.getTracks().length || st.mic || st.cam) {
        out.push({ id, name: nameOf(id), mic: !!st.mic, cam: !!st.cam });
      }
    }
  }
  return out;
}

function refresh() {
  const roster = buildRoster();
  renderTiles(roster);
  const json = JSON.stringify([roster, blocked]);
  if (json !== lastRosterJson) {
    lastRosterJson = json;
    call({ cmd: "broadcast", msg: { evt: "rtc-roster", roster, blocked } });
  }
}

function renderTiles(roster) {
  const present = new Set(roster.map((r) => r.id));
  for (const [id, t] of tiles) {
    if (!present.has(id)) { t.video.srcObject = null; t.el.remove(); tiles.delete(id); }
  }
  for (const r of roster) {
    let t = tiles.get(r.id);
    if (!t) {
      const el = document.createElement("div");
      el.className = "tile" + (r.self ? " self" : "");
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = !!r.self; // never play our own mic back
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      const letter = document.createElement("b");
      avatar.appendChild(letter);
      el.append(video, avatar);
      document.body.appendChild(el);
      t = { el, video, letter };
      tiles.set(r.id, t);
    }
    const stream = r.self ? selfStream : mesh.peers.get(r.id)?.stream;
    if (stream && t.video.srcObject !== stream) t.video.srcObject = stream;
    t.letter.textContent = (r.name || "?").trim().charAt(0).toUpperCase() || "?";
    t.el.classList.toggle("nocam", !r.cam);
    if (!r.self && t.video.paused && stream && stream.getTracks().length) {
      t.video.play().then(() => { if (blocked) { blocked = false; refresh(); } }, (e) => {
        if (e.name === "NotAllowedError" && !blocked) { blocked = true; refresh(); }
      });
    }
    place(r.id);
  }
}

function place(id) {
  const t = tiles.get(id);
  const l = layout.get(id);
  if (!t) return;
  if (!l) { t.el.style.display = "none"; return; }
  Object.assign(t.el.style, {
    display: "block", left: l.x + "px", top: l.y + "px", width: l.w + "px", height: l.h + "px", zIndex: String(l.z || 0),
  });
}

// Light "who is talking" ring from the receivers' audio levels.
setInterval(() => {
  if (!mesh) return;
  for (const [id, p] of mesh.peers) {
    const t = tiles.get(id);
    if (!t) continue;
    let level = 0;
    for (const r of p.pc.getReceivers()) {
      if (r.track && r.track.kind === "audio" && r.getSynchronizationSources) {
        level = Math.max(level, r.getSynchronizationSources()[0]?.audioLevel || 0);
      }
    }
    t.el.classList.toggle("speak", level > 0.02 && remoteState.get(id)?.mic !== false);
  }
}, 200);

// ---- messages -----------------------------------------------------------

// Page overlay -> stage (postMessage; only layout and "resume playback").
addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || typeof e.data !== "object") return;
  if (e.data.sw === "stage-layout" && Array.isArray(e.data.tiles)) {
    layout.clear();
    for (const t of e.data.tiles) {
      if (t && typeof t.id === "string") layout.set(t.id, { x: +t.x || 0, y: +t.y || 0, w: +t.w || 0, h: +t.h || 0, z: +t.z || 0 });
    }
    for (const id of tiles.keys()) place(id);
  } else if (e.data.sw === "stage-unmute") {
    for (const t of tiles.values()) t.video.play().catch(() => {});
    blocked = false;
    refresh();
  }
});

function syncPresence() {
  if (!mesh) return;
  const ids = new Set(list.map((p) => p.id));
  for (const id of [...mesh.peers.keys()]) if (!ids.has(id)) { mesh.peerGone(id); remoteState.delete(id); }
  for (const id of [...remoteState.keys()]) if (!ids.has(id)) remoteState.delete(id);
  for (const p of list) {
    if (p.id === myId) continue;
    if (!mesh.peers.has(p.id) && mesh.hasLocal()) { mesh.peerAppeared(p.id); sendState(p.id); }
  }
  refresh();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== tabId) return;
  switch (msg.evt) {
    case "joined": {
      const changed = myId !== msg.id;
      myId = msg.id;
      list = msg.list || [];
      if (changed || !mesh) makeMesh(); // a new connection id: old peer connections are meaningless
      connectAll();
      syncPresence();
      break;
    }
    case "presence":
      list = msg.list || list;
      syncPresence();
      break;
    case "rtc": {
      const d = msg.data;
      if (!mesh || !d) break;
      if (d.state) {
        remoteState.set(msg.from, { mic: !!d.state.mic, cam: !!d.state.cam });
        refresh();
      } else {
        if (d.hello) { remoteState.delete(msg.from); if (mesh.hasLocal()) sendState(msg.from); }
        mesh.onSignal(msg.from, d);
      }
      break;
    }
    case "media-cmd":
      if (msg.mic !== undefined) setMic(!!msg.mic);
      if (msg.cam !== undefined) setCam(!!msg.cam);
      break;
    case "rtc-roster-req":
      lastRosterJson = "";
      refresh();
      break;
    case "left":
      teardown();
      break;
  }
});

function teardown() {
  if (audioTrack) { audioTrack.onended = null; audioTrack.stop(); audioTrack = null; }
  stopCam();
  micOn = false;
  if (mesh) mesh.closeAll();
  mesh = null;
  remoteState.clear();
  myId = null;
  list = [];
  lastRosterJson = "";
  renderTiles([]);
  call({ cmd: "broadcast", msg: { evt: "rtc-roster", roster: [], blocked: false } });
}

(async () => {
  const [st, prefs] = await Promise.all([call({ cmd: "status" }), chrome.storage.sync.get("ice")]);
  try {
    const parsed = JSON.parse(prefs.ice || "null");
    if (Array.isArray(parsed) && parsed.length) iceServers = parsed;
  } catch {}
  if (!st?.active) return;
  myId = st.id;
  myName = st.name || myName;
  list = st.list || [];
  makeMesh();
  sig(null, { hello: true }); // tell peers to drop any stale connection to a previous load of us
  syncPresence();
})();
