import { Mic, MicError } from "/mic.js?v=__VERSION__"

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const ONCE_SAMPLE_S = 7 // seconds recorded before the first try
const ONCE_MAX_TRIES = 3
const ALWAYS_SAMPLE_S = 8
const ALWAYS_MAX_GAP_MS = 45000 // light check while a song plays (catches skips)
const ALWAYS_MIN_GAP_MS = 8000

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v
    else if (k === "text") node.textContent = v
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v)
  }
  for (const c of children) if (c) node.append(c)
  return node
}

function safeHttps(url, hosts) {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:") return ""
    if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return ""
    return u.href
  } catch (_) {
    return ""
  }
}
const coverUrl = (u) => safeHttps(u || "", ["mzstatic.com"])

let toastTimer
function toast(msg, ms = 2600) {
  const t = $("toast")
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), ms)
}

function setStatus(text, warn = false) {
  const s = $("status")
  s.textContent = text || ""
  s.classList.toggle("warn", !!warn)
}

function timeAgo(pbDate) {
  const d = new Date(String(pbDate || "").replace(" ", "T"))
  if (isNaN(d)) return ""
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch (_) { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch (_) {} },
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function api(path, { method = "GET", json, body, headers = {} } = {}) {
  const opts = { method, credentials: "same-origin", headers: { "X-Lyrsync": "1", ...headers } }
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(json)
  } else if (body !== undefined) {
    opts.body = body
  }
  let res
  try {
    res = await fetch("/api" + path, opts)
  } catch (_) {
    throw new ApiError(0, "No connection. Check your internet.")
  }
  let data = {}
  try { data = await res.json() } catch (_) {}
  if (res.status === 401 && path !== "/login") {
    onLoggedOut()
    throw new ApiError(401, data.error || "Please log in.")
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Something went wrong (${res.status}).`, data.retry_after)
  return data
}

// ---------------------------------------------------------------------------
// Session / auth view
// ---------------------------------------------------------------------------
let me = null
let authMode = "login"

function showAuth(message, ok = false) {
  $("appView").hidden = true
  $("authView").hidden = false
  const m = $("authMsg")
  m.textContent = message || ""
  m.classList.toggle("ok", ok)
}

function showApp() {
  $("authView").hidden = true
  $("appView").hidden = false
  $("adminMenuItem").hidden = me.role !== "admin"
  $("accountName").textContent = me.username
  $("pwUser").value = me.username
  loadFavIds()
}

function onLoggedOut() {
  stopAll()
  me = null
  closeSheets()
  showAuth("Your session has ended. Please log in again.")
}

function setAuthMode(mode) {
  authMode = mode
  $("tabLogin").setAttribute("aria-selected", mode === "login")
  $("tabRegister").setAttribute("aria-selected", mode === "register")
  $("authSubmit").textContent = mode === "login" ? "Log in" : "Create account"
  $("authHint").hidden = mode !== "register"
  $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password"
  $("authMsg").textContent = ""
}

$("tabLogin").onclick = () => setAuthMode("login")
$("tabRegister").onclick = () => setAuthMode("register")

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault()
  const username = $("authUser").value.trim().toLowerCase()
  const password = $("authPass").value
  const msg = $("authMsg")
  msg.classList.remove("ok")
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    msg.textContent = "Username: 3–32 lowercase letters, numbers or _."
    return
  }
  if (password.length < 8) {
    msg.textContent = "Password must be at least 8 characters."
    return
  }
  const btn = $("authSubmit")
  btn.disabled = true
  try {
    if (authMode === "register") {
      await api("/register", { method: "POST", json: { username, password } })
      $("authPass").value = ""
      setAuthMode("login")
      msg.textContent = "Account created. You can log in once the admin approves it."
      msg.classList.add("ok")
    } else {
      const data = await api("/login", { method: "POST", json: { username, password } })
      me = data.user
      $("authPass").value = ""
      showApp()
    }
  } catch (err) {
    msg.textContent = err.message
  } finally {
    btn.disabled = false
  }
})

// ---------------------------------------------------------------------------
// Now playing + lyrics
// ---------------------------------------------------------------------------
const now = {
  track: null,
  lyrics: null,
  sync: null, // { offset, startedAt } → song position = offset + (t - startedAt)/1000
  view: store.get("lyr_view", "synced"),
}
let delay = store.get("lyr_delay", 0) // seconds the lyrics are pushed later
let lineEls = []
let curIdx = -2
let raf = 0

function position(t = performance.now()) {
  if (!now.sync) return null
  return now.sync.offset + (t - now.sync.startedAt) / 1000 - delay
}

function sameTrack(a, b) {
  return a && b && a.track_id === b.track_id
}

function setBackdrop(url) {
  const art = $("backdropArt")
  if (url) {
    art.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`
    art.classList.add("has-art")
  } else {
    art.style.backgroundImage = ""
    art.classList.remove("has-art")
  }
}

