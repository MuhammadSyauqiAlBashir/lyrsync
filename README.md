# lyrsync

iPhone web app: tap **Listen** (or keep **Always** on) to identify the song playing and follow its
lyrics in sync.

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
    ./deploy/deploy.sh

Icons: `python3 tools/make_icons.py web/icons`.
