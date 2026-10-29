# huddle-livekit

LiveKit is the media server for Huddle voice (and later screen share). Browsers
talk to it directly; the `huddle` service only hands out join tokens.

## How it works on Railway

Railway has **no inbound UDP**, which WebRTC normally uses. So media runs over
**ICE/TCP** through a Railway **TCP proxy**:

```
browser ──wss──▶ huddle-livekit-….up.railway.app ──▶ :7880   signalling
browser ──tcp──▶ <something>.proxy.rlwy.net:<port> ──▶ :7881  media (audio)
```

LiveKit has to tell browsers the proxy's public IP and port, not its own.
`entrypoint.sh` handles that on boot: it reads `RAILWAY_TCP_PROXY_DOMAIN` /
`RAILWAY_TCP_PROXY_PORT`, resolves the domain to an IP, has LiveKit advertise
that IP and port, and forwards the proxy's traffic from 7881 to LiveKit
(`socat`, to the container's own IP, because LiveKit drops ICE/TCP arriving on
loopback).

Tested 2026-10-29 in the sandbox with UDP blocked and a fake proxy that
renames the port like Railway's does: 3 browsers, audio both ways, 0% loss,
0 reconnects over 2 minutes. The real test is 3 people on the internet.

Trade-off: audio over TCP is fine on a clean connection but a lost packet
stalls everything behind it, so on bad Wi-Fi it can stutter more than UDP
would. That's what the 10-minute test is checking.

## Railway setup (one time)

Project `huddle` (the one with `huddle` + `huddle-postgres`).

1. **New service from the repo.** *+ Create → GitHub Repo → Talkingvet/huddle.*
   Rename it `huddle-livekit`.
2. **Point it at this folder.** Service → *Settings*:
   - *Source → Root Directory*: `/livekit`
   - *Config-as-code → Railway Config File*: `/livekit/railway.json`
     (without this it picks up the root `railway.json` and tries to build the Node app)
3. **Variables** (service → *Variables*):
   | Name | Value |
   |---|---|
   | `LIVEKIT_API_KEY` | `huddle` |
   | `LIVEKIT_API_SECRET` | 64 random characters — on the Mac: `openssl rand -hex 32` |
   | `PORT` | `7880` |
4. **Networking** (service → *Settings → Networking*):
   - *Generate Domain* → port **7880**.
   - *TCP Proxy* → port **7881**. Railway shows something like
     `shinkansen.proxy.rlwy.net:41234` — that's the media address.
5. **Redeploy** the service (the TCP proxy variables only appear after a deploy).
   Deploy logs should show:
   `[huddle-livekit] mode: railway (ICE/TCP via ….proxy.rlwy.net:41234 → <ip>)`
   and `forwarding :7881 → <ip>:41234`.
   Opening `https://<livekit domain>/` in a browser shows `OK`.
6. **Tell the app where LiveKit is.** `huddle` service → *Variables*, add:
   | Name | Value |
   |---|---|
   | `LIVEKIT_URL` | `wss://${{huddle-livekit.RAILWAY_PUBLIC_DOMAIN}}` |
   | `LIVEKIT_API_KEY` | `${{huddle-livekit.LIVEKIT_API_KEY}}` |
   | `LIVEKIT_API_SECRET` | `${{huddle-livekit.LIVEKIT_API_SECRET}}` |
   Deploy `huddle`.

## The test

`https://huddle-production-f9a4.up.railway.app/voice-test` — everyone signs in,
clicks **Join voice test**, talks for 10 minutes, then clicks **Copy
diagnostics** and sends the text back.

**Pass** if all of these hold for all 3 people:
- everyone hears everyone, both directions, the whole time;
- *Media path* says **TCP** and the address is the `….proxy.rlwy.net` IP;
- *Reconnects* 0 (1 is OK if it recovered on its own within a few seconds);
- *Packet loss* stays under ~2%, *Round trip* under ~150 ms;
- nobody describes it as robotic, choppy, or delayed.

**Fail → VPS** if audio cuts out, sounds robotic, lags noticeably, or anyone
can't connect at all.

## Troubleshooting

- **Joins, shows everyone, but silence / "could not establish pc connection"**
  → the TCP proxy is missing, points at the wrong port (must be 7881), or the
  service wasn't redeployed after adding it. Check the deploy log lines above.
- **Worked yesterday, fails today** → Railway may have moved the proxy to a
  new IP. Redeploy `huddle-livekit` (it looks the IP up at boot). If that keeps
  happening, that's another point for the VPS.
- **"Voice isn't configured on the server yet"** → step 6 on the `huddle` service.
- **Logs say `could not find the container's IPv4 address`** → set
  `LIVEKIT_FORWARD_IP` to the address shown by Railway's private network, or
  go to the VPS.

## Fallback: LiveKit on a VPS

Same image, real UDP. Everything else stays on Railway; only `LIVEKIT_URL`
changes. About 30–45 minutes.

1. **Server.** Hetzner Cloud (cheapest shared x86, Ashburn VA or Hillsboro OR
   for US players) or a DigitalOcean basic droplet, ~$5–7/month, Ubuntu 24.04.
   Check the current price when buying; 2 vCPU / 2–4 GB is plenty for 10 voices.
2. **Firewall** (provider's firewall panel): allow inbound
   TCP 22, 80, 443, 7881 and **UDP 7882**. Nothing else.
3. **Install Docker** on the server: `curl -fsSL https://get.docker.com | sh`
4. **Get the code**: `git clone https://github.com/Talkingvet/huddle.git && cd huddle/livekit/vps`
   (private repo → use a GitHub token, or copy just the `livekit/` folder over with `scp`).
5. `cp .env.example .env` and fill it in. `LIVEKIT_HOST` can be
   `lk.<ip-with-dashes>.sslip.io` — no domain purchase needed; Caddy gets a
   free certificate for it automatically.
6. `docker compose up -d --build`, then `docker compose logs livekit` should
   show `mode: direct`. `https://<LIVEKIT_HOST>/` shows `OK`.
7. On Railway, `huddle` service: `LIVEKIT_URL` = `wss://<LIVEKIT_HOST>`, and
   make `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` match the VPS `.env`
   (plain values instead of the `${{huddle-livekit…}}` references).
   Then delete or pause the `huddle-livekit` Railway service.
8. Re-run the 10-minute test. *Media path* should now say **UDP**.

The VPS route also wins on bandwidth cost once screen share arrives (flat
monthly traffic allowance vs. Railway's per-GB egress) — worth re-checking
after batch 5 even if Railway passes today.
