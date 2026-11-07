# SyncWatch

Watch any web video in sync with friends, with chat, voice and camera. It controls the
page's `<video>` element directly (including inside iframes), so it is not tied to specific sites.

## Run it

1. Start the relay:
   ```bash
   cd server && npm install && npm start
   ```
2. In Chrome open `chrome://extensions`, enable Developer mode, **Load unpacked**, pick the `extension/` folder.
3. On a page with a video, hover the video and click the round SyncWatch button (top right of the video), or click the toolbar icon.
   A party starts and the invite link is copied.
4. Your friend (also with the extension) opens the link and joins automatically. The relay address travels inside the link.

For friends outside your network, deploy `server/` somewhere with a public `wss://` URL and set it under **Settings** in the chat panel.

## Features

- **Playback sync**: play, pause, seek and speed, on any HTML5 player, with ad clips ignored (videos under 90 s).
- **Chat dock**: sits flush on the right edge and reserves its width, so it never covers the page. A subtle edge tab hides/shows it.
- **Fullscreen with the chat visible**: while a party is active the page goes fullscreen but the video only fills the area left of the chat (`content/fs-main.js` emulates fullscreen; native `<video controls>` fullscreen can't be intercepted).
- **Voice and camera**: peer-to-peer WebRTC. Turn mic/camera on from the chat panel or from your own tile. Everyone whose camera is on appears in **one container** (a grid when there are several) that you can **drag anywhere on screen** and **resize** from its corner. With the camera off there is no tile; the audio keeps playing.

## How voice/video works

The relay only passes the WebRTC handshake. Audio and video go **directly between browsers** in a full mesh,
which suits small groups (about 2 to 5 people); bandwidth and CPU grow with each extra person.

- Capture happens in an extension iframe (`stage/`), so Chrome asks for mic/camera permission once for SyncWatch rather than for every site.
- By default connections use Google's public STUN server. Peers on the same network or with open NATs connect fine; strict NATs (some corporate or mobile networks) need a **TURN** server. Add yours under **Settings → Voice/video servers**, as JSON, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`.
- Being peer-to-peer, participants can see each other's IP addresses (inherent to WebRTC without a relay).

## Layout

```
extension/   Chrome extension (Manifest V3)
  background.js        one WebSocket per tab, message routing
  content/             video sync, hover button, chat dock, fullscreen emulation, miniatures
  chat/                the chat panel (extension iframe)
  stage/               mic/camera capture, WebRTC mesh, video rendering (extension iframe)
  icons.js             Tabler icons (MIT), generated
server/      Node relay: rooms, playback state, chat, WebRTC signaling
test/        local pages with a plain video, an iframe video and a YouTube embed
```

## Known limitations

- Desktop Chrome/Chromium only.
- Everyone must open the same page; different streams/cuts may be a few seconds apart.
- Use the 🎯 button in the chat to pick the right video manually if ads or previews confuse detection.
- Browsers block remote autoplay until you've clicked the page once (a "Click to hear audio" banner appears on the tile).
- Some sites strip `#syncwatch=...` on redirect; the invite is read before the page loads, but you can also paste the link or room code in the chat panel.
- Rare canvas/WebRTC players can't be controlled.
- A site's `Permissions-Policy` can forbid camera/microphone in embedded frames; if so, SyncWatch will say it is blocked.

## Roadmap

- Continue-watching library (page title, URL, progress) with resume prompt
- Per-user time offset and drift correction
- Real accounts
