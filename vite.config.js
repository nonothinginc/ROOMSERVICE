import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.dirname(new URL(import.meta.url).pathname);
const certDir = path.join(root, '.certs');
const packsDir = path.join(root, 'local-packs');

/**
 * Local-only sample packs. ZIPs dropped in ./local-packs (gitignored) are served by the
 * dev server at ./local-packs/ and auto-seeded into the LIBRARY on first launch.
 * They are never part of `vite build` output, so they cannot reach GitHub Pages.
 */
function localPacks() {
  return {
    name: 'roomservice-local-packs',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url || '').split('?')[0]);
        const m = /\/local-packs\/(.*)$/.exec(url);
        if (!m) return next();
        if (!fs.existsSync(packsDir)) {
          res.statusCode = 404;
          return res.end();
        }
        if (m[1] === 'index.json') {
          const packs = fs
            .readdirSync(packsDir)
            .filter((f) => /\.zip$/i.test(f))
            .map((f) => ({ file: f, size: fs.statSync(path.join(packsDir, f)).size }));
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(JSON.stringify({ packs }));
        }
        const file = path.join(packsDir, path.basename(m[1]));
        if (!file.startsWith(packsDir) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', fs.statSync(file).size);
        fs.createReadStream(file).pipe(res);
      });
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
  plugins: [localPacks()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    https: lanHttps
  }
});
