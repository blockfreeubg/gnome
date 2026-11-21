/**
 * The service worker build (`vite build -c vite.sw.config.ts`, the second step of `npm run build`): src/sw/sw.ts as
 * ONE classic script, `<dist>/sw.js` (IIFE, no import/export: a classic SW at scope `/` that loads its engines with
 * importScripts). Same `define`s as the app/engine-host build, so both carry the same `__GNOME_BUILD__`.
 */
import { defineConfig } from 'vite';
import { distDir, gnomeDefines } from './vite.config.ts';

export default defineConfig(({ command }) => {
  if (command === 'build' && !process.env.GNOME_BUILD_ID) {
    throw new Error('vite.sw.config.ts: GNOME_BUILD_ID is not set; build with `npm run build` so the app, engine host and sw.js share one build id');
  }
  return {
    configFile: false,
    publicDir: false,
    define: gnomeDefines(),
    build: {
      outDir: distDir(),
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      lib: {
        entry: 'src/sw/sw.ts',
        formats: ['iife'],
        name: 'GnomeServiceWorker',
        fileName: () => 'sw.js',
      },
    },
  };
});
