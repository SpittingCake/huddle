# Huddle — Plan v1

_Personal voice + text app for gaming with friends. Replaces Discord for one friend group._
_Written 2026-10-20. Owner: Danny. Status: §6 decided 2026-10-20; batch 0 built._

---

## 1. What it is

One server (your friend group), with text channels and voice channels in a single left rail.
Click a text channel to read it. Click a voice channel to join it — no ringing, no call, you're
just in. Up to 10 people per voice channel. Screen share with game audio. Presence shows
Online / Idle / DND and what game you're playing.

Explicitly **not** BTI software: no tenants, no feature flags per deploy, no Twilio, no Zoho.
Lives in its own repo on Danny's personal GitHub and its own Railway project.

## 2. Goals and non-goals

**Goals**
- Replace Discord for Danny's friend group — voice channels, text channels, screen share, presence.
- Not hurt game performance: light on RAM, near-zero idle CPU, no in-game overlay, no GPU contention.
- Instant to use: open app → see channels → click voice → talking.
- Friends sign up themselves from an invite link.

**Non-goals for v1** (candidates for v2, listed so nobody builds them by accident)
- Video / camera
- Mobile app
- Multiple servers / server discovery
- Roles beyond Owner and Member
- Threads, voice messages, forum channels
- In-game overlay
- Bots / integrations / webhooks
- Work mode / BTI integration (dropped 2026-10-20)

## 3. Features (v1 scope)

### 3.1 Server & channels
- One server, created on first boot by the owner (Danny). Server name + icon.
- Text channels and voice channels, each with a name and sort order; owner can add/rename/reorder/delete.
- Channel categories are a nice-to-have (collapsible headers) — include only if cheap.
- Invite link (`/invite/<code>`) — owner creates, optional expiry and max uses. Anyone with the link signs up and lands in the server.

### 3.2 Accounts & presence
- Username + password (10-char minimum), display name, avatar upload. Stay-signed-in token like Voice.
- Status: Online / Idle (auto after 10 min no input) / Do Not Disturb / Invisible; custom status text.
- **Activity:** desktop app polls the running-process list every 15 s and matches against a `games` table (exe name → game title). Shows "Playing Elden Ring" on your presence. Owner can add games from the app (pick a running process → give it a name). Toggle to turn activity sharing off.
- Online members list on the right rail, grouped Online / Offline, with activity under each name.

### 3.3 Text channels
- Messages with Markdown-lite (bold, italic, code, code blocks, links), @mentions, replies (quote-style), edit, delete.
- Attachments: images (inline, static until hovered), files up to a size cap (S3-compatible storage — Railway volume or Cloudflare R2).
- Emoji reactions (standard emoji; custom emoji is v2), pins, link previews (fetched server-side, cached, collapsed by default).
- Unread markers per channel and per user; mention badge; scroll-up history paging (reuse Huddle chat paging).
- Typing indicator (reuse).

