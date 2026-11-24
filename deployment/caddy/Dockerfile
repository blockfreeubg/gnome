# syntax=docker/dockerfile:1
# GNOME's Caddy (WAVE-D §5.3): the official Caddy 2 image (Apache-2.0), pinned by digest, made to run as 65532 with
# no capabilities: the binary's file capability (cap_net_bind_service) is removed, because exec of a binary with file
# capabilities fails under cap_drop: ALL + no-new-privileges. Caddy listens on 8080/8443 inside the container.
ARG CADDY_IMAGE=caddy:2.11-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
FROM ${CADDY_IMAGE}
RUN setcap -r /usr/bin/caddy \
 && mkdir -p /data /config \
 && chown 65532:65532 /data /config \
 && caddy version > /etc/caddy/VERSION
COPY Caddyfile /etc/caddy/Caddyfile
COPY caddy/tls-acme.caddy caddy/tls-files.caddy caddy/bind-any.caddy caddy/bind-loopback.caddy /etc/caddy/
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
LABEL org.opencontainers.image.title="gnome-caddy" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.gnome.caddy-base="${CADDY_IMAGE}"
USER 65532:65532
EXPOSE 8080 8443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
