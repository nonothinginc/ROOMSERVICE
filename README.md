# ROOMSERVICE

Minimalist hardware-first DAW & groovebox web app designed for the **Anbernic RG477V** (`1280x960` 4:3, 120Hz touch + physical gamepad) and mobile Chrome/Safari PWAs. Built with Vanilla ES Modules, Vite, HTML5 Canvas, and Tone.js v15.

- **Live HTTPS App (GitHub Pages):** https://nonothinginc.github.io/ROOMSERVICE/
- **Repository:** https://github.com/nonothinginc/ROOMSERVICE

## Quick Start

```bash
npm install
npm run dev      # Vite dev server with --host on port 5173
npm run build    # Production bundle into dist/
```

## Documentation Index

- [docs/HANDOVER.md](./docs/HANDOVER.md) — Current project state, locked-in decisions, handover protocol, and next-chat prompt.
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — Module map, low-latency audio signal flow, modular DSP plug-in spec, and `.roomservice` ZIP archive format.
- [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) — 3-zone Nothing/Rams hardware shell, themes, meters, custom visualizers, and touch + gamepad ergonomics.
- [docs/DEPLOY.md](./docs/DEPLOY.md) — Build, Service Worker cache bumping, and `gh-pages` deployment instructions.
- [docs/sessions/2026-11-26-session-01.md](./docs/sessions/2026-11-26-session-01.md) — Session 01 changelog (`f21d2fa` to `bbd8bf9`).
- [AGENTS.md](./AGENTS.md) / [SPEC.md](./SPEC.md) — Always-on industrial design rules and hardware control specification.
