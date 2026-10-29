# Huddle — TODO

Start every session here, after a git sync check (`git fetch` → ahead/behind/dirty).
Plan and batch order: `Huddle-Plan.md` §5.

## ▶ NEXT UP (2026-10-29, late evening)

**Batch 3 — text channels: BUILT 2026-10-29, uncommitted, needs Danny's push + a Railway volume + a look.**
1. Commit + push (`git add -A && git commit -m "Batch 3: text channels — messages, replies, reactions, pins, uploads, unread, typing" && git push origin main`). Railway redeploys; migration `003_messages.sql` runs itself on boot. `multer` is a new server dependency — Railway's `npm ci` picks it up from the lockfile.
2. **Add a Volume** to the `huddle` service on Railway (service → Settings → Volumes → mount path `/data`), then add the variable `UPLOAD_DIR=/data/uploads` to the `huddle` service. Without it, uploads still work but are wiped on every redeploy. Railway restarts the service when you add the volume.
3. Smoke it live: open #general → send a message with `**bold**`, a link and `@paul` → hover it → react, reply, pin (📌 counter in the header). Paste a screenshot into the box (Cmd+V) and send. Click your name bottom-left → change your picture. Owner gear → Overview → Change icon. From a second device/private window as another user: post in a different channel and check the bold channel name + red mention badge, then open it and watch the badge clear on the first device too.
4. Still open from batch 1: the 3-person 10-minute `/voice-test` (invite link exists; need 3 people). Pass/fail in `livekit/README.md`. Decide Railway-vs-VPS before batch 4.
5. Still unconfirmed from batch 0: 2-device presence check (sign in on phone + Mac, both dots green).

Next session: **batch 4 (voice channels)** — join/leave by click, cap of 10, stacked avatars + speaking ring, mute/deafen, VAD + PTT (global hotkey comes with Electron in batch 7), per-person volume, join/leave sounds. Replaces `/voice-test` and `routes/voice.js`'s test token with `POST /api/voice/:channelId/join` + LiveKit webhooks for membership.

