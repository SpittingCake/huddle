# Huddle — TODO

Start every session here, after a git sync check (`git fetch` → ahead/behind/dirty).
Plan and batch order: `Huddle-Plan.md` §5.

## ▶ NEXT UP (2026-10-29, evening)

**Batch 2 — server & channels: BUILT 2026-10-29, uncommitted, needs Danny's push + a look on Railway.**
1. Commit + push (`git add -A && git commit -m "Batch 2: server settings, channel/category CRUD, invite UI" && git push origin main`). Railway redeploys; migration `002_channels.sql` runs itself on boot.
2. Smoke it live: sign in → gear next to the server name → rename the server, add a category + a channel, make an invite in the Invites tab (it copies the link). Open the link in a private window: it should say "You've been invited to <server>".
3. Still open from batch 1: the 3-person 10-minute `/voice-test` (invite link exists; need 3 people). Pass/fail in `livekit/README.md`. Decide Railway-vs-VPS before batch 4.
4. Still unconfirmed from batch 0: 2-device presence check (sign in on phone + Mac, both dots green).

Next session: **batch 3 (text channels)** — messages, replies, edit/delete, reactions, pins, attachments (needs the Railway volume), unread/mentions, typing, paging. Server icon + avatars ride along with attachments.

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
