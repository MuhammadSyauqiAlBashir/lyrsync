// Offline app shell. /api is never cached. The deploy script stamps VERSION,
// so each release gets a fresh cache and old ones are dropped.
const VERSION = "__VERSION__"
const CACHE = "lyrsync-" + VERSION
const SHELL = [
  "/",
  "/app.css?v=" + VERSION,
  "/app.js?v=" + VERSION,
  "/mic.js?v=" + VERSION,
  "/recorder-worklet.js",
  "/manifest.webmanifest",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
]

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return
  if (e.request.mode === "navigate") {
    // Network first so a new release shows up; cached page when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match("/")))
    return
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})
