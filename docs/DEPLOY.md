# ROOMSERVICE — Build & GitHub Pages Deployment

## 1. Local Development

```bash
npm run dev      # Starts Vite with --host (LAN access at http://<local-ip>:5173/)
npm run build    # Compiles dist/ with relative ./ paths (vite.config.js base: './')
```

> **Network Note:** On the current home network, outbound tunnel ports (`22` for `localhost.run` / `pinggy` and `7844` for `cloudflared`) time out / are blocked. Use GitHub Pages (`gh-pages`) for HTTPS testing on phones away from local Wi-Fi.

## 1b. Local HTTPS build for the phone / RG477V (home network)

```bash
npm run dev:lan   # https://<mac-lan-ip>:5173  (self-signed cert in .certs/, gitignored)
```

- Phone/RG477V and Mac on the same Wi-Fi. First visit: Chrome warns about the certificate → Advanced → Proceed. HTTPS is required for AudioWorklet (TAPE deck, TAPE-1, DRIVE), the Gamepad API and persistent storage.
- Regenerate the cert if the Mac's LAN IP changes:
  `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout .certs/key.pem -out .certs/cert.pem -subj "/CN=ROOMSERVICE LAN" -addext "subjectAltName=IP:<lan-ip>,IP:127.0.0.1,DNS:localhost"`
- **Local packs:** drop sample-pack ZIPs you are licensed to use into `local-packs/` (gitignored). The dev server serves them and the LIBRARY imports them automatically on first launch. They are never part of `npm run build`, so they never reach GitHub Pages.

## 2. Subpath-Safe PWA Checklist

Because GitHub Pages serves this project under `/ROOMSERVICE/` (`https://nonothinginc.github.io/ROOMSERVICE/`):
1. `vite.config.js` keeps `base: './'`.
2. `index.html`, `public/manifest.webmanifest`, `public/sw.js`, and `src/main.js` use `./` relative URLs (`./sw.js`, `./manifest.webmanifest`, `./icon.svg`, `./index.html`).
3. **Always bump `CACHE_NAME` in `public/sw.js`** (e.g. `roomservice-v3` -> `roomservice-v4`) before rebuilding so mobile PWAs replace stale cached JS/CSS assets cleanly.

## 3. Deploying `main` + `gh-pages`

```bash
# 1. Verify production build
npm run build

# 2. Commit & push source changes to main
git add -A
git commit -m "<your commit message>"
git push origin main

# 3. Push fresh dist/ bundle (including .nojekyll) to gh-pages
REMOTE_URL="$(git remote get-url origin)"
touch dist/.nojekyll
(cd dist && git init -b gh-pages && git add -A && git commit -m "Deploy ROOMSERVICE to GitHub Pages" && git push -f "$REMOTE_URL" gh-pages:gh-pages)
rm -rf dist/.git

# 4. Verify live deployment (wait ~15s after push)
gh api repos/nonothinginc/ROOMSERVICE/pages/builds/latest --jq '{status, updated_at, commit: .commit[0:7]}'
curl -sI https://nonothinginc.github.io/ROOMSERVICE/ | head -n 5
```
