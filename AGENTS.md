# Three Moves Ahead — Project Instructions (`AGENTS.md`)

**Three Moves Ahead** is a Devvit Web (`@devvit/web`) Reddit application running inside Reddit iFrames (React 19 + Tailwind 4 + Vite client, Node 24 + Hono serverless backend, shared isomorphic engine).

## Architecture & Layout

- `/src/client/`: React 19 UI (`splash.html`/`splash.tsx` for lightweight inline feed preview; `game.html`/`game.tsx` for full experience). Any new HTML entrypoint must be added to `devvit.json` under `post.entrypoints`.
- `/src/server/`: Hono API (`/api/*`) and internal endpoints (`/internal/{menu,form,triggers,...}`) using `redis`, `reddit`, `settings`, and `context` from `@devvit/web/server`. Keep `devvit.json` in sync when adding/renaming internal menu, form, or scheduler endpoints.
- `/src/shared/`: Environment-agnostic pure domain logic and payload types shared by client and server. Imports in Node-tested paths must include explicit `.ts` extensions (`node --experimental-strip-types`).

## Canonical Commands

- **Full verification:** `npm run check` (`npm run test:types && npm run lint && npm run test:unit && npm run build`)
- **Single test file:** `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/your-file.test.ts`
- **Live Reddit playtest:** `npm run dev` (`devvit playtest`)

## Domain & Platform Invariants

- **Server-authoritative UTC day:** Never let the client choose user ID, score, ghost sequences, or authoritative day; derive `YYYY-MM-DD` UTC day on the server.
- **Zero data leakage:** Never return the hidden 9-ghost daily field, server bot seed, or raw Reddit user IDs/usernames in public JSON responses or client bundles.
- **Devvit Redis tie-rank constraint:** `ZCOUNT` is unsupported; compute shared-tie ranks from a bounded score-frequency hash (`0..81`) updated inside the same `WATCH/MULTI/EXEC` submission transaction.
- **Idempotent Reddit side effects:** Reserve Reddit post/comment actions atomically in Redis before calling Reddit APIs so retries or crashes never create duplicate posts or comments.
- **Devvit Web client limits:** File downloads must use Clipboard API + `showToast`; geolocation, camera, microphone, web notifications, and inline `<script>` tags in HTML files are unavailable/forbidden.

Reference: `https://developers.reddit.com/docs/llms.txt`
