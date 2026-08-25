const CACHE = "lucky-scratch-v10";
const CORE = ["/", "/login.html", "/profile.html", "/lucky-account.css", "/lucky-account.js", "/lottery-background.webp", "/game-lottery-background.webp", "/profile-lottery-background.webp", "/manifest.webmanifest", "/favicon.svg"];

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
