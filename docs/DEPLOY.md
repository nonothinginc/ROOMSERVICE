# ROOMSERVICE — Build & GitHub Pages Deployment

## 1. Local Development

```bash
npm run dev      # Starts Vite with --host (LAN access at http://<local-ip>:5173/)
npm run build    # Compiles dist/ with relative ./ paths (vite.config.js base: './')
```

> **Network Note:** On the current home network, outbound tunnel ports (`22` for `localhost.run` / `pinggy` and `7844` for `cloudflared`) time out / are blocked. Use GitHub Pages (`gh-pages`) for HTTPS testing on phones away from local Wi-Fi.

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
