import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.dirname(new URL(import.meta.url).pathname);
const certDir = path.join(root, '.certs');

/**
 * Built-in sample packs for this device only.
 * tools/build-packs.mjs turns ./local-packs into ./packs (extracted + pre-analysed index.json).
 * Dev server serves ./packs; `npm run build:apk` (INCLUDE_PACKS=1) copies them into dist for the APK.
 * Plain `npm run build` never includes them. Both folders are gitignored.
 */
function bundledPacks() {
  const packsDir = path.join(root, 'packs');
  return {
    name: 'roomservice-bundled-packs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        const m = /\/packs\/(.+)$/.exec(url);
        if (!m) return next();
        const file = path.normalize(path.join(packsDir, m[1]));
        if (!file.startsWith(packsDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'audio/wav');
        res.setHeader('Content-Length', fs.statSync(file).size);
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!process.env.INCLUDE_PACKS || !fs.existsSync(packsDir)) return;
      fs.cpSync(packsDir, path.join(root, 'dist', 'packs'), { recursive: true });
      console.log('[packs] bundled into dist/packs');
    }
  };
}

// HTTPS on the LAN (npm run dev:lan) so the phone / RG477V gets a secure context:
// AudioWorklet, Gamepad API and persistent storage all require it.
const lanHttps =
  process.env.LAN_HTTPS && fs.existsSync(path.join(certDir, 'key.pem'))
    ? { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }
    : undefined;

export default defineConfig({
  base: './',
  plugins: [bundledPacks()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    https: lanHttps
  }
});
