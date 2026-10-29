# Huddle — TODO

Start every session here, after a git sync check (`git fetch` → ahead/behind/dirty).
Plan and batch order: `Huddle-Plan.md` §5.

## ▶ NEXT UP (2026-10-29)

**Batch 1 — LiveKit on Railway: DEPLOYED 2026-10-29, solo join works (TCP). Needs the 10-minute test.**
1. ~~Commit + push~~ done (`7a2f37e`). ~~Railway `huddle-livekit` service~~ done, wired to `huddle`.
2. Invite link made (max 5 uses); 1 friend invited so far. Need 3 people total.
3. All 3 open `/voice-test`, join, talk 10 minutes, each sends back **Copy diagnostics** → paste to Claude.
4. Pass/fail rules are in `livekit/README.md` → "The test". Fail → "Fallback: LiveKit on a VPS" in the same file (compose file ready in `livekit/vps/`). Decide before batch 4.

Still unconfirmed from batch 0: repo set to private; the 2-device presence check.

Batch 2 (server & channels) can start next session — the Railway-vs-VPS call is only needed before batch 4.

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