function renderSong() {
  const t = now.track
  $("songCard").hidden = !t
  $("emptyState").hidden = !!t
  if (!t) {
    setBackdrop("")
    $("lyricsTools").hidden = true
    $("syncedView").hidden = true
    $("fullView").hidden = true
    $("lyricsNotice").hidden = true
    stopTicker()
    return
  }
  $("songTitle").textContent = t.title
  $("songArtist").textContent = [t.artist, t.album].filter(Boolean).join(" · ")
  const cover = coverUrl(t.cover)
  const c = $("songCover")
  c.style.backgroundImage = cover ? `url("${cover.replace(/"/g, "%22")}")` : ""
  c.classList.toggle("placeholder", !cover)
  c.textContent = cover ? "" : "♪"
  setBackdrop(cover)

  const q = encodeURIComponent(`${t.title} ${t.artist || ""}`.trim())
  const apple = safeHttps(t.apple_url || "", ["music.apple.com"]) || `https://music.apple.com/search?term=${q}`
  const spotify = safeHttps(t.spotify_url || "", ["open.spotify.com"]) || `https://open.spotify.com/search/${q}`
  $("appleLink").href = apple
  $("spotifyLink").href = spotify
  renderFav()
  renderLyrics()
}

function renderLyrics() {
  const L = now.lyrics
  const notice = $("lyricsNotice")
  notice.replaceChildren()
  notice.hidden = true
  $("syncedView").hidden = true
  $("fullView").hidden = true
  stopTicker()

  if (L === undefined) {
    $("lyricsTools").hidden = true
    notice.hidden = false
    notice.textContent = "Loading lyrics…"
    return
  }
  if (!L || (!L.synced && !L.plain && !L.instrumental)) {
    $("lyricsTools").hidden = true
    notice.hidden = false
    notice.append(
      el("div", { text: "No lyrics found for this song." }),
      el("button", {
        class: "btn ghost", type: "button", text: "Search manually",
        onclick: () => openSearch(`${now.track.title} ${now.track.artist || ""}`.trim()),
      }),
    )
    return
  }
  if (L.instrumental && !L.synced && !L.plain) {
    $("lyricsTools").hidden = true
    notice.hidden = false
    notice.textContent = "♪ Instrumental"
    return
  }

  const canSync = !!L.synced
  $("lyricsTools").hidden = false
  $("viewSynced").disabled = !canSync
  const view = canSync ? now.view : "full"
  $("viewSynced").setAttribute("aria-pressed", view === "synced")
  $("viewFull").setAttribute("aria-pressed", view === "full")
  $("nudge").hidden = view !== "synced"
  $("nudgeValue").textContent = `${delay > 0 ? "+" : ""}${delay.toFixed(1)}s`

  if (view === "full") {
    $("fullView").hidden = false
    $("fullView").textContent = L.plain || L.synced.map((l) => l.text).join("\n")
    $("fullView").scrollTop = 0
    return
  }

  // Synced view
  const box = $("syncedLines")
  lineEls = L.synced.map((l) => el("div", { class: "line" + (l.text ? "" : " gap"), text: l.text }))
  box.replaceChildren(...lineEls)
  curIdx = -2
  $("syncedView").hidden = false
  if (!now.sync) {
    notice.hidden = false
    notice.textContent = "Tap Listen while the song plays to sync the lyrics."
    $("syncedView").hidden = true
    return
  }
  startTicker()
}

