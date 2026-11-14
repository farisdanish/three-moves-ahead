# Three Moves Ahead — Project Instructions (`AGENTS.md`)

You are writing **Three Moves Ahead**, a Devvit Web application executed inside Reddit.com.

## Iron Rules (Non-Negotiable)

1. **NEVER use local plan labels in committed or tracked artifacts.**
   - Do **not** include milestone IDs, task IDs, acceptance-criteria codes, or local plan terminology (e.g., `m1`, `m2`, `M1-T1`, `AC-1`, `Milestone 1`, `Milestone 2`) in source code, route paths, Redis keys, UI copy, comments, filenames, test descriptions, or git commit messages.
   - Always use descriptive domain and feature names instead (e.g., `arena`, `status`, `sdk-spike`, `ranked`, `practice`, `hub`).
   - Plan and roadmap tracking (`todo.md`, `PROJECT_PLAN.md`, etc.) lives exclusively inside untracked/gitignored `.agent/` or external conversation artifacts.
2. **Never stage or commit secrets or local planning directories.**
   - Keep `.agent/`, `.agents/`, `.env`, setup tokens, bot seeds, and auth tokens out of git and client responses.
3. **Use Devvit Web only.**
   - Never use `@devvit/public-api` or legacy Blocks patterns; this project targets `@devvit/web`.
4. **Keep `devvit.json` in sync.**
   - Whenever adding or renaming an internal menu item, form handler, or scheduler endpoint, update its mapping in `devvit.json`.

---

## Tech Stack & Layout

- **Frontend:** React 19, Tailwind CSS 4, Vite (runs inside Reddit iFrames)
  - `/src/client/splash.html` (`splash.tsx`): Fast inline feed preview; avoid heavy dependencies here.
  - `/src/client/game.html` (`game.tsx`): Expanded full-game experience.
  - Add any new HTML entrypoint to `devvit.json` under `post.entrypoints`.
- **Backend:** Node.js 24+ serverless environment (Devvit), Hono REST API (`/api/*`, `/internal/*`)
  - `/src/server/index.ts`: Hono app entry point mounting `/api` and `/internal/{menu,form,triggers,...}`.
  - `/src/server/routes/*`, `/src/server/core/*`: Server routes and domain logic using `redis`, `reddit`, `settings`, and `context` from `@devvit/web/server`.
- **Shared:** `/src/shared/*`: Pure domain logic and API payload types shared between client and server (imports in Node-tested paths must include explicit `.ts` extensions because `node --experimental-strip-types` executes tests natively).

---

## Frontend Rules & Devvit Limitations

- Instead of `window.location` or `window.assign`, use `navigateTo` from `@devvit/web/client`.
- `window.alert`: Use `showToast` or `showForm` from `@devvit/web/client`.
- File downloads: Use the Clipboard API paired with `showToast` to confirm.
- Geolocation, camera, microphone, and web notification APIs: Unavailable; do not rely on them.
- Inline `<script>` tags in HTML files: Forbidden; use `<script type="module" src="...">` pointing to a `.ts`/`.tsx` file.

---

## Domain & Persistence Invariants

- **Server-authoritative UTC day:** Never let the client choose user ID, score, ghost sequences, or authoritative day; derive `YYYY-MM-DD` UTC day on the server.
- **Zero data leakage:** Never return the hidden 9-ghost daily field, server bot seed, or raw Reddit user IDs/usernames in public JSON responses.
- **Devvit Redis constraints:** `ZCOUNT` is unsupported; compute shared-tie ranks from a bounded score-frequency hash (`0..81`) updated inside the same `WATCH/MULTI/EXEC` submission transaction.
- **Idempotency & external side effects:** Reserve Reddit post/comment actions atomically in Redis before calling Reddit APIs so retries or crashes never spam duplicate posts or comments.

---

## Commands & Code Style

- **Type-check:** `npm run test:types` (`tsc --build`)
- **Lint:** `npm run lint` (`eslint 'src/**/*.{ts,tsx}'`)
- **Unit tests:** `npm run test:unit` (Node built-in runner; single file: `node --experimental-strip-types --no-warnings=ExperimentalWarning --test src/server/your-file.test.ts`)
- **Build:** `npm run build` (`vite build`)
- **Playtest:** `npm run dev` (`devvit playtest`)

### TypeScript Conventions
- Prefer `type` aliases over `interface`.
- Prefer named exports over default exports.
- Never cast TypeScript types (`as ...`).
- Use Conventional Commits (`type(scope): message`) without local plan/task labels.

Docs: https://developers.reddit.com/docs/llms.txt
