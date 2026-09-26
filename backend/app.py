"""lyrsync backend: identify songs with Shazam, fetch lyrics from LRCLIB,
and keep per-user history/favourites in PocketBase.

Runs behind Caddy on 127.0.0.1:8000; Caddy serves the web app and forwards
/api/* here. The session cookie holds the user's PocketBase token, so every
PocketBase call is made *as that user* and PocketBase's own rules apply.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import re
import time
import unicodedata
import wave
import warnings
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote, urlparse

import aiohttp
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
warnings.filterwarnings("ignore", message="Couldn't find ffmpeg")  # we only send WAV; no ffmpeg needed
from shazamio import Shazam  # noqa: E402
from shazamio.interfaces.client import HTTPClientInterface  # noqa: E402

log = logging.getLogger("lyrsync")

PB_URL = os.environ.get("LYR_PB_URL", "http://127.0.0.1:8090")
LRCLIB_URL = os.environ.get("LYR_LRCLIB_URL", "https://lrclib.net")
SHAZAM_COUNTRY = os.environ.get("LYR_SHAZAM_COUNTRY", "ID")
USER_AGENT = "lyrsync/1.0 (https://lyrsync.bashir.my.id)"
COOKIE = "lyr_session"
COOKIE_MAX_AGE = 30 * 24 * 3600
EMAIL_DOMAIN = "users.lyrsync.local"  # PocketBase needs an email; nothing is ever sent

USERNAME_RE = re.compile(r"^[a-z0-9_]{3,32}$")
MAX_AUDIO_BYTES = 600_000  # ~18 s of 16 kHz mono 16-bit WAV
COVER_HOSTS = (".mzstatic.com",)


# --------------------------------------------------------------------------
# Rate limiting (in memory; one process)
# --------------------------------------------------------------------------

class Window:
    """Sliding-window limiter: at most `limit` hits per `seconds` per key."""

    def __init__(self, limit: int, seconds: float):
        self.limit, self.seconds = limit, seconds
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def retry_after(self, key: str) -> float:
        """0 if allowed (and records the hit), else seconds to wait."""
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > self.seconds:
            q.popleft()
        if len(q) >= self.limit:
            return self.seconds - (now - q[0])
        q.append(now)
        return 0.0


login_limit = Window(10, 600)
register_limit = Window(5, 3600)
identify_burst = Window(1, 4)  # per user: one request per 4 s
identify_hourly = Window(150, 3600)  # per user
identify_global = Window(600, 3600)  # whole server, protects the one IP Shazam sees


class ShazamCooldown:
    """Server-wide back-off after Shazam answers 429."""

    def __init__(self):
        self.until = 0.0
        self.strikes = 0

    def remaining(self) -> float:
        return max(0.0, self.until - time.monotonic())

    def hit(self) -> float:
        self.strikes += 1
        wait = min(60 * 2 ** (self.strikes - 1), 1800)
        self.until = time.monotonic() + wait
        return wait

    def ok(self):
        self.strikes = 0


cooldown = ShazamCooldown()


def limited(seconds: float, what: str):
    raise HTTPException(429, {"error": f"Too many {what}. Try again in {int(seconds) + 1}s.",
                              "retry_after": int(seconds) + 1})


# --------------------------------------------------------------------------
# Shazam client: one attempt, no automatic retries, 429 reported as such
# --------------------------------------------------------------------------

class ShazamThrottled(Exception):
    pass


class OneShotClient(HTTPClientInterface):
    """shazamio's default client retries up to 20 times on 429, which would
    hammer Shazam while we're being throttled. Make one attempt instead."""

    def __init__(self):
        self.session: aiohttp.ClientSession | None = None

    async def request(self, method: str, url: str, *args, **kwargs):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
        async with self.session.request(method, url, **kwargs) as resp:
            if resp.status == 429:
                raise ShazamThrottled()
            if resp.status >= 400:
                raise RuntimeError(f"shazam http {resp.status}")
            return await resp.json(content_type=None)

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()


# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------

state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    shazam_http = OneShotClient()
    state["shazam"] = Shazam(language="en-US", endpoint_country=SHAZAM_COUNTRY, http_client=shazam_http)
    state["pb"] = httpx.AsyncClient(base_url=PB_URL, timeout=10)
    state["lrclib"] = httpx.AsyncClient(base_url=LRCLIB_URL, timeout=10, headers={"User-Agent": USER_AGENT})
    yield
    await shazam_http.close()
    await state["pb"].aclose()
    await state["lrclib"].aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    body = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
    headers = {"Retry-After": str(body["retry_after"])} if "retry_after" in body else None
    return JSONResponse(body, status_code=exc.status_code, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = str(first.get("loc", ["", "input"])[-1])
    return JSONResponse({"error": f"Invalid {field}: {first.get('msg', 'bad value')}."}, status_code=400)


@app.middleware("http")
async def csrf_and_cache(request: Request, call_next):
    # The session cookie is SameSite=Strict; additionally require a custom
    # header on state-changing requests, which cross-site forms can't send.
    if request.method not in ("GET", "HEAD") and request.headers.get("x-lyrsync") != "1":
        return JSONResponse({"error": "Missing request header."}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def client_ip(request: Request) -> str:
    # uvicorn runs with --proxy-headers trusting only 127.0.0.1 (Caddy)
    return request.client.host if request.client else "unknown"


# --------------------------------------------------------------------------
# PocketBase helpers
# --------------------------------------------------------------------------

async def pb(request: Request, method: str, path: str, token: str | None = None, **kw) -> tuple[int, Any]:
    headers = {"X-Forwarded-For": client_ip(request)}
    if token:
        headers["Authorization"] = token
    try:
        r = await state["pb"].request(method, path, headers=headers, **kw)
    except httpx.HTTPError as e:
        log.warning("pocketbase unreachable: %s", e)
        raise HTTPException(503, "Database is unavailable. Try again shortly.")
    try:
        data = r.json() if r.content else {}
    except ValueError:
        data = {}
    return r.status_code, data


def public_user(rec: dict) -> dict:
    return {"id": rec["id"], "username": rec.get("username", ""), "role": rec.get("role") or "user"}


def set_session(response: Response, token: str):
    response.set_cookie(COOKIE, token, max_age=COOKIE_MAX_AGE, httponly=True, secure=True,
                        samesite="strict", path="/api")


# token -> (checked_at, user record, fresh token)
_session_cache: OrderedDict[str, tuple[float, dict, str]] = OrderedDict()
SESSION_TTL = 60


class Session:
    def __init__(self, token: str, user: dict):
        self.token, self.user = token, user

    @property
    def is_admin(self) -> bool:
        return self.user.get("role") == "admin"


async def current(request: Request, response: Response) -> Session:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Please log in.")
    hit = _session_cache.get(token)
    if hit and time.monotonic() - hit[0] < SESSION_TTL:
        return Session(hit[2], hit[1])
    # auth-refresh checks the token and the collection's authRule (approved),
    # so a revoked account loses access within SESSION_TTL.
    status, data = await pb(request, "POST", "/api/collections/users/auth-refresh", token)
    if status != 200 or "token" not in data:
        _session_cache.pop(token, None)
        response.delete_cookie(COOKIE, path="/api")
        raise HTTPException(401, "Your session has ended. Please log in again.")
    new_token, user = data["token"], data["record"]
    set_session(response, new_token)
    for t in (token, new_token):
        _session_cache[t] = (time.monotonic(), user, new_token)
        _session_cache.move_to_end(t)
    while len(_session_cache) > 500:
        _session_cache.popitem(last=False)
    return Session(new_token, user)


async def admin(s: Session = Depends(current)) -> Session:
    if not s.is_admin:
        raise HTTPException(403, "Admins only.")
    return s


def pb_message(data: Any, fallback: str) -> str:
    fields = (data or {}).get("data") or {}
    for name, err in fields.items():
        if isinstance(err, dict) and err.get("message"):
            return f"{name}: {err['message']}"
    return fallback


# --------------------------------------------------------------------------
# Account endpoints
# --------------------------------------------------------------------------

class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=72)


@app.post("/api/register")
async def register(body: Credentials, request: Request):
    wait = register_limit.retry_after(client_ip(request))
    if wait:
        limited(wait, "sign-ups from this network")
    username = body.username.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Username: 3-32 characters, lowercase letters, numbers or _.")
    status, data = await pb(request, "POST", "/api/collections/users/records", json={
        "username": username,
        "email": f"{username}@{EMAIL_DOMAIN}",
        "password": body.password,
        "passwordConfirm": body.password,
    })
    if status == 200:
        return {"status": "pending"}
    fields = (data or {}).get("data") or {}
    if "username" in fields and fields["username"].get("code") == "validation_not_unique":
        raise HTTPException(409, "That username is taken.")
    raise HTTPException(400, pb_message(data, "Could not create the account."))


@app.post("/api/login")
async def login(body: Credentials, request: Request, response: Response):
    wait = login_limit.retry_after(client_ip(request))
    if wait:
        limited(wait, "login attempts")
    status, data = await pb(request, "POST", "/api/collections/users/auth-with-password",
                            json={"identity": body.username.strip().lower(), "password": body.password})
    if status == 403:  # correct password, but the authRule (approved = true) failed
        raise HTTPException(403, "Your account is waiting for approval.")
    if status != 200 or data["record"].get("role") == "service":  # app service logins can't use lyrsync
        raise HTTPException(401, "Wrong username or password.")
    set_session(response, data["token"])
    return {"user": public_user(data["record"])}


@app.post("/api/logout")
async def logout(response: Response, request: Request):
    _session_cache.pop(request.cookies.get(COOKIE, ""), None)
    response.delete_cookie(COOKIE, path="/api")
    return {"ok": True}


@app.get("/api/me")
async def me(s: Session = Depends(current)):
    return {"user": public_user(s.user)}


class PasswordChange(BaseModel):
    old: str = Field(min_length=1, max_length=72)
    new: str = Field(min_length=8, max_length=72)


@app.post("/api/password")
async def change_password(body: PasswordChange, request: Request, s: Session = Depends(current)):
    status, data = await pb(request, "PATCH", f"/api/collections/users/records/{s.user['id']}", s.token, json={
        "oldPassword": body.old, "password": body.new, "passwordConfirm": body.new})
    if status != 200:
        raise HTTPException(400, pb_message(data, "Could not change the password."))
    # PocketBase invalidates old tokens on password change; log in again.
    return {"ok": True, "relogin": True}


# --------------------------------------------------------------------------
# Admin
# --------------------------------------------------------------------------

@app.get("/api/admin/users")
async def admin_users(request: Request, s: Session = Depends(admin)):
    status, data = await pb(request, "GET", "/api/collections/users/records", s.token,
                            params={"perPage": 200, "sort": "approved,-created", "filter": "role != 'service'",
                                    "fields": "id,username,approved,role,created"})
    if status != 200:
        raise HTTPException(502, "Could not load users.")
    return {"users": [{**public_user(u), "approved": u.get("approved", False), "created": u.get("created")}
                      for u in data.get("items", [])]}


class Approval(BaseModel):
    approved: bool


PB_ID_RE = re.compile(r"^[a-z0-9]{15}$")


def check_id(record_id: str) -> str:
    if not PB_ID_RE.match(record_id):
        raise HTTPException(404, "Not found.")
    return record_id


@app.patch("/api/admin/users/{user_id}")
async def admin_approve(user_id: str, body: Approval, request: Request, s: Session = Depends(admin)):
    status, data = await pb(request, "PATCH", f"/api/collections/users/records/{check_id(user_id)}", s.token,
                            json={"approved": body.approved})
    if status != 200:
        raise HTTPException(400 if status != 404 else 404, "Could not update that user.")
    _session_cache.clear()  # make revocations take effect immediately
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
async def admin_delete(user_id: str, request: Request, s: Session = Depends(admin)):
    status, _ = await pb(request, "DELETE", f"/api/collections/users/records/{check_id(user_id)}", s.token)
    if status != 204:
        raise HTTPException(400 if status != 404 else 404, "Could not delete that user.")
    _session_cache.clear()
    return {"ok": True}


# --------------------------------------------------------------------------
# Lyrics (LRCLIB)
# --------------------------------------------------------------------------

LRC_TIME = re.compile(r"\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]")
LRC_OFFSET = re.compile(r"^\[offset:\s*([+-]?\d+)\]", re.I | re.M)


def parse_lrc(text: str) -> list[dict]:
    offset = 0.0
    if m := LRC_OFFSET.search(text):
        offset = int(m.group(1)) / 1000
    lines = []
    for raw in text.splitlines():
        stamps = LRC_TIME.findall(raw)
        if not stamps:
            continue
        words = LRC_TIME.sub("", raw).strip()
        for mm, ss in stamps:
            lines.append({"t": round(max(0.0, int(mm) * 60 + float(ss) - offset), 2), "text": words})
    lines.sort(key=lambda x: x["t"])
    return lines


def lyrics_payload(item: dict) -> dict:
    synced = parse_lrc(item.get("syncedLyrics") or "")
    return {
        "lrclib_id": item.get("id"),
        "duration": item.get("duration"),
        "instrumental": bool(item.get("instrumental")),
        "synced": synced or None,
        "plain": item.get("plainLyrics") or None,
    }


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def clean_title(title: str) -> str:
    # "Song (feat. X) - Remastered 2011" -> "Song"
    t = re.sub(r"\s*[\(\[][^)\]]*(feat|ft\.|with|remaster|version|edit|live|mix)[^)\]]*[\)\]]", "", title, flags=re.I)
    t = re.sub(r"\s+-\s+.*(remaster|version|edit|live|mix|mono|stereo).*$", "", t, flags=re.I)
    return t.strip() or title


def main_artist(artist: str) -> str:
    return re.split(r"\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*", artist, maxsplit=1, flags=re.I)[0].strip() or artist


def pick_best(items: list[dict], title: str, artist: str, album: str) -> dict | None:
    t, a, al = norm(clean_title(title)), norm(main_artist(artist)), norm(album)

    def score(it: dict) -> float:
        s = 0.0
        it_t, it_a = norm(clean_title(it.get("trackName", ""))), norm(it.get("artistName", ""))
        if it_t == t:
            s += 4
        elif t and (t in it_t or it_t in t):
            s += 2
        if a and a in it_a:
            s += 3
        if al and norm(it.get("albumName", "")) == al:
            s += 1
        if it.get("syncedLyrics"):
            s += 2.5
        elif it.get("plainLyrics"):
            s += 0.5
        return s

    ranked = sorted((i for i in items if i.get("syncedLyrics") or i.get("plainLyrics") or i.get("instrumental")),
                    key=score, reverse=True)
    if ranked and score(ranked[0]) >= 5:
        return ranked[0]
    return None


_lyrics_cache: OrderedDict[str, dict | None] = OrderedDict()


def cache_put(key: str, value: dict | None):
    _lyrics_cache[key] = value
    _lyrics_cache.move_to_end(key)
    while len(_lyrics_cache) > 300:
        _lyrics_cache.popitem(last=False)


async def lrclib_get(path: str, params: dict | None = None) -> Any:
    try:
        r = await state["lrclib"].get(path, params=params)
    except httpx.HTTPError as e:
        log.warning("lrclib unreachable: %s", e)
        raise HTTPException(503, "The lyrics service is unavailable. Try again shortly.")
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise HTTPException(502, "The lyrics service had a problem.")
    return r.json()


async def find_lyrics(title: str, artist: str, album: str = "") -> dict | None:
    key = f"{norm(title)}|{norm(artist)}"
    if key in _lyrics_cache:
        return _lyrics_cache[key]
    queries = [
        {"track_name": title, "artist_name": artist},
        {"track_name": clean_title(title), "artist_name": main_artist(artist)},
        {"q": f"{clean_title(title)} {main_artist(artist)}"},
    ]
    best = None
    seen = set()
    for q in queries:
        qk = tuple(sorted(q.items()))
        if qk in seen:
            continue
        seen.add(qk)
        items = await lrclib_get("/api/search", q) or []
        best = pick_best(items, title, artist, album)
        if best:
            break
    result = lyrics_payload(best) if best else None
    cache_put(key, result)
    return result


@app.get("/api/lyrics")
async def lyrics(request: Request, title: str = "", artist: str = "", album: str = "", lrclib_id: int = 0,
                 s: Session = Depends(current)):
    if lrclib_id > 0:
        key = f"id:{lrclib_id}"
        if key not in _lyrics_cache:
            item = await lrclib_get(f"/api/get/{lrclib_id}")
            cache_put(key, lyrics_payload(item) if item else None)
        return {"lyrics": _lyrics_cache[key]}
    if not title.strip():
        raise HTTPException(400, "Missing title.")
    return {"lyrics": await find_lyrics(title[:300], artist[:300], album[:300])}


@app.get("/api/search")
async def search(q: str, s: Session = Depends(current)):
    q = q.strip()[:200]
    if len(q) < 2:
        return {"results": []}
    items = await lrclib_get("/api/search", {"q": q}) or []
    results = []
    for it in items[:15]:
        title, artist = it.get("trackName") or "", it.get("artistName") or ""
        results.append({
            "track": {
                "track_id": f"lrclib:{it.get('id')}",
                "title": title, "artist": artist, "album": it.get("albumName") or "",
                "cover": "", "isrc": "", "source": "search",
                "duration": it.get("duration"), "lrclib_id": it.get("id"),
                **music_links(title, artist, None),
            },
            "has_synced": bool(it.get("syncedLyrics")),
            "instrumental": bool(it.get("instrumental")),
        })
    return {"results": results}


# --------------------------------------------------------------------------
# Identify (Shazam)
# --------------------------------------------------------------------------

def check_wav(data: bytes) -> float:
    """Accept only small 16-bit mono PCM WAV (what the web app produces).
    Returns the duration in seconds."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            ch, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    except (wave.Error, EOFError):
        raise HTTPException(400, "Audio must be a WAV file.")
    if ch != 1 or width != 2 or not 8000 <= rate <= 48000:
        raise HTTPException(400, "Audio must be 16-bit mono WAV.")
    seconds = frames / rate
    if not 2 <= seconds <= 16:
        raise HTTPException(400, "Audio must be 2-16 seconds long.")
    return seconds


def https_or_empty(url: Any, hosts: tuple[str, ...] | None = None) -> str:
    if not isinstance(url, str):
        return ""
    p = urlparse(url)
    if p.scheme != "https" or not p.hostname:
        return ""
    if hosts and not any(p.hostname.endswith(h) for h in hosts):
        return ""
    return url


def music_links(title: str, artist: str, track: dict | None) -> dict:
    query = f"{title} {artist}".strip()
    apple = ""
    if track:
        # Shazam's "hub" lists Apple Music deep links among its actions.
        for opt in (track.get("hub") or {}).get("options") or []:
            for act in opt.get("actions") or []:
                uri = act.get("uri") or ""
                if uri.startswith("https://music.apple.com/"):
                    apple = uri
                    break
            if apple:
                break
    return {
        "apple_url": apple or f"https://music.apple.com/search?term={quote(query)}",
        "spotify_url": f"https://open.spotify.com/search/{quote(query)}",
    }


def track_from_shazam(track: dict) -> dict:
    title = (track.get("title") or "").strip()
    artist = (track.get("subtitle") or "").strip()
    album = ""
    for sec in track.get("sections") or []:
        for md in sec.get("metadata") or []:
            if md.get("title") == "Album":
                album = md.get("text") or ""
    images = track.get("images") or {}
    return {
        "track_id": str(track.get("key") or f"{norm(title)}|{norm(artist)}")[:100],
        "title": title[:300], "artist": artist[:300], "album": album[:300],
        "cover": https_or_empty(images.get("coverarthq") or images.get("coverart"), COVER_HOSTS),
        "isrc": (track.get("isrc") or "")[:20],
        "source": "shazam",
        **music_links(title, artist, track),
    }


async def read_body(request: Request, limit: int) -> bytes:
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > limit:
        raise HTTPException(413, "Recording is too large.")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, "Recording is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/api/identify")
async def identify(request: Request, s: Session = Depends(current)):
    uid = s.user["id"]
    audio = await read_body(request, MAX_AUDIO_BYTES)
    check_wav(audio)

    if wait := cooldown.remaining():
        limited(wait, "requests to Shazam right now; it asked us to slow down")
    for window, key, what in ((identify_burst, uid, "listens"), (identify_hourly, uid, "listens this hour"),
                              (identify_global, "all", "listens on this server this hour")):
        if wait := window.retry_after(key):
            limited(wait, what)

    try:
        result = await asyncio.wait_for(state["shazam"].recognize(audio), timeout=20)
    except ShazamThrottled:
        wait = cooldown.hit()
        log.warning("shazam throttled us; cooling down %ss", wait)
        limited(wait, "requests to Shazam right now; it asked us to slow down")
    except (asyncio.TimeoutError, aiohttp.ClientError, RuntimeError, ValueError) as e:
        log.warning("shazam failed: %r", e)
        raise HTTPException(502, "Couldn't reach Shazam. Try again.")
    cooldown.ok()

    matches = result.get("matches") or []
    track = result.get("track")
    if not matches or not track:
        return {"match": False, "retry_ms": int(result.get("retryms") or 8000)}

    info = track_from_shazam(track)
    lyr = await find_lyrics(info["title"], info["artist"], info["album"])
    if lyr:
        info["duration"] = lyr["duration"]
        info["lrclib_id"] = lyr["lrclib_id"]
    await add_history(request, s, info)
    return {
        "match": True,
        "track": info,
        # Where in the song the recording started, per Shazam.
        "offset": float(matches[0].get("offset") or 0.0),
        "lyrics": lyr,
    }


# --------------------------------------------------------------------------
# History & favourites
# --------------------------------------------------------------------------

TRACK_KEYS = ("track_id", "title", "artist", "album", "cover", "apple_url", "spotify_url", "isrc", "source",
              "duration", "lrclib_id")


class Track(BaseModel):
    track_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9:|_. -]+$")
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    album: str = Field(default="", max_length=300)
    cover: str = Field(default="", max_length=1000)
    apple_url: str = Field(default="", max_length=1000)
    spotify_url: str = Field(default="", max_length=1000)
    isrc: str = Field(default="", max_length=20)
    source: str = Field(default="search", max_length=20)
    duration: float | None = Field(default=None, ge=0, le=7200)
    lrclib_id: int | None = Field(default=None, ge=0)

    def clean(self) -> dict:
        d = self.model_dump()
        d["cover"] = https_or_empty(d["cover"], COVER_HOSTS)
        d["apple_url"] = https_or_empty(d["apple_url"], ("music.apple.com",))
        d["spotify_url"] = https_or_empty(d["spotify_url"], ("open.spotify.com",))
        return d


def record_out(rec: dict) -> dict:
    return {"id": rec["id"], "created": rec.get("created"), **{k: rec.get(k) for k in TRACK_KEYS}}


async def add_history(request: Request, s: Session, info: dict):
    # Always-listen re-checks the same song; don't log it twice in a row.
    status, data = await pb(request, "GET", "/api/collections/lyr_history/records", s.token,
                            params={"perPage": 1, "sort": "-created", "skipTotal": 1})
    if status == 200 and data.get("items"):
        last = data["items"][0]
        if last.get("track_id") == info["track_id"]:
            return
    payload = {k: info.get(k) for k in TRACK_KEYS if info.get(k) not in (None, "")}
    await pb(request, "POST", "/api/collections/lyr_history/records", s.token,
             json={**payload, "user": s.user["id"]})


async def list_records(request: Request, s: Session, collection: str, page: int) -> dict:
    status, data = await pb(request, "GET", f"/api/collections/{collection}/records", s.token,
                            params={"page": max(1, page), "perPage": 50, "sort": "-created"})
    if status != 200:
        raise HTTPException(502, "Could not load the list.")
    return {"items": [record_out(r) for r in data.get("items", [])],
            "page": data.get("page", 1), "total_pages": data.get("totalPages", 1)}


@app.get("/api/history")
async def history(request: Request, page: int = 1, s: Session = Depends(current)):
    return await list_records(request, s, "lyr_history", page)


@app.post("/api/history")
async def history_add(body: Track, request: Request, s: Session = Depends(current)):
    await add_history(request, s, body.clean())
    return {"ok": True}


@app.delete("/api/history/{rid}")
async def history_delete(rid: str, request: Request, s: Session = Depends(current)):
    status, _ = await pb(request, "DELETE", f"/api/collections/lyr_history/records/{check_id(rid)}", s.token)
    if status != 204:
        raise HTTPException(404, "Not found.")
    return {"ok": True}


@app.get("/api/favorites")
async def favorites(request: Request, page: int = 1, s: Session = Depends(current)):
    return await list_records(request, s, "lyr_favorites", page)


@app.get("/api/favorites/ids")
async def favorite_ids(request: Request, s: Session = Depends(current)):
    status, data = await pb(request, "GET", "/api/collections/lyr_favorites/records", s.token,
                            params={"perPage": 1000, "fields": "id,track_id", "skipTotal": 1})
    if status != 200:
        raise HTTPException(502, "Could not load favourites.")
    return {"ids": {r["track_id"]: r["id"] for r in data.get("items", [])}}


@app.post("/api/favorites")
async def favorite_add(body: Track, request: Request, s: Session = Depends(current)):
    payload = {k: v for k, v in body.clean().items() if v not in (None, "")}
    status, data = await pb(request, "POST", "/api/collections/lyr_favorites/records", s.token,
                            json={**payload, "user": s.user["id"]})
    if status == 200:
        return {"id": data["id"]}
    # Already a favourite (unique user+track): return the existing one.
    status, data = await pb(request, "GET", "/api/collections/lyr_favorites/records", s.token,
                            params={"perPage": 1, "filter": f'track_id = "{body.track_id}"'})  # pattern-checked
    if status == 200 and data.get("items"):
        return {"id": data["items"][0]["id"]}
    raise HTTPException(400, "Could not save the favourite.")


@app.delete("/api/favorites/{rid}")
async def favorite_delete(rid: str, request: Request, s: Session = Depends(current)):
    status, _ = await pb(request, "DELETE", f"/api/collections/lyr_favorites/records/{check_id(rid)}", s.token)
    if status != 204:
        raise HTTPException(404, "Not found.")
    return {"ok": True}


@app.get("/api/health")
async def health():
    return {"ok": True}
