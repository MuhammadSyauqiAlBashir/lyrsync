# lyrsync

iPhone web app: tap **Listen** (or keep **Always** on) to identify the song playing and follow its
lyrics in sync. Live at https://lyrsync.bashir.my.id.

Three ways to sync:
- **Listen / Always** (microphone + Shazam) for music playing *somewhere else* (car, café, TV).
- **Spotify** (follow mode, no mic): polls the user's currently playing track and exact position. Needs a Spotify
  developer app (dev mode: owner needs Premium, max 5 users, redirect
  `https://lyrsync.bashir.my.id/api/spotify/callback`) and `LYR_SPOTIFY_CLIENT_ID` / `LYR_SPOTIFY_CLIENT_SECRET` in
  `/etc/lyrsync/env` (`root:lyrsync 0640`). Tokens: `/var/lib/lyrsync/spotify/<user id>.json`. **Not configured yet.**
- **Tap-to-sync** for any other app (YouTube Music, Apple Music): search the song, tap the line you hear; ⏸/▶.

Music playing on the same iPhone can't be heard by the mic (iOS switches to call audio; headphones), and iOS gives
web apps no access to "Now Playing" — hence Spotify mode and tap-to-sync.

- `web/` — static PWA (no build step, no external scripts). Records the mic in the browser, downsamples
  to 16 kHz mono WAV, sends it to the backend.
- `backend/app.py` — FastAPI: Shazam recognition (shazamio, one attempt per request with server-side
  back-off), LRCLIB lyrics, accounts/history/favourites via PocketBase.
- `pb_migrations/`, `pb_hooks/` — PocketBase schema (`users` username login + approval,
  `lyr_history`, `lyr_favorites`) and the `lyr-user` CLI command.
- `deploy/` — systemd unit, Caddy site block, `deploy.sh`.

## Accounts
Anyone can register; new accounts can't log in until an admin approves them in the app's
**Approvals** screen. Create or reset a login on the server:

    printf 'username\npassword\n' > /tmp/x.cred   # then:
    sudo -u pocketbase /opt/pocketbase/pocketbase lyr-user /tmp/x.cred [admin] \
      --dir /var/lib/pocketbase/pb_data --hooksDir /var/lib/pocketbase/pb_hooks \
      --migrationsDir /var/lib/pocketbase/pb_migrations
    shred -u /tmp/x.cred

## Deploy
    ./deploy/deploy.sh      # then: systemctl is-active pocketbase lyrsync

Shazam limits: 1 listen / 4 s and 150 / h per user, 600 / h server-wide, back-off 60 s → 30 min after a 429
(shazamio's own 20× retry is replaced by a one-shot client). The front end retries GETs after a long sleep.

Icons: `python3 tools/make_icons.py web/icons`.