function findLine(pos) {
  const lines = now.lyrics.synced
  let lo = 0, hi = lines.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= pos) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function tick() {
  raf = requestAnimationFrame(tick)
  if (!now.sync || !now.lyrics || !now.lyrics.synced) return
  const idx = findLine(position())
  if (idx === curIdx) return
  curIdx = idx
  for (let i = 0; i < lineEls.length; i++) {
    const d = i - idx
    lineEls[i].className = "line" + (now.lyrics.synced[i].text ? "" : " gap") +
      (d === 0 ? " current" : d < 0 ? " past" : d <= 2 ? " near" : "")
  }
  centerOn(idx < 0 ? 0 : idx)
}

function centerOn(i) {
  const target = lineEls[i]
  if (!target) return
  const view = $("syncedView")
  const y = view.clientHeight * 0.36 - (target.offsetTop + target.offsetHeight / 2)
  $("syncedLines").style.transform = `translate3d(0, ${Math.round(y)}px, 0)`
}

function startTicker() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(tick)
}

function stopTicker() {
  cancelAnimationFrame(raf)
  raf = 0
}

$("viewSynced").onclick = () => { now.view = "synced"; store.set("lyr_view", "synced"); renderLyrics() }
$("viewFull").onclick = () => { now.view = "full"; store.set("lyr_view", "full"); renderLyrics() }

function nudge(d) {
  delay = Math.round((delay + d) * 10) / 10
  delay = Math.max(-10, Math.min(10, delay))
  store.set("lyr_delay", delay)
  $("nudgeValue").textContent = `${delay > 0 ? "+" : ""}${delay.toFixed(1)}s`
  curIdx = -2
}
$("nudgeMinus").onclick = () => nudge(-0.5)
$("nudgePlus").onclick = () => nudge(0.5)

window.addEventListener("resize", () => { curIdx = -2 })

// Show a song. `sync` is null when we don't know where in the song we are.
function showSong(track, lyrics, sync) {
  const changed = !sameTrack(track, now.track)
  now.track = track
  now.lyrics = lyrics
  now.sync = sync
  if (changed) renderSong()
  else renderLyrics()
}

