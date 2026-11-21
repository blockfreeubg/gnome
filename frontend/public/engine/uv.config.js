/* Ultraviolet 3.2.10 configuration for GNOME's proxy origin (served unchanged as /engine/uv.config.js).
 * Loaded by the engine host (a classic script after uv.bundle.js), by the service worker (importScripts, SW_IMPORTS in
 * src/shared/proxy-origin.ts) and by UV into every proxied document. The prefix is PROXY_PATHS.ultravioletPrefix and
 * stays disjoint from Scramjet's "/~/sj/", "/wisp/", "/vendor/" and "/engine/". The xor codec is obfuscation, not
 * secrecy: proxied URLs are never secret from the proxied pages. */
/* global Ultraviolet */
self.__uv$config = {
  prefix: '/uv/service/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/vendor/ultraviolet/uv.handler.js',
  client: '/vendor/ultraviolet/uv.client.js',
  bundle: '/vendor/ultraviolet/uv.bundle.js',
  config: '/engine/uv.config.js',
  sw: '/vendor/ultraviolet/uv.sw.js',
};