### 3.4 Voice channels
- Join by clicking; leave with a Disconnect button in the bottom-left voice panel (shows channel name, connection quality, mute/deafen/share/disconnect).
- Members in a voice channel show stacked under the channel name with a green speaking ring.
- Hard cap **10** per channel (server-enforced).
- Audio: Opus via SFU, voice activity detection with adjustable sensitivity, **or** push-to-talk with a global hotkey (works while the game has focus — Electron `globalShortcut`).
- Per-person volume slider, mute someone locally, self mute / deafen.
- Noise gate on by default; stronger noise suppression (LiveKit's Krisp-equivalent / RNNoise) opt-in.
- Sound effects for join/leave/mute (small, can be turned off).

### 3.5 Screen share
- Share a window or screen, **with system audio** (Windows: Electron's `desktopCapturer` with `audio: true`; macOS later).
- More than one person can share at once; viewers pick who to watch. Up to 1080p30 by default, 60 fps toggle for the sharer.
- Watching a share opens a larger center pane; the text channel stays reachable in a split.

### 3.6 Desktop app
- Electron, Windows first (Mac later). Tray icon, minimize to tray, launch at login, auto-update via a GitHub release feed (public repo or a `/download` route on the server like Voice).
- Settings: Audio (devices, PTT/VAD, sensitivity, noise suppression), Appearance (theme, zoom), Activity (on/off, games list), Performance (hardware acceleration auto-off while a game is detected), Startup.
- Also fully usable in Chrome at the server URL (no activity detection, no global PTT hotkey in browser).

## 4. Architecture

### 4.1 Pieces
| Piece | Tech | Where |
|---|---|---|
| API + web app | Node/Express + Socket.IO, Postgres, Vite + React client served by the same server | Railway service `huddle` |
| Database | Postgres | Railway `huddle-postgres` |
| Media (voice + screen share) | **LiveKit** server (open source SFU) | Railway service `huddle-livekit` (Docker image `livekit/livekit-server`) |
| TURN | LiveKit's built-in TURN, or coturn if Railway's networking fights it | Same service / sidecar |
| File storage | Railway volume (v1) → Cloudflare R2 if it grows | Railway |
| Desktop | Electron shell loading the web app | GitHub releases |

Why LiveKit: self-hosted SFU so 10 people × screen shares scale (mesh WebRTC dies around 4–5), Node server SDK for minting join tokens, React components for tracks, built-in VAD/noise suppression, handles screen share audio. Hosting is a flat monthly cost; no per-GB metering like Twilio TURN.

**Update 2026-10-29:** Railway has no inbound UDP. Batch 1 runs LiveKit TCP-only through a Railway TCP proxy (`livekit/README.md`); the 10-minute test decides whether that's good enough.

**Risk to retire first:** LiveKit on Railway needs UDP ports (or at least a TCP fallback + TURN/TLS). Railway's support for UDP has been inconsistent. Batch 1 proves this before anything else is built; fallback is a $6 VPS (Hetzner/DigitalOcean) running only LiveKit, with everything else staying on Railway.

### 4.2 Data model (Postgres)
```
users            id, username, password_hash, display_name, avatar_url, status, custom_status,
                 activity_sharing (bool), token_version, created_at
sessions         id, user_id, device_label, created_at, last_seen   (per-device sign-out, from Voice batch 2)
server           id, name, icon_url, owner_id
channels         id, type (text|voice), name, position, category_id?, created_at
messages         id, channel_id, author_id, body, reply_to_id?, edited_at, deleted_at, created_at
attachments      id, message_id, filename, mime, size, storage_key
reactions        message_id, user_id, emoji   (PK all three)
pins             channel_id, message_id, pinned_by, created_at
read_markers     user_id, channel_id, last_read_message_id
link_previews    url (PK), title, description, image_url, fetched_at
invites          code, created_by, expires_at?, max_uses?, uses
games            id, exe_name, title, added_by
voice_presence   (in memory on the server, not a table) channel_id → [user_id]
```
Carried over from Huddle v0.1: the chat message/typing/unread logic, settings panel, device pickers. Dropped: `huddle_rooms`, call/ring signaling, Twilio NTS token route.

### 4.3 Realtime
One Socket.IO connection per client carries: presence + activity, typing, new/edited/deleted messages, reactions, read markers, voice-channel membership changes. Media never goes over this socket — it goes to LiveKit directly. Joining a voice channel = `POST /api/voice/:channelId/join` → server checks the cap, mints a LiveKit token for room `channel-<id>`, client connects. Leaving = disconnect from LiveKit; the server hears it via the LiveKit webhook and updates membership.

### 4.4 Performance rules (these are requirements, not suggestions)
- No in-game overlay. Ever.
- Message list virtualized; only ~50 messages rendered; images lazy, GIFs paused until hover.
- Link embeds collapsed by default.
- Activity detection = one `tasklist`/`ps` every 15 s, parsed once, cached. Off while idle for an hour.
- Presence/typing debounced; no polling loops — everything pushed over the socket.
- Option to disable hardware acceleration automatically when a game is detected (needs a relaunch; app offers it).
- Budget: < 150 MB RAM idle on Windows, < 1% CPU sitting in a voice channel, no measurable FPS impact in a game with the app in the tray.
- Measure it: a `docs/perf-log.md` with Task Manager numbers at each release.

### 4.5 Security basics (ported from Voice's review batches, scaled down)
- bcrypt passwords, 10-char min, login throttle, helmet, CORS allow-list to the app's own origin, `trust proxy`.
- Per-device sessions + token_version; owner can kick/ban a user (ban = deactivate + invalidate sessions).
- Invite codes are the only way in; no open signup.
- Uploads: type/size checked, served with `Content-Disposition`, never executed.
- Link-preview fetcher: allow-list http(s), block private IP ranges, 5 s timeout, 1 MB cap.

## 5. Build order

Each batch is one session; each ends with a commit Danny pushes and a short test list.

| # | Batch | Proves / delivers |
|---|---|---|
| 0 | Repo + skeleton | Fresh repo `huddle` on Danny's GitHub; server + client + electron folders; this plan in `docs/`; `.env.example`; Railway project with `huddle` + `huddle-postgres`; login works. |
| 1 | **LiveKit on Railway** | `huddle-livekit` deployed; a throwaway test page where Danny + Paul + 1 more join a room and talk for 10 minutes. **If this fails, move LiveKit to a VPS before continuing.** |
| 2 | Server & channels | Server created on first boot; text/voice channel CRUD for the owner; left rail UI; invite links + self-signup. |
| 3 | Text channels | Messages, replies, edit/delete, reactions, pins, attachments, unread/mentions, typing, paging — port from Huddle chat. |
| 4 | Voice channels | Join/leave by click, cap of 10, stacked avatars + speaking ring, mute/deafen, VAD + PTT (global hotkey in Electron), per-person volume, join/leave sounds. |
| 5 | Screen share | Share with game audio, multiple sharers, viewer pane, 60 fps toggle. |
| 6 | Presence & activity | Status, custom status, idle detection, games table, process polling in Electron, right-rail member list. |
| 7 | Desktop app | Rename/retarget `electron-huddle`, tray, launch at login, auto-update feed, Settings tabs incl. Performance. Windows installer. |
| 8 | Polish & perf pass | Virtualized list, lazy media, perf numbers in `docs/perf-log.md`, link previews, sound/notification settings. |

Realistic: batches 0–1 in one session, then roughly one batch per session. First real "game night" test after batch 5.

## 6. Decisions for Danny

Already decided (2026-10-20):
- Name stays **Huddle**; no BTI in the name or UI.
- Fresh repo on Danny's personal GitHub.
- Voice + screen share, **no video**.
- Max **10** per voice channel. Joining, not ringing. Activity status is in.

Decided 2026-10-20 (all recommendations taken):
1. **Repo visibility:** private, with a `/download` route on the server for installers.
2. **Where friends' files live:** Railway volume for v1 (R2 if it grows).
3. **Push-to-talk default:** voice activity with a noise gate; PTT one click away.
4. **Mac desktop app:** later (Mac uses Chrome).
5. **Custom emoji:** v2.
6. **Screen share:** 1080p30 default, 60 fps toggle for the sharer.
7. **Starting point:** fresh code, nothing copied from the earlier BTI Huddle prototype.

## 7. Cost estimate (monthly)
- Railway: `huddle` + Postgres ~$5–10; `huddle-livekit` ~$5–15 depending on usage. Or LiveKit on a $6 VPS.
- Bandwidth is the variable: one 1080p30 screen share ≈ 2–4 Mbps per viewer. A 4-hour game night with 2 sharers and 6 viewers is ~20–40 GB. Check Railway's egress pricing after batch 1 — this is the other reason a VPS for LiveKit might win.
- Domain (optional): a `.app` or `.gg` for the invite links to look nice.