async function openTrack(track) {
  showSong(track, undefined, null)
  closeSheets()
  try {
    const params = new URLSearchParams()
    if (track.lrclib_id) params.set("lrclib_id", track.lrclib_id)
    else {
      params.set("title", track.title)
      params.set("artist", track.artist || "")
      params.set("album", track.album || "")
    }
    const data = await api("/lyrics?" + params)
    if (sameTrack(track, now.track)) {
      now.lyrics = data.lyrics
      renderLyrics()
    }
  } catch (err) {
    if (sameTrack(track, now.track)) {
      now.lyrics = null
      renderLyrics()
      toast(err.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------
let favIds = {} // track_id -> record id

async function loadFavIds() {
  try {
    favIds = (await api("/favorites/ids")).ids || {}
    renderFav()
  } catch (_) {}
}

function renderFav() {
  const on = !!(now.track && favIds[now.track.track_id])
  $("favBtn").setAttribute("aria-pressed", on)
  $("favBtn").setAttribute("aria-label", on ? "Remove from favourites" : "Add to favourites")
}

function trackPayload(t) {
  const keys = ["track_id", "title", "artist", "album", "cover", "apple_url", "spotify_url", "isrc", "source", "duration", "lrclib_id"]
  const out = {}
  for (const k of keys) if (t[k] !== undefined && t[k] !== null && t[k] !== "") out[k] = t[k]
  return out
}

async function toggleFav(track) {
  const id = favIds[track.track_id]
  try {
    if (id) {
      await api(`/favorites/${id}`, { method: "DELETE" })
      delete favIds[track.track_id]
      toast("Removed from favourites")
    } else {
      const data = await api("/favorites", { method: "POST", json: trackPayload(track) })
      favIds[track.track_id] = data.id
      toast("Added to favourites")
    }
  } catch (err) {
    toast(err.message)
  }
  renderFav()
}

$("favBtn").onclick = () => now.track && toggleFav(now.track)

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------
const mic = new Mic()
let mode = "idle" // idle | once | always
let gen = 0 // bumps on every start/stop so stale async work can bail out
let alwaysTimer = 0
let checking = false
let misses = 0
let wakeLock = null
let resumeOnTap = false

async function identify(seconds) {
  const clip = mic.take(seconds)
  const data = await api("/identify", { method: "POST", body: clip.wav, headers: { "Content-Type": "audio/wav" } })
  return { ...data, startedAt: clip.startedAt }
}

function applyMatch(r) {
  const sync = { offset: r.offset, startedAt: r.startedAt }
  if (sameTrack(r.track, now.track) && now.lyrics !== undefined) {
    // Same song: just re-anchor the timing (corrects drift and seeks).
    now.sync = sync
    if (!now.lyrics && r.lyrics) now.lyrics = r.lyrics
    curIdx = -2
    renderLyrics()
  } else {
    showSong(r.track, r.lyrics, sync)
  }
}

function setListenUi() {
  const btn = $("listenBtn")
  btn.classList.toggle("busy", mode === "once")
  $("listenLabel").textContent = mode === "once" ? "Stop" : "Listen"
  if (mode !== "once") btn.style.removeProperty("--progress")
  const on = mode === "always"
  $("alwaysBtn").setAttribute("aria-pressed", on)
  $("alwaysLabel").textContent = on ? "Always on" : "Always"
}

function micFailed(err) {
  setStatus(err instanceof MicError ? err.message : "Couldn't start the microphone.", true)
}

// ----- Listen (one-shot) -----
async function listenOnce() {
  const my = ++gen
  mode = "once"
  setListenUi()
  setStatus("Listening…")
  try {
    await mic.start()
  } catch (err) {
    if (my === gen) { stopAll(); micFailed(err) }
    return
  }
  let waitUntil = ONCE_SAMPLE_S // in seconds of total recording
  for (let attempt = 1; attempt <= ONCE_MAX_TRIES; attempt++) {
    const from = mic.recorded
    while (mic.recorded < waitUntil) {
      if (my !== gen) return
      const p = (mic.recorded - from) / Math.max(0.1, waitUntil - from)
      $("listenBtn").style.setProperty("--progress", Math.min(1, p).toFixed(3))
      await sleep(150)
    }
    if (my !== gen) return
    setStatus(attempt === 1 ? "Identifying…" : "Still listening…")
    let r
    try {
      r = await identify(Math.min(mic.buffered, 10))
    } catch (err) {
      if (my !== gen) return
      stopAll()
      setStatus(err.message, true)
      return
    }
    if (my !== gen) return
    if (r.match) {
      applyMatch(r)
      stopAll()
      setStatus("")
      return
    }
    // Shazam asks for more audio before retrying (retry_ms).
    waitUntil = mic.recorded + Math.max(4, (r.retry_ms || 8000) / 1000)
  }
  stopAll()
  setStatus("Couldn't recognise this song. Try again closer to the sound.", true)
}

// ----- Always -----
async function startAlways() {
  const my = ++gen
  mode = "always"
  misses = 0
  setListenUi()
  setStatus("Always listening…")
  try {
    await mic.start()
  } catch (err) {
    if (my === gen) { stopAll(); micFailed(err) }
    return
  }
  await acquireWakeLock()
  scheduleCheck(Math.max(0, (ALWAYS_SAMPLE_S - mic.buffered) * 1000))
}

function scheduleCheck(ms) {
  clearTimeout(alwaysTimer)
  const my = gen
  alwaysTimer = setTimeout(() => { if (my === gen) checkAlways() }, ms)
}

function nextGapMs() {
  const pos = position()
  const dur = now.track && now.track.duration
  if (pos !== null && dur) {
    // Recheck once the song should be over (plus enough time to hear the next
    // one), or sooner as a light check in case the song was skipped.
    const untilNextSong = (dur - pos + ALWAYS_SAMPLE_S) * 1000
    return Math.max(ALWAYS_MIN_GAP_MS, Math.min(ALWAYS_MAX_GAP_MS, untilNextSong))
  }
  return now.track ? ALWAYS_MAX_GAP_MS : 10000
}

async function checkAlways() {
  const my = gen
  if (mode !== "always" || checking) return
  if (!mic.active) return pauseAlways("The microphone stopped. Tap Always to resume.")
  if (mic.buffered < ALWAYS_SAMPLE_S) return scheduleCheck((ALWAYS_SAMPLE_S - mic.buffered) * 1000 + 200)
  checking = true
  let delayMs
  try {
    const r = await identify(ALWAYS_SAMPLE_S)
    if (my !== gen) return
    if (r.match) {
      misses = 0
      applyMatch(r)
      setStatus("Always listening · following along")
      delayMs = nextGapMs()
    } else {
      misses++
      const pos = position()
      const ended = now.track && now.track.duration && pos !== null && pos > now.track.duration + 2
      if (now.track && (ended || misses >= 4)) {
        showSong(null, null, null)
      }
      setStatus(now.track ? "Always listening · following along" : "Always listening · waiting for music")
      const floor = misses < 3 ? 10000 : misses < 8 ? 20000 : 30000
      delayMs = Math.max(floor, r.retry_ms || 0)
    }
  } catch (err) {
    if (my !== gen) return
    if (err.status === 401) return
    delayMs = err.retryAfter ? err.retryAfter * 1000 : 15000
    setStatus(err.retryAfter ? `${err.message}` : `${err.message} Retrying soon.`, true)
  } finally {
    checking = false
  }
  if (my === gen && mode === "always") scheduleCheck(delayMs)
}

// Stop capturing but remember Always was on (app hidden, call, etc.).
function pauseAlways(message) {
  clearTimeout(alwaysTimer)
  mic.stop()
  releaseWakeLock()
  gen++
  resumeOnTap = true
  mode = "idle"
  setListenUi()
  setStatus(message || "Paused. Tap Always to resume.", true)
}

function stopAll() {
  gen++
  clearTimeout(alwaysTimer)
  mode = "idle"
  resumeOnTap = false
  checking = false
  mic.stop()
  releaseWakeLock()
  setListenUi()
}

mic.onEnded = () => {
  if (mode === "always") pauseAlways("The microphone was interrupted. Tap Always to resume.")
  else if (mode === "once") { stopAll(); setStatus("The microphone was interrupted.", true) }
}

$("listenBtn").onclick = () => {
  if (mode === "once") { stopAll(); setStatus(""); return }
  if (mode === "always") {
    // Check right now instead of waiting for the next scheduled check.
    if (!checking) { setStatus("Checking…"); clearTimeout(alwaysTimer); checkAlways() }
    return
  }
  listenOnce()
}

$("alwaysBtn").onclick = () => {
  if (mode === "always") { stopAll(); setStatus("") } else startAlways()
}

// ----- Screen wake lock (keeps the screen on while Always is on) -----
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen")
      wakeLock.addEventListener("release", () => { wakeLock = null })
    }
  } catch (_) {
    wakeLock = null
  }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {})
  wakeLock = null
}

