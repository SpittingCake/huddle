# huddle-livekit — LiveKit SFU for Huddle voice + screen share.
#
# Railway has no inbound UDP, so media runs over ICE/TCP through a Railway
# TCP proxy. entrypoint.sh works out the proxy's public address and port,
# tells LiveKit to advertise them, and forwards the proxy's traffic to it.
# The same image runs unchanged on a plain VPS (UDP just starts working).
# See livekit/README.md.

FROM livekit/livekit-server:v1.13.9

RUN apk add --no-cache socat

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 7880 = signalling (HTTP/WebSocket), 7881 = ICE/TCP media (Railway TCP proxy target)
EXPOSE 7880 7881

ENTRYPOINT ["/entrypoint.sh"]
