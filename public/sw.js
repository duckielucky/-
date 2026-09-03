const CACHE = "lucky-scratch-v21";
const CORE = ["/", "/login.html", "/profile.html", "/lucky-account.css", "/lucky-account.js", "/lottery-background.webp", "/lucky-scratch-game-ui.webp", "/prismatic-balance-panel.png", "/prismatic-level-orbit.png", "/prismatic-max-plaque.png", "/gold-token.png", "/lucky-clover-avatar.png", "/prismatic-winning-tile.webp", "/prismatic-scratch-foil.webp", "/prismatic-scratch-gesture.png", "/revealed-tile-miss.png", "/revealed-tile-match.png", "/revealed-match-badge.png", "/collector-card-100x.png", "/collector-card-locked.png", "/collector-card-unlocked.png", "/collector-new-ticket-frame.png", "/action-redeem.png", "/action-reveal.png", "/profile-lottery-background.webp", "/manifest.webmanifest", "/favicon.svg"];

function canonicalPathname(pathname) {
  let current = pathname;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let decoded;
    try { decoded = decodeURIComponent(current); } catch (error) { return null; }
    if (decoded === current) return decoded;
    current = decoded;
  }
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const pathname = canonicalPathname(new URL(event.request.url).pathname);
  if (
    pathname === null ||
    pathname.startsWith("/api/") ||
    pathname === "/manager" ||
    pathname === "/manager/" ||
    pathname === "/manager.html" ||
    pathname === "/manager-login" ||
    pathname === "/manager-login/" ||
    pathname === "/manager-login.html"
  ) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((response) => response || caches.match("/"))));
});
