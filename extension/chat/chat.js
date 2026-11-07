// Chat UI, shown in an extension-origin iframe docked to the page (see
// content/ui.js). Being cross-origin, keys typed here never reach the site's
// hotkey handlers. Everything talks to the background worker by tabId.
const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "ws://localhost:8787";
const tabId = Number(new URLSearchParams(location.search).get("tab"));
let tabUrl = "";

const call = (m) => chrome.runtime.sendMessage({ ...m, tabId }).catch(() => undefined);

// Fill every [data-icon] with its Tabler icon.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.appendChild(swIcon(el.dataset.icon, Number(el.dataset.size) || 18));
}

function addMsg(from, text, system) {
  const m = $("msgs");
  const d = document.createElement("div");
  if (system) {
    d.className = "sys";
    d.textContent = text;
  } else {
    const me = from === "You";
    d.className = "m" + (me ? " me" : "");
    if (!me) { const n = document.createElement("small"); n.textContent = from; d.appendChild(n); }
    const t = document.createElement("span");
    t.textContent = text;
    d.appendChild(t);
  }
  m.appendChild(d);
  m.scrollTop = m.scrollHeight;
}

const setPeers = (n) => { $("peers").textContent = `${n} watching`; };

// ---- voice / video controls (the stage iframe does the real work) ----
let me = { mic: false, cam: false };
function renderCall() {
  const set = (id, on, icon, onLabel, offLabel) => {
    $(id).classList.toggle("on", on);
    $(id + "Icon").textContent = "";
    $(id + "Icon").appendChild(swIcon(on ? icon : icon + "-off", 17));
    $(id + "Label").textContent = on ? onLabel : offLabel;
  };
  set("mic", me.mic, "microphone", "Mic on", "Mic off");
  set("cam", me.cam, "video", "Camera on", "Camera off");
}
$("mic").onclick = () => call({ cmd: "broadcast", msg: { evt: "media-cmd", mic: !me.mic } });
$("cam").onclick = () => call({ cmd: "broadcast", msg: { evt: "media-cmd", cam: !me.cam } });
renderCall();

function flashCopy(text) {
  const old = "Copy link";
  $("copyLabel").textContent = text;
  setTimeout(() => { $("copyLabel").textContent = old; }, 1500);
}

async function load() {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  tabUrl = tab?.url || "";
  $("msgs").textContent = "";
  $("err").textContent = "";
  const st = await call({ cmd: "status" });
  const on = !!st?.active;
  $("party").hidden = !on;
  $("start").hidden = on;

  if (on) {
    setPeers(st.peers);
    const l = await call({ cmd: "link" });
    $("link").value = l?.link || "";
    const h = await call({ cmd: "history" });
    for (const m of h?.history || []) addMsg(m.from, m.text, m.system);
    call({ cmd: "broadcast", msg: { evt: "rtc-roster-req" } }); // ask the stage for the current call state
    return;
  }

  // start screen
  let host = "";
  try { host = new URL(tabUrl).hostname; } catch {}
  const web = /^https?:/.test(tabUrl);
  $("startBtn").disabled = !web;
  $("where").textContent = web
    ? `Start a party for the video on ${host}. Friends open your link and are synced automatically.`
    : "Open a page with a video first, then start a party.";
  const p = await chrome.storage.sync.get(["name", "server", "ice"]);
  $("name").value = p.name || "";
  $("server").value = p.server || DEFAULT_SERVER;
  $("ice").value = p.ice || "";
}

// ---- start screen ----
async function saveSettings() {
  const name = $("name").value.trim();
  const server = $("server").value.trim() || DEFAULT_SERVER;
  if (!/^wss?:\/\/\S+$/.test(server)) { $("err").textContent = "Server must start with ws:// or wss://"; return false; }
  // ICE servers: empty = default public STUN. Otherwise a JSON array like RTCPeerConnection's iceServers.
  const ice = $("ice").value.trim();
  if (ice) {
    let ok = false;
    try { const v = JSON.parse(ice); ok = Array.isArray(v) && v.every((s) => s && (typeof s.urls === "string" || Array.isArray(s.urls))); } catch {}
    if (!ok) { $("err").textContent = 'ICE servers must be a JSON array, e.g. [{"urls":"stun:host:3478"}]'; return false; }
  }
  await chrome.storage.sync.set({ ...(name ? { name } : {}), server, ice });
  return true;
}

$("startBtn").onclick = async () => {
  if (!(await saveSettings())) return;
  const r = await call({ cmd: "quickstart" });
  if (!r?.ok) { $("err").textContent = "Couldn't start the party."; return; }
  let copied = false;
  try { await navigator.clipboard.writeText(r.link); copied = true; } catch {}
  await load();
  if (copied) flashCopy("Copied ✓");
};

$("joinBtn").onclick = async () => {
  const raw = $("code").value.trim();
  let room = raw, server = $("server").value.trim() || DEFAULT_SERVER;
  try {
    const p = new URLSearchParams(new URL(raw).hash.slice(1));
    room = p.get("syncwatch") || raw;
    if (p.get("s")) server = p.get("s");
  } catch {}
  if (!/^[\w-]{4,64}$/.test(room)) { $("err").textContent = "That doesn't look like an invite link or code."; return; }
  if (!/^wss?:\/\/\S+$/.test(server)) { $("err").textContent = "Server must start with ws:// or wss://"; return; }
  const name = $("name").value.trim() || (await chrome.storage.sync.get("name")).name || "Guest" + Math.floor(Math.random() * 9000 + 1000);
  await chrome.storage.sync.set({ name });
  await call({ cmd: "join", room, name, server });
  // a pasted link may point to another page: take this tab there so the video matches
  try {
    const key = (s) => { const u = new URL(s); return u.origin + u.pathname + u.search; };
    const target = new URL(raw);
    if (/^https?:$/.test(target.protocol) && key(raw) !== key(tabUrl)) {
      chrome.tabs.update(tabId, { url: target.toString() });
    }
  } catch {}
  await load();
};

$("name").onchange = saveSettings;
$("server").onchange = saveSettings;
$("ice").onchange = saveSettings;
$("hide").onclick = () => call({ cmd: "broadcast", msg: { evt: "ui", hide: true } });

// ---- party screen ----
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("link").value); flashCopy("Copied ✓"); }
  catch { $("link").select(); flashCopy("Press Ctrl+C"); }
};
$("link").onclick = () => $("link").select();
$("leave").onclick = () => call({ cmd: "leave" });
$("collapse").onclick = () => call({ cmd: "broadcast", msg: { evt: "ui", open: false } });
$("pick").onclick = () => {
  call({ cmd: "broadcast", msg: { evt: "pick-mode" } });
  addMsg("", "Click the video you want to sync.", true);
};
$("form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text) return;
  addMsg("You", text);
  call({ cmd: "send", payload: { type: "chat", text } });
  $("text").value = "";
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId !== tabId) return; // other tabs / content-script traffic
  switch (msg.evt) {
    case "joined": load(); break;
    case "left": load(); break;
    case "presence": setPeers(msg.peers); break;
    case "rtc-roster": {
      const self = (msg.roster || []).find((r) => r.self);
      me = { mic: !!self?.mic, cam: !!self?.cam };
      renderCall();
      break;
    }
    case "chat": addMsg(msg.from, msg.text, msg.system); break;
    case "notice": addMsg("", msg.text, true); break;
  }
});

chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && info.url) load(); // e.g. YouTube navigating to another video
});

load();
