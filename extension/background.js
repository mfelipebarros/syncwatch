// Holds one WebSocket per tab and routes messages between the relay server
// and every frame of that tab (video frames) plus the side panel.

const DEFAULT_SERVER = "ws://localhost:8787";
const ROOM_RE = /^[\w-]{4,64}$/;
const SERVER_RE = /^wss?:\/\/\S+$/;

const sessions = new Map(); // tabId -> { ws, room, name, server, history, peers, closing, retry, ping }

// The toolbar icon shows/hides the chat dock in the current page.
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { evt: "toggle-ui" }, { frameId: 0 }).catch(() => {});
});

// Content scripts get tabs.sendMessage; extension pages (the chat iframe) get
// runtime.sendMessage, tagged with tabId so each iframe can filter its own tab.
function toTab(tabId, evt) {
  chrome.tabs.sendMessage(tabId, evt).catch(() => {});
  chrome.runtime.sendMessage({ ...evt, tabId }).catch(() => {});
}

function remember(s, entry) {
  s.history.push(entry);
  if (s.history.length > 200) s.history.shift();
}

function connect(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  const ws = new WebSocket(s.server);
  s.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", room: s.room, name: s.name }));
    clearInterval(s.ping);
    // Traffic every 20s keeps the MV3 service worker alive.
    s.ping = setInterval(() => ws.readyState === 1 && ws.send('{"type":"ping"}'), 20000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "pong") return;
    if (msg.type === "joined" || msg.type === "presence") {
      s.peers = msg.peers;
      s.list = msg.list || s.list;
      if (msg.type === "joined") s.id = msg.id;
    }
    if (msg.type === "chat") remember(s, { from: msg.from, text: msg.text, system: !!msg.system });
    toTab(tabId, { evt: msg.type, ...msg, room: s.room });
  };
  ws.onclose = () => {
    clearInterval(s.ping);
    if (s.closing) return;
    toTab(tabId, { evt: "notice", text: "Disconnected. Reconnecting…" });
    s.retry = setTimeout(() => connect(tabId), 2000);
  };
  ws.onerror = () => {};
}

// Badge tells the user a party is active on the tab.
function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#4b4bff" }).catch(() => {});
}

function join(tabId, { room, name, server }) {
  leave(tabId, false);
  sessions.set(tabId, { room, name, server, ws: null, history: [], peers: 1 });
  setBadge(tabId, true);
  connect(tabId);
}

function leave(tabId, notify = true) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.closing = true;
  clearTimeout(s.retry);
  clearInterval(s.ping);
  try { s.ws && s.ws.close(); } catch {}
  sessions.delete(tabId);
  setBadge(tabId, false);
  if (notify) toTab(tabId, { evt: "left" });
}

// Saved name/server with defaults; creates and stores a guest name on first use.
async function getPrefs() {
  const p = await chrome.storage.sync.get(["name", "server"]);
  let name = p.name;
  if (!name) {
    name = "Guest" + Math.floor(Math.random() * 9000 + 1000);
    chrome.storage.sync.set({ name });
  }
  return { name, server: p.server || DEFAULT_SERVER };
}

function newRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

// The invite is the page URL plus a hash (sites can't see hashes server-side).
// The relay address rides along unless it's the default, so friends need no setup.
function makeLink(tabUrl, room, server) {
  const u = new URL(tabUrl);
  u.hash = "syncwatch=" + room + (server !== DEFAULT_SERVER ? "&s=" + encodeURIComponent(server) : "");
  return u.toString();
}

async function joinFromInvite(tabId, room, inviteServer) {
  if (!ROOM_RE.test(room)) return;
  const cur = sessions.get(tabId);
  if (cur && cur.room === room) return; // page reload with the same invite
  const p = await getPrefs();
  const server = inviteServer && SERVER_RE.test(inviteServer) ? inviteServer : p.server;
  join(tabId, { room, name: p.name, server });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (tabId == null) return;

  switch (msg.cmd) {
    case "join":
      join(tabId, msg);
      sendResponse({ ok: true });
      break;
    case "invite":
      joinFromInvite(tabId, msg.room, msg.server);
      break;
    case "quickstart": {
      // Create a room on the tab's page and join it; the chat dock opens itself
      // when the "joined" event reaches the page.
      (async () => {
        const { name, server } = await getPrefs();
        const room = newRoom();
        join(tabId, { room, name, server });
        const tab = await chrome.tabs.get(tabId);
        sendResponse({ ok: true, room, link: makeLink(tab.url, room, server) });
      })().catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
    case "link": {
      const s = sessions.get(tabId);
      if (!s) { sendResponse({ link: null }); break; }
      chrome.tabs.get(tabId).then(
        (tab) => sendResponse({ link: makeLink(tab.url, s.room, s.server) }),
        () => sendResponse({ link: null })
      );
      return true;
    }
    case "leave":
      leave(tabId);
      sendResponse({ ok: true });
      break;
    case "status": {
      const s = sessions.get(tabId);
      sendResponse(
        s
          ? { active: true, tabId, room: s.room, name: s.name, server: s.server, peers: s.peers, id: s.id, list: s.list || [], connected: s.ws?.readyState === 1 }
          : { active: false, tabId }
      );
      break;
    }
    case "history":
      sendResponse({ history: sessions.get(tabId)?.history || [] });
      break;
    case "send": {
      const s = sessions.get(tabId);
      if (s?.ws?.readyState === 1) s.ws.send(JSON.stringify(msg.payload));
      if (s && msg.payload?.type === "chat") remember(s, { from: "You", text: msg.payload.text });
      break;
    }
    case "notify":
      toTab(tabId, { evt: "notice", text: msg.text });
      break;
    case "broadcast":
      toTab(tabId, msg.msg);
      break;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => leave(tabId, false));

// Tab-specific badges reset on navigation; put it back while the party lives.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && sessions.has(tabId)) setBadge(tabId, true);
});
