// Top frame, document_start: read the invite from the URL hash BEFORE the site
// has a chance to rewrite it (YouTube and others strip unknown hashes).
(() => {
  const p = new URLSearchParams(location.hash.slice(1));
  const room = p.get("syncwatch");
  if (!room) return;
  chrome.runtime.sendMessage({ cmd: "invite", room, server: p.get("s") || null }).catch(() => {});
})();
