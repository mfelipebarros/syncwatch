// SyncWatch relay: rooms, playback state, chat and WebRTC signaling.
// No accounts, no persistence, and it never sees any audio/video: media flows
// directly between the participants' browsers; this only relays the handshake.
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8787;

// Plain HTTP only answers health checks (Coolify, load balancers, uptime monitors);
// everything else is WebSocket.
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } else {
    res.writeHead(426, { "Content-Type": "text/plain", Upgrade: "websocket" });
    res.end("SyncWatch relay: connect with a WebSocket client.");
  }
});

// SDP offers with video can run several KB, so signaling needs more headroom
// than chat/state messages do.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); // id -> { id, clients:Set<ws>, state }

const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcast = (room, obj, except) => {
  for (const c of room.clients) if (c !== except) send(c, obj);
};
const roster = (room) => [...room.clients].map((c) => ({ id: c.meta.id, name: c.meta.name }));

wss.on("connection", (ws) => {
  ws.meta = { id: randomBytes(4).toString("hex"), name: "Guest" };
  let room = null;

  function leave() {
    if (!room) return;
    room.clients.delete(ws);
    if (room.clients.size === 0) rooms.delete(room.id);
    else {
      broadcast(room, { type: "presence", peers: room.clients.size, list: roster(room) });
      broadcast(room, { type: "chat", system: true, text: `${ws.meta.name} left` });
    }
    room = null;
  }

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "ping") return send(ws, { type: "pong" });

    if (m.type === "join") {
      if (typeof m.room !== "string" || !/^[\w-]{4,64}$/.test(m.room)) return;
      leave();
      ws.meta.name = String(m.name || "Guest").slice(0, 24);
      if (!rooms.has(m.room)) rooms.set(m.room, { id: m.room, clients: new Set(), state: null });
      room = rooms.get(m.room);
      room.clients.add(ws);

      let state = null;
      if (room.state) {
        state = { ...room.state };
        if (state.playing) state.time += ((Date.now() - room.state.at) / 1000) * state.rate;
      }
      send(ws, { type: "joined", id: ws.meta.id, peers: room.clients.size, list: roster(room), state });
      broadcast(room, { type: "presence", peers: room.clients.size, list: roster(room) });
      broadcast(room, { type: "chat", system: true, text: `${ws.meta.name} joined` }, ws);
      return;
    }

    if (!room) return;

    if (m.type === "state") {
      const s = { playing: !!m.playing, time: Number(m.time) || 0, rate: Number(m.rate) || 1 };
      room.state = { ...s, at: Date.now() };
      broadcast(room, { type: "state", ...s, from: ws.meta.name }, ws);
    } else if (m.type === "chat") {
      const text = String(m.text || "").slice(0, 500);
      if (text) broadcast(room, { type: "chat", from: ws.meta.name, text }, ws);
    } else if (m.type === "rtc") {
      // WebRTC handshake (offers, answers, ICE candidates, mic/cam state).
      // Targeted when `to` names a peer in the same room, otherwise broadcast.
      if (m.data === undefined || m.data === null || typeof m.data !== "object") return;
      const msg = { type: "rtc", from: ws.meta.id, data: m.data };
      if (typeof m.to === "string") {
        for (const c of room.clients) if (c.meta.id === m.to) send(c, msg);
      } else {
        broadcast(room, msg, ws);
      }
    }
  });

  ws.on("close", leave);
  ws.on("error", () => {});
});

server.listen(PORT, () => console.log(`SyncWatch relay listening on port ${PORT} (ws://localhost:${PORT})`));

// Containers get SIGTERM on redeploy: close sockets so clients reconnect promptly.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const c of wss.clients) c.close(1001, "server restarting");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
