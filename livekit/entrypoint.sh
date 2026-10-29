#!/bin/sh
# Starts LiveKit with a config built from environment variables.
#
# On Railway (RAILWAY_TCP_PROXY_DOMAIN is set):
#   - Signalling (WebSocket) goes through the normal public domain → port 7880.
#   - Media goes over ICE/TCP through the Railway TCP proxy, which forwards
#     <proxy-domain>:<public-port> → container port 7881.
#   - LiveKit has to advertise the proxy's public IP *and* public port to
#     browsers, so it listens for ICE/TCP on <public-port> and socat forwards
#     7881 → <public-port> inside the container.
#
# On a VPS (no Railway variables): LiveKit discovers its public IP itself,
# ICE/TCP on 7881 and UDP mux on 7882 are used directly (open both in the
# firewall). No socat.
#
# Required: LIVEKIT_API_KEY, LIVEKIT_API_SECRET (32+ chars).
# Optional: PORT (signalling, default 7880), LIVEKIT_NODE_IP (override the
#           advertised IP), LIVEKIT_LOG_LEVEL (default info).

set -eu

die() { echo "[huddle-livekit] $*" >&2; exit 1; }
log() { echo "[huddle-livekit] $*"; }

[ -n "${LIVEKIT_API_KEY:-}" ] || die "LIVEKIT_API_KEY is not set"
[ -n "${LIVEKIT_API_SECRET:-}" ] || die "LIVEKIT_API_SECRET is not set"
[ "${#LIVEKIT_API_SECRET}" -ge 32 ] || die "LIVEKIT_API_SECRET must be at least 32 characters"

SIGNAL_PORT="${PORT:-7880}"
ICE_TARGET_PORT=7881   # the port the Railway TCP proxy points at
LOG_LEVEL="${LIVEKIT_LOG_LEVEL:-info}"

resolve_ipv4() {
  # First IPv4 address for a hostname (busybox/musl tools only).
  getent hosts "$1" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1
}

if [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ]; then
  [ -n "${RAILWAY_TCP_PROXY_PORT:-}" ] || die "RAILWAY_TCP_PROXY_PORT missing — add a TCP proxy on port $ICE_TARGET_PORT"
  ICE_PORT="$RAILWAY_TCP_PROXY_PORT"
  NODE_IP="${LIVEKIT_NODE_IP:-}"
  if [ -z "$NODE_IP" ]; then
    i=0
    while [ -z "$NODE_IP" ] && [ $i -lt 10 ]; do
      NODE_IP="$(resolve_ipv4 "$RAILWAY_TCP_PROXY_DOMAIN" || true)"
      [ -n "$NODE_IP" ] || { i=$((i + 1)); sleep 1; }
    done
  fi
  [ -n "$NODE_IP" ] || die "could not resolve $RAILWAY_TCP_PROXY_DOMAIN to an IPv4 address (set LIVEKIT_NODE_IP to override)"
  [ "$ICE_PORT" != "$SIGNAL_PORT" ] || die "TCP proxy public port $ICE_PORT collides with the signalling port"
  IP_CONFIG="  use_external_ip: false
  node_ip: $NODE_IP"
  MODE="railway (ICE/TCP via $RAILWAY_TCP_PROXY_DOMAIN:$ICE_PORT → $NODE_IP)"
else
  ICE_PORT="$ICE_TARGET_PORT"
  if [ -n "${LIVEKIT_NODE_IP:-}" ]; then
    IP_CONFIG="  use_external_ip: false
  node_ip: $LIVEKIT_NODE_IP"
  else
    IP_CONFIG="  use_external_ip: true"
  fi
  MODE="direct (ICE/TCP :$ICE_PORT, UDP :7882)"
fi

CONFIG="port: $SIGNAL_PORT
log_level: $LOG_LEVEL
rtc:
  tcp_port: $ICE_PORT
  udp_port: 7882
$IP_CONFIG
  allow_tcp_fallback: true
room:
  auto_create: true
  max_participants: 10
  empty_timeout: 300
  departure_timeout: 20
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
"

log "mode: $MODE"
log "signalling on :$SIGNAL_PORT"

container_ipv4() {
  # The container's own (non-loopback) IPv4 address.
  a="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1)"
  [ -n "$a" ] || a="$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n1)"
  # Last resort: the kernel's own list of local addresses.
  [ -n "$a" ] || a="$(awk '/\|--/{ip=$2} /32 host LOCAL/{print ip}' /proc/net/fib_trie 2>/dev/null | grep -v '^127\.' | sort -u | head -n1)"
  echo "$a"
}

if [ "$ICE_PORT" != "$ICE_TARGET_PORT" ]; then
  # Forward the TCP proxy's traffic (arrives on 7881) to LiveKit's ICE/TCP port.
  # It must be delivered to the container's real interface address, NOT
  # 127.0.0.1: LiveKit only accepts ICE/TCP connections that arrive on an
  # address it gathered candidates for, and loopback isn't one of them.
  FWD_IP="${LIVEKIT_FORWARD_IP:-$(container_ipv4 || true)}"
  [ -n "$FWD_IP" ] || die "could not find the container's IPv4 address (set LIVEKIT_FORWARD_IP)"
  (
    while true; do
      # Dual-stack listener first; plain IPv4 if the container has no IPv6.
      socat TCP6-LISTEN:$ICE_TARGET_PORT,fork,reuseaddr,ipv6only=0 TCP4:$FWD_IP:$ICE_PORT 2>/dev/null \
        || socat TCP4-LISTEN:$ICE_TARGET_PORT,fork,reuseaddr TCP4:$FWD_IP:$ICE_PORT
      log "socat exited, restarting in 1s"
      sleep 1
    done
  ) &
  log "forwarding :$ICE_TARGET_PORT → $FWD_IP:$ICE_PORT"
fi

# Config via env (not argv) so the API secret doesn't show up in `ps`.
export LIVEKIT_CONFIG="$CONFIG"
exec /livekit-server
