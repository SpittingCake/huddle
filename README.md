# Huddle

Voice + text for gaming with friends. One server, text channels, voice channels you click to join, screen share with game audio, and presence that shows what you're playing. Built to stay out of the way of the game.

Plan and build order: [`docs/Huddle-Plan.md`](docs/Huddle-Plan.md). Current state: **batch 4** (sign-in + invites, server/channel settings, text channels with the works, and click-to-join voice channels — cap of 10, mute/deafen, voice activity or push-to-talk, per-person volume).

## Layout

```
server/   Node/Express API + Socket.IO, Postgres, serves the built client
client/   Vite + React web app
docs/     Plan, runbook, session notes
```

## Run it locally

Needs Node 20+ and a Postgres you can reach.

```bash
npm install                      # installs server + client (npm workspaces)
cp server/.env.example server/.env
#   edit server/.env: DATABASE_URL, JWT_SECRET, OWNER_USERNAME, OWNER_PASSWORD
npm run dev:server               # API on :3000 (runs migrations + creates the owner on first boot)
npm run dev:client               # web app on :5173, proxies to :3000
```

Open http://localhost:5173 and sign in with the owner username/password from `.env`.

Production-style (one process, built client):

```bash
npm run build && npm start       # http://localhost:3000
```

## Tests

```bash
DATABASE_URL=postgres://.../huddle_test npm test
```

Runs against a real Postgres and **wipes that database** — point it at a throwaway one.

## Deploy (Railway)

One Railway project, three services:

| Service | What | Notes |
|---|---|---|
| `huddle` | this repo, root directory `/` | Build: `npm run build`. Start: `npm start`. **Volume** mounted at `/data` + `UPLOAD_DIR=/data/uploads` for attachments. |
| `huddle-postgres` | Railway Postgres | `DATABASE_URL` → `${{huddle-postgres.DATABASE_URL}}` |
| `huddle-livekit` | `livekit/` (Dockerfile) | Media server. Optional `LIVEKIT_WEBHOOK_URL` → `https://<huddle domain>/api/voice/webhook`. See `livekit/README.md`. |

Variables for `huddle`: everything in `server/.env.example` (`TRUST_PROXY=true`, `SERVER_URL` = the Railway domain). `PORT` is set by Railway.

## Conventions

- Commits are made and pushed by Danny; no AI attribution lines in the repo.
- Each build batch = one session, ends with a pushed commit and a short test list in `docs/Huddle-TODO.md`.
- Performance rules in the plan §4.4 are requirements.
