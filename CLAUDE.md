# lyrsync — Claude context

iPhone web app (PWA) to identify the song that's playing and follow its lyrics in sync. Live at
https://lyrsync.bashir.my.id. Users: Bashir (owner, admin username `bashirsyauqi`), his wife (`bells`), approved friends.

Read `README.md` first (sync modes, accounts CLI, deploy, Shazam limits). Server-wide facts (VPS, Caddy,
PocketBase, security, backups) are in `~/.claude/CLAUDE.md`.

Original conversations (everything the owner asked and decided, 2026-09-26 → 10-03, all apps; search them when a
detail is missing): `~/work/tx_user.txt` (owner's messages), `~/work/tx_asks.txt` (multiple-choice decisions),
`~/work/tx_assistant.txt` (Claude's longer answers); raw transcript
`~/.claude/projects/-home-bashir/b434ae8c-ff15-4ca3-aa6d-842e57f5a2aa.jsonl`.

## Rules for working on this app

- Never print secrets (Spotify client secret, PocketBase passwords, credential files) into chat or commits.
- Owner prefers step-by-step, click-by-click guidance; budget-conscious; highest reasonable security.
- Git: work on `develop` (it now carries everything that used to be only on local `main`); commit with
  `-c user.name="Bashir" -c user.email="bashirsyauqi@gmail.com"`. Push to `origin/develop` only when the owner asks
  (he asked on 2026-10-03). No PRs to `main` unless asked.
- After every deploy: `systemctl is-active pocketbase lyrsync`.
- Keep working files in `~/work/` (`/tmp` is wiped on reboot).

## Server facts

| Item | Value |
|---|---|
| Backend | `lyrsync.service` (FastAPI `backend/app.py`), user `lyrsync`, 127.0.0.1:8000, sandbox ~1.2, ~70 MB RAM. `SystemCallErrorNumber=EPERM` is **required** (numpy calls `mbind`, which otherwise kills the process with SIGSYS) |
| Code | `/opt/lyrsync` (+ venv), web `/srv/lyrsync`, state `/var/lib/lyrsync` (Spotify tokens `spotify/<uid>.json`, dir 0700) |
| Secrets | `/etc/lyrsync/env` (`root:lyrsync 0640`, optional `EnvironmentFile=-`): **doesn't exist yet** — create it with `LYR_SPOTIFY_CLIENT_ID` / `LYR_SPOTIFY_CLIENT_SECRET` for Spotify mode. No service login: the backend acts with each user's own PocketBase token. Other settings (`LYR_PB_URL`, `LYR_PUBLIC_URL`, `LYR_STATE_DIR`, `LYR_SHAZAM_COUNTRY`=ID) default in `backend/app.py` |
| Deploy | `./deploy/deploy.sh` → backend to `/opt/lyrsync`, web to `/srv/lyrsync`, PB migrations/hooks to `/var/lib/pocketbase/` (copied only when changed), restarts pocketbase + lyrsync |
| Caddy | `deploy/Caddyfile.lyrsync`: static + `/api/*` → 8000; Permissions-Policy `microphone=(self)`, `screen-wake-lock=(self)`; CSP `img-src` includes `https://i.scdn.co` (Spotify art) |
| Dev venv | `~/work/lyr-venv` |

## How it works

- Browser records the mic and sends **16 kHz mono WAV only** (no ffmpeg on the server); `web/mic.js` +
  `web/recorder-worklet.js` (BashGames reused this recorder idea).
- Recognition: shazamio 0.8.1 with a custom **one-shot** HTTP client (the default retries 429s up to 20×). Limits:
  1 listen / 4 s and 150 / h per user, 600 / h server-wide, back-off 60 s → 30 min after a Shazam 429.
  Progressive clips + automatic retries; "Always" mode (Listen becomes Resync).
- Lyrics: LRCLIB. History/favourites in PocketBase (`lyr_history`, `lyr_favorites`).
- Session = httpOnly SameSite=Strict cookie holding the PocketBase token; state-changing requests need header
  `X-Lyrsync: 1`. Front end retries GETs after a long sleep (iOS stale connection).
- **Spotify follow mode** (no mic): polls `/v1/me/player/currently-playing` (exact position) via `/api/spotify/*`.
  Dev-mode Spotify app: owner needs Premium, max 5 users, redirect `https://lyrsync.bashir.my.id/api/spotify/callback`.
- **Tap-to-sync** for Apple Music / YouTube Music (no now-playing API on iOS web): search the song, tap the line you
  hear; ⏸/▶. Music playing on the same iPhone can't be heard by the mic (iOS switches to call audio).
- AudD fallback: not built (owner declined).

## Owner's decisions (interview 2026-09-26)

- Goal: iPhone web app with **Listen** and **Always listen** buttons using the free Shazam package (shazamio).
- Always-listen = **Smart**: re-checks just after the song should end (song changes caught within ~8 s) plus a
  light check every 45 s for skips. Don't go below 30 s: ~80 req/h at 45 s, 120 at 30 s, 180 at 20 s (over the
  150/h per-user cap; risk of Shazam throttling the server's single IP for everyone — shazamio is unofficial).
  Owner asked for a manual **⟳ Resync** button instead (left button while Always is on; re-aligns timing on the same
  song, checks once more 10 s later; spins + disabled while checking; waits out the 4 s limit itself).
- Listen is **progressive**: first try after 4 s, then longer clips (8 s, 10 s) every ~4 s until ~24 s; connection/
  Shazam errors auto-retry up to 2×; short rate-limit waits (≤10 s) are waited out. Always mode's first try also 4 s;
  change checks keep full 8 s clips. (Owner may ask to move the first try to 5 s if it's too eager.)
- Lyrics: **synced + full-lyrics toggle**. Look: **album-art glow**. Language: **English**. Address lyrsync.bashir.my.id.
- Extras chosen: manual search, sync nudge buttons (±0.5 s), open in Apple Music / Spotify.
- Accounts: first "static username/password", then changed by the owner to **register + admin approval** with
  `bashirsyauqi` as superadmin (Approvals page only for admins). History + favourites stored in the **shared
  PocketBase** so later apps reuse the same accounts.
- Owner plays music with **Spotify Premium** on his iPhone (also YouTube Music sometimes). iOS gives no app (not
  even native apps) access to another app's Now Playing info — Android would; so Spotify mode + tap-to-sync.
- Install: Safari → Share → Add to Home Screen ("Open as Web App" on). Updates: swipe the app closed and reopen
  (sometimes twice; offline cache). Mic permission: Settings → Apps → Safari → Microphone.

## Shared accounts (owned by this repo's migrations)

lyrsync's `pb_migrations/` changed the shared PocketBase `users` collection that **finance, the shop admin and
BashGames also use**: login by `username`, open registration but `authRule = "approved = true"`, `role` = `admin`
for admins; only admins approve (Approvals screen here, also Profil → Admin in BashGames); nobody can self-approve
or self-promote (tested). Machine logins (`svc_*`) have other roles (`service`, `shop_web`, `shop_admin`, `games`):
lyrsync and finance reject any role other than ''/`admin` at login and hide them from Approvals.
Create/reset a login on the server: `lyr-user` PocketBase CLI command (README); shred the credentials file after.
**Be careful with migrations here: they affect every app's logins.**

## History

- 2026-09-27 — Machine-login roles refused at login and hidden from Approvals.
- 2026-09-26 — Built and deployed; Spotify follow mode + tap-to-sync; GET retries after sleep; deploy copies PB
  files only when changed (avoid hook-watch restarts); EPERM for blocked syscalls; Caddy cache-control matcher fix.

## Open owner tasks

- [ ] Create the Spotify developer app and put its Client ID/Secret into `/etc/lyrsync/env` (steps given
      2026-09-26), then Menu → Spotify on both phones; add the wife's Spotify email under User Management.
- [ ] Change the owner's login password (the old one was shared in a chat).