## Batch 3 — text channels (built 2026-10-29)
- Migration `003_messages.sql`: `messages` (soft delete via `deleted_at`), `attachments` (kind = message / avatar / icon; random `storage_key` = public URL `/files/<key>`), `reactions`, `pins`, `read_markers`, `message_mentions` (parsed server-side so unread/mention counts are one query).
- `routes/messages.js` (`/api/channels`): `GET /unread` (per-channel unread + mention counts); per text channel: `GET /:id/messages?before&limit` (pages of 50, newest first, `has_more`, `last_read_message_id`, `pin_count`), `POST` (body ≤ 2000 chars, `reply_to_id`, `attachment_ids` — only your own unattached uploads), `PATCH` (author only, re-parses mentions), `DELETE` (author or owner; files removed from disk, replies show "original deleted"), `PUT/DELETE …/reactions/:emoji` (standard emoji only — regex rejects text), `GET /pins`, `PUT/DELETE /pins/:mid` (anyone), `POST /read` (never moves backwards; posting marks your own message read). Voice channels return `not_text_channel`.
- `helpers/files.js` + `routes/uploads.js` + `routes/me.js`: multer to `UPLOAD_DIR`; 5 files / 25 MB per message; executables (.exe/.bat/.sh/.js/…) rejected; non-images stored as `application/octet-stream` and served `Content-Disposition: attachment` + nosniff + `CSP: sandbox`; images inline. Orphaned uploads swept hourly. `PATCH /api/me` (display name), `POST/DELETE /api/me/avatar`, `POST/DELETE /api/server/icon` (owner) — old file deleted on replace.
- `socket.js`: every socket joins `user:<id>` (for `read:updated` to all your devices); `typing` relayed to everyone else (1.5 s guard); routes broadcast `message:new/updated/deleted`, `reactions:changed`, `pins:changed`.
- Client: `Messages.jsx` (list, scroll-up paging that keeps the viewport, NEW divider at your last read, date dividers, Discord-style grouping within 5 min, "n new messages ↓" pill, typing line, pins panel, trims to 300 messages while following the bottom), `Message.jsx` (hover actions, reactions row, reply quote with jump, images lazy + capped at 300 px, **GIFs frozen to first frame until hover**, file cards), `Composer.jsx` (Enter/Shift+Enter, ↑ edits your last message, Esc cancels, @ autocomplete incl. @everyone, 📎 / paste / drag-drop uploads that start immediately, emoji picker), `markdown.jsx` (bold/italic/strike/code/blocks/quotes/links/@mentions → React elements, no HTML injection), `Profile.jsx` (avatar + display name), `Avatar.jsx` (initials fallback), `socket.js` (one shared connection). Rail: bold channel name when unread, red mention badge; tab title `(n)`. Settings → Overview: server icon. Main bundle 224 kB (was 197).
- Tests: `server/test/messages.test.js` — 9 tests. Sandbox: 21/21 across the three suites. Headless-Chromium smoke (two users): 42 checks incl. XSS (`<img onerror>` renders as text) and a 170-message paging run.
- Not done / deferred: link previews (batch 8 — the plan's security rules for the fetcher still apply), virtualized list (batch 8; for now ~50 per page + 300 cap while following), jump-to-reply when the target isn't loaded, browser notifications/sounds (batch 8), kick/ban (batch 6), drag-and-drop reorder still ↑↓.

## Batch 2 — server & channels (built 2026-10-29)
- Migration `002_channels.sql`: `categories` table + `channels.category_id` (nullable; deleting a category leaves its channels uncategorized).
- `routes/server.js`: `PATCH /api/server` (name); channels `POST` / `PATCH :id` (name, category) / `DELETE :id` / `PUT order`; categories `POST` / `PATCH :id` / `DELETE :id` / `PUT order`; invites now return `url` + `created_by_name`. All writes owner-only and broadcast `server:changed` so every open client reloads. Text channel names are slugged (`Elden Ring Chat!` → `elden-ring-chat`); voice/category names kept as typed. The last text channel can't be deleted.
- `routes/auth.js`: public `GET /auth/invite/:code` → `{ valid, server_name }` for the invite page (60/15 min rate limit).
- `socket.js`: `broadcast(event, payload)` helper; no-op before `attach()` so tests don't need a socket.
- Client: `Rail.jsx` (categories as collapsible headers, collapsed state in localStorage, selected channel, owner-only gear/+), `ChannelView.jsx` (header + placeholder), `Settings.jsx` (owner modal, lazy-loaded chunk: Overview / Channels / Invites — inline rename, category dropdown, ↑↓ reorder, delete with confirm, create invite with expiry + max uses and copy link, revoke), `Login.jsx` (invite preview, dead-link message, switch to sign-in). URL is `/c/<id>`; back/forward work. Main bundle still ~197 kB.
- Tests: `server/test/channels.test.js` — 7 tests (invite preview, rename, slugging, categories, reorder, last-text-channel guard, invite list). Sandbox run: 12/12 incl. the 5 auth tests. Headless-Chromium smoke in the sandbox: 19 checks (two owner devices see each other's edits live, invite sign-up lands in the server, member has no gear, dead invite shows message).
- Not done / deferred: drag-and-drop reorder (↑↓ buttons instead), server icon (needs uploads, batch 3), kick/ban (batch 6 with presence).

## Batch 1 — LiveKit (built + deployed 2026-10-29)
- Railway has no inbound UDP → media runs over ICE/TCP through a Railway TCP proxy. `livekit/entrypoint.sh` advertises the proxy's IP + port and forwards 7881 to LiveKit (to the container IP — LiveKit drops ICE/TCP arriving on loopback; that bug was caught in the sandbox test).
- `livekit/`: Dockerfile (`livekit/livekit-server:v1.13.9` + socat), entrypoint, `railway.json`, README (Railway steps, test pass/fail, troubleshooting, VPS fallback), `vps/` (docker compose + Caddy, untested).
- Server: `POST /api/voice/test-token` (signed-in users, room `voice-test`, 2 h token). Needs `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
- Client: `/voice-test` page (lazy-loaded, so the main bundle stays ~190 kB): join/mute/leave, who's in + speaking ring, media path (TCP/UDP), round trip, loss, jitter, reconnects, 10-minute timer, Copy diagnostics. Throwaway — replaced by real voice channels in batch 4.
- Sandbox test: real LiveKit 1.13.9 via the entrypoint, UDP blocked, fake port-renaming proxy, 3 headless Chromes → TCP, 0% loss, 0 reconnects, 2 min. Auth tests 5/5.

## Batch 0 — skeleton (built 2026-10-20, deployed 2026-10-29)
- `server/`: Express + helmet + CORS allow-list + rate-limited `/auth/login` + `/auth/register` (invite-only), per-device `sessions` + `token_version`, migrations runner, first-boot owner + server + `#general` / `Lobby`, Socket.IO presence (online/offline).
- `client/`: login / invite sign-up, shell with rail (channels), main, members (live online dots), sign out (this device).
- `server/test/auth.test.js` — 5 tests against a real Postgres.
- No invite UI yet: create one with
  `curl -X POST $SERVER_URL/api/server/invites -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"max_uses":5}'`
  (get `<token>` from the browser: DevTools → Application → Local Storage → `huddle_token`). Invite UI lands in batch 2.

## Backlog (post-v1, from the plan's non-goals)
- Video, mobile app, multiple servers, roles beyond owner/member, threads, custom emoji, bots, Mac desktop app.
- Self-host hold/join sounds; domain for invite links.