// iOS stops the mic when the app is hidden. Pause cleanly and pick up again.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    stopTicker()
    if (mode === "always") pauseAlways("Paused while the app was in the background.")
    else if (mode === "once") { stopAll(); setStatus("") }
    return
  }
  if (now.sync && now.lyrics && now.lyrics.synced && !$("syncedView").hidden) startTicker()
  if (resumeOnTap && me) {
    // Try to resume straight away; iOS may insist on a tap first, in which
    // case startAlways leaves a "tap to resume" message.
    await startAlways()
    if (mode !== "always") setStatus("Tap Always to resume listening.", true)
  }
})

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------
function closeSheets() {
  for (const d of document.querySelectorAll("dialog[open]")) d.close()
}

function openSheet(id) {
  closeSheets()
  const d = $(id)
  d.showModal()
  if (id === "historySheet") loadList("history", true)
  if (id === "favSheet") loadList("favorites", true)
  if (id === "adminSheet") loadAdmin()
  if (id === "accountSheet") { $("pwMsg").textContent = ""; $("pwForm").reset(); $("pwUser").value = me.username }
}

for (const d of document.querySelectorAll("dialog.sheet")) {
  // Tap outside the sheet closes it.
  d.addEventListener("click", (e) => { if (e.target === d) d.close() })
}
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]")
  if (open) openSheet(open.dataset.open)
  if (e.target.closest("[data-close]")) closeSheets()
})
$("menuBtn").onclick = () => openSheet("menuSheet")

