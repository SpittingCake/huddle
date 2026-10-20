# Huddle — TODO

Start every session here, after a git sync check (`git fetch` → ahead/behind/dirty).
Plan and batch order: `Huddle-Plan.md` §5.

## ▶ NEXT UP (2026-10-20)

**Batch 0 — deploy + verify** (code built 2026-10-20, see §Batch 0 below)
1. Commit + push batch 0.
2. Railway: new project `huddle` → add Postgres (`huddle-postgres`) → add GitHub repo service (`huddle`) → set Variables from `server/.env.example` → generate a domain → set `SERVER_URL` to it → redeploy.
3. Open the domain, sign in as the owner. Expect: #general + Lobby in the rail, yourself in Members as online.
4. Open the same URL in a second browser (or phone) → Members shows 1 online in both; close one → back to the other showing it offline.
5. Create an invite (no UI yet — see runbook note below), open `/invite/<code>` in a private window, make a test account, confirm it appears in Members.

**Batch 1 — LiveKit on Railway** (next session)
- Deploy `livekit/livekit-server` as `huddle-livekit`, a throwaway `/voice-test` page, 3 people in a room for 10 minutes.
- If Railway UDP doesn't cooperate: LiveKit on a $6 VPS instead, everything else stays on Railway. Decide before batch 4.

## Batch 0 — skeleton (built 2026-10-20, NOT yet deployed)
- `server/`: Express + helmet + CORS allow-list + rate-limited `/auth/login` + `/auth/register` (invite-only), per-device `sessions` + `token_version`, migrations runner, first-boot owner + server + `#general` / `Lobby`, Socket.IO presence (online/offline).
- `client/`: login / invite sign-up, shell with rail (channels), main, members (live online dots), sign out (this device).
- `server/test/auth.test.js` — 5 tests against a real Postgres.
- No invite UI yet: create one with
  `curl -X POST $SERVER_URL/api/server/invites -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"max_uses":5}'`
  (get `<token>` from the browser: DevTools → Application → Local Storage → `huddle_token`). Invite UI lands in batch 2.

## Backlog (post-v1, from the plan's non-goals)
- Video, mobile app, multiple servers, roles beyond owner/member, threads, custom emoji, bots, Mac desktop app.
- Self-host hold/join sounds; domain for invite links.
