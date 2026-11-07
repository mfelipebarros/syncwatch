// Full-mesh WebRTC: one RTCPeerConnection per other participant, negotiated with
// the "perfect negotiation" pattern so simultaneous offers (glare), late joiners
// and adding/removing mic or camera mid-call all work. Pure logic: no DOM, no
// chrome.* APIs, so it can be unit-tested with in-memory signaling.
//
//   const mesh = createMesh({ myId, send(to, data), iceServers, onChange(id) });
//   mesh.onSignal(from, data)     feed incoming handshake messages
//   mesh.peerAppeared(id)         a participant is present (connects if we send media)
//   mesh.peerGone(id)             a participant left
//   mesh.setLocal(kind, track)    kind "audio" | "video"; null stops sending it
//   mesh.peers                    Map id -> { stream, ... } with the received media
self.createMesh = function createMesh(opts) {
  const peers = new Map();
  const local = { audio: null, video: null };
  const localStream = new MediaStream();
  const log = opts.log || (() => {});

  const hasLocal = () => !!(local.audio || local.video);

  function attach(p, kind) {
    const track = local[kind];
    if (!track) return;
    if (p.senders[kind]) p.senders[kind].replaceTrack(track).catch(() => {});
    else p.senders[kind] = p.pc.addTrack(track, localStream);
  }

  function detach(p, kind) {
    const s = p.senders[kind];
    if (!s) return;
    try { p.pc.removeTrack(s); } catch {}
    p.senders[kind] = null;
  }

  function make(id) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [] });
    p = {
      id, pc,
      polite: String(opts.myId) < String(id), // deterministic tie-break for glare
      making: false, ignore: false,
      senders: { audio: null, video: null },
      stream: new MediaStream(),
    };
    peers.set(id, p);

    pc.onnegotiationneeded = async () => {
      try {
        p.making = true;
        await pc.setLocalDescription();
        opts.send(id, { description: pc.localDescription });
      } catch (e) { log("negotiationneeded", e); }
      finally { p.making = false; }
    };
    pc.onicecandidate = (e) => { if (e.candidate) opts.send(id, { candidate: e.candidate }); };
    pc.oniceconnectionstatechange = () => {
      log("ice", id, pc.iceConnectionState);
      if (pc.iceConnectionState === "failed") pc.restartIce();
      opts.onChange && opts.onChange(id);
    };
    pc.ontrack = (e) => {
      if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
      const src = e.streams[0];
      if (src) src.onremovetrack = (ev) => { p.stream.removeTrack(ev.track); opts.onChange && opts.onChange(id); };
      e.track.onended = () => { p.stream.removeTrack(e.track); opts.onChange && opts.onChange(id); };
      opts.onChange && opts.onChange(id);
    };

    attach(p, "audio");
    attach(p, "video");
    return p;
  }

  async function onSignal(from, data) {
    if (!data) return;
    if (data.hello) { peerGone(from); if (hasLocal()) make(from); return; } // peer reloaded: start fresh
    const p = make(from);
    const pc = p.pc;
    try {
      if (data.description) {
        const collision = data.description.type === "offer" && (p.making || pc.signalingState !== "stable");
        p.ignore = !p.polite && collision;
        if (p.ignore) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === "offer") {
          await pc.setLocalDescription();
          opts.send(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!p.ignore) throw e; }
      }
    } catch (e) {
      log("signal error", from, e);
      // e.g. the peer's DTLS identity changed (it reloaded): rebuild from scratch.
      peerGone(from);
      if (hasLocal()) make(from);
    }
  }

  function peerAppeared(id) {
    if (id !== opts.myId && hasLocal()) make(id);
  }

  function peerGone(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch {}
    opts.onChange && opts.onChange(id, true);
  }

  function setLocal(kind, track) {
    const old = local[kind];
    if (old) localStream.removeTrack(old);
    local[kind] = track || null;
    if (track) localStream.addTrack(track);
    for (const p of peers.values()) {
      if (track) attach(p, kind); else detach(p, kind);
    }
  }

  function closeAll() {
    for (const id of [...peers.keys()]) peerGone(id);
  }

  return { peers, onSignal, peerAppeared, peerGone, setLocal, closeAll, hasLocal, localStream };
};