function thumb(t) {
  const c = coverUrl(t.cover)
  const n = el("div", { class: "thumb" })
  if (c) n.style.backgroundImage = `url("${c.replace(/"/g, "%22")}")`
  else n.textContent = "♪"
  return n
}

// ----- History / favourites lists -----
const lists = {
  history: { page: 1, pages: 1, listId: "historyList", moreId: "historyMore", empty: "Songs you identify appear here." },
  favorites: { page: 1, pages: 1, listId: "favList", moreId: "favMore", empty: "Tap ☆ on a song to keep it here." },
}

async function loadList(kind, reset) {
  const L = lists[kind]
  const ul = $(L.listId)
  if (reset) { L.page = 1; ul.replaceChildren(el("li", { class: "list-empty", text: "Loading…" })) }
  try {
    const data = await api(`/${kind}?page=${L.page}`)
    if (reset) ul.replaceChildren()
    L.pages = data.total_pages || 1
    for (const rec of data.items) ul.append(listItem(kind, rec))
    if (!ul.children.length) ul.append(el("li", { class: "list-empty", text: L.empty }))
    $(L.moreId).hidden = L.page >= L.pages
  } catch (err) {
    ul.replaceChildren(el("li", { class: "list-empty", text: err.message }))
  }
}

function listItem(kind, rec) {
  const li = el("li", { class: "item" })
  const sub = [rec.artist, kind === "history" ? timeAgo(rec.created) : ""].filter(Boolean).join(" · ")
  const main = el("button", { class: "main", type: "button", onclick: () => openTrack(rec) },
    el("div", { class: "t", text: rec.title }), el("div", { class: "s", text: sub }))
  const actions = el("div", { class: "actions" })
  if (kind === "history") {
    const fav = !!favIds[rec.track_id]
    const star = el("button", { class: "icon-btn star", type: "button", "aria-pressed": fav, "aria-label": "Favourite" })
    star.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>'
    star.onclick = async () => { await toggleFav(rec); star.setAttribute("aria-pressed", !!favIds[rec.track_id]) }
    actions.append(star)
  }
  const del = el("button", { class: "icon-btn", type: "button", "aria-label": kind === "history" ? "Remove from history" : "Remove from favourites", text: "✕" })
  del.onclick = async () => {
    try {
      await api(`/${kind}/${rec.id}`, { method: "DELETE" })
      if (kind === "favorites") { delete favIds[rec.track_id]; renderFav() }
      li.remove()
    } catch (err) { toast(err.message) }
  }
  actions.append(del)
  li.append(thumb(rec), main, actions)
  return li
}

$("historyMore").onclick = () => { lists.history.page++; loadList("history", false) }
$("favMore").onclick = () => { lists.favorites.page++; loadList("favorites", false) }

// ----- Search -----
function openSearch(q) {
  openSheet("searchSheet")
  $("searchInput").value = q || ""
  $("searchList").replaceChildren()
  if (q) runSearch(q)
  else setTimeout(() => $("searchInput").focus(), 50)
}

