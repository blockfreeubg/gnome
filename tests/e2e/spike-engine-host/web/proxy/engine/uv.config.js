/* Ultraviolet 3.2.10 configuration for GNOME's proxy origin. Loaded by the engine host, by the SW
 * (importScripts) and by UV into every proxied document. The prefix must stay disjoint from Scramjet's
 * "/~/sj/", "/wisp/", "/vendor/" and "/engine/". The xor codec is obfuscation, not secrecy. */
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