async function runSearch(q) {
  const ul = $("searchList")
  ul.replaceChildren(el("li", { class: "list-empty", text: "Searching…" }))
  try {
    const data = await api("/search?q=" + encodeURIComponent(q))
    ul.replaceChildren()
    for (const r of data.results) {
      const badge = r.has_synced ? el("span", { class: "badge ok", text: "synced" })
        : r.instrumental ? el("span", { class: "badge", text: "instrumental" }) : null
      const title = el("div", { class: "t", text: r.track.title })
      if (badge) title.append(badge)
      const main = el("button", { class: "main", type: "button" }, title,
        el("div", { class: "s", text: [r.track.artist, r.track.album].filter(Boolean).join(" · ") }))
      main.onclick = () => {
        openTrack(r.track)
        api("/history", { method: "POST", json: trackPayload(r.track) }).catch(() => {})
      }
      ul.append(el("li", { class: "item" }, thumb(r.track), main))
    }
    if (!ul.children.length) ul.append(el("li", { class: "list-empty", text: "No results. Try the title and artist." }))
  } catch (err) {
    ul.replaceChildren(el("li", { class: "list-empty", text: err.message }))
  }
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault()
  const q = $("searchInput").value.trim()
  if (q.length >= 2) { $("searchInput").blur(); runSearch(q) }
})
document.querySelector('[data-open="searchSheet"]').addEventListener("click", () => {
  setTimeout(() => $("searchInput").focus(), 50)
})

// ----- Admin -----
async function loadAdmin() {
  const ul = $("adminList")
  ul.replaceChildren(el("li", { class: "list-empty", text: "Loading…" }))
  try {
    const { users } = await api("/admin/users")
    ul.replaceChildren()
    for (const u of users) ul.append(adminItem(u))
    if (!users.length) ul.append(el("li", { class: "list-empty", text: "No users yet." }))
  } catch (err) {
    ul.replaceChildren(el("li", { class: "list-empty", text: err.message }))
  }
}

function adminItem(u) {
  const self = u.id === me.id
  const badge = u.role === "admin" ? el("span", { class: "badge", text: "admin" })
    : u.approved ? el("span", { class: "badge ok", text: "approved" }) : el("span", { class: "badge wait", text: "pending" })
  const name = el("div", { class: "t", text: u.username })
  name.append(badge)
  const li = el("li", { class: "item" },
    el("div", { class: "main" }, name, el("div", { class: "s", text: "Registered " + timeAgo(u.created) })))
  if (!self) {
    const actions = el("div", { class: "actions" })
    const toggle = el("button", { class: "btn " + (u.approved ? "ghost" : "primary"), type: "button", text: u.approved ? "Revoke" : "Approve" })
    toggle.onclick = async () => {
      toggle.disabled = true
      try {
        await api(`/admin/users/${u.id}`, { method: "PATCH", json: { approved: !u.approved } })
        u.approved = !u.approved
        li.replaceWith(adminItem(u))
      } catch (err) { toast(err.message); toggle.disabled = false }
    }
    let armed = false
    const del = el("button", { class: "btn ghost danger", type: "button", text: "Delete" })
    del.onclick = async () => {
      if (!armed) {
        armed = true
        del.textContent = "Sure?"
        setTimeout(() => { armed = false; del.textContent = "Delete" }, 3000)
        return
      }
      try {
        await api(`/admin/users/${u.id}`, { method: "DELETE" })
        li.remove()
        toast(`Deleted ${u.username}`)
      } catch (err) { toast(err.message) }
    }
    actions.append(toggle, del)
    li.append(actions)
  }
  return li
}

// ----- Account -----
$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault()
  const msg = $("pwMsg")
  msg.classList.remove("ok")
  const old = $("pwOld").value
  const nw = $("pwNew").value
  if (nw.length < 8) { msg.textContent = "New password must be at least 8 characters."; return }
  try {
    await api("/password", { method: "POST", json: { old, new: nw } })
    await api("/logout", { method: "POST" }).catch(() => {})
    stopAll()
    me = null
    closeSheets()
    showAuth("Password changed. Log in with your new password.", true)
  } catch (err) {
    msg.textContent = err.message
  }
})

$("logoutBtn").onclick = async () => {
  await api("/logout", { method: "POST" }).catch(() => {})
  stopAll()
  me = null
  now.track = null
  renderSong()
  closeSheets()
  showAuth("")
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function boot() {
  setListenUi()
  renderSong()
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" })
    if (res.ok) {
      me = (await res.json()).user
      showApp()
    } else {
      showAuth("")
    }
  } catch (_) {
    showAuth("No connection. Check your internet and reopen the app.")
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
}

boot()
