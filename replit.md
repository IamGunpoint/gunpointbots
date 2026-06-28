# GunpointBots Panel

A self-hosted bot hosting panel with user management, file manager, admin controls, node management, and system monitoring.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `SESSION_SECRET` — JWT signing secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Auth: JWT (jsonwebtoken) + bcryptjs
- File uploads: Multer
- File compression: Archiver (zip)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/routes/` — all API route handlers
- `artifacts/api-server/src/middleware/auth.ts` — JWT auth middleware
- `artifacts/api-server/src/lib/settings.ts` — panel settings (registration, hosting, branding)
- `artifacts/api-server/src/lib/audit.ts` — audit log helper
- `lib/db/src/schema/index.ts` — all DB tables (users, servers, nodes, audit logs, etc.)
- `data/bots/<serverId>/files/` — per-server file storage on disk

## API Routes

### Auth (`/api/auth`)
- `POST /login` — login with username+password, returns JWT
- `POST /register` — register (respects `registrationEnabled` setting)
- `POST /logout`, `GET /me`, `POST /change-password`

### Servers (`/api/servers`)
- `GET /` — list servers (admin sees all)
- `POST /` — create server (respects free hosting limits)
- `GET /:id`, `PATCH /:id`, `DELETE /:id` — CRUD (delete also removes disk files)
- `POST /:id/start|stop|restart|kill`
- `POST /:id/suspend` — suspend with optional `durationMinutes` + `reason`
- `POST /:id/unsuspend`
- `POST /:id/kill-proot` — kill all proot processes
- `POST /:id/install-deps` — auto-install npm/pip deps from manifest
- `GET /:id/stats`, `GET /:id/logs`, `POST /:id/send-command`

### File Manager (`/api/servers/:id/files`)
- `GET /` — list files
- `GET /content`, `PUT /content` — read/write file content
- `POST /mkdir`, `DELETE /delete`
- `POST /rename` — rename file/folder
- `POST /move` — move to different directory
- `POST /upload` — multipart upload (up to 50 files, 50MB each)
- `GET /download` — download file or folder as zip
- `POST /compress` — zip selected paths

### Admin (`/api/admin`)
- `GET|POST /users` — list/create users
- `PATCH|DELETE /users/:id` — edit/delete user
- `POST /users/:id/reset-password`
- `POST /users/:userId/servers` — create custom server for specific user with custom specs
- `GET /servers` — list all servers
- `PATCH /servers/:id/specs` — change RAM/CPU/disk/node
- `POST /servers/:id/suspend|unsuspend`
- `DELETE /servers/:id` — force delete
- `GET|PUT /settings` — panel settings (name, favicon, background, registration toggle, hosting toggle, specs, etc.)
- `GET /logs` — audit log with pagination
- `GET /machine-logs?source=system|process|proot` — live machine logs
- `GET /machine-stats` — host CPU/RAM/disk + proot process count
- `POST /kill-all-proot` — kill every proot process on the host
- `GET|POST /nodes` — list/add nodes
- `PATCH|DELETE /nodes/:id` — edit/remove node
- `POST /nodes/:id/ping` — ping node, updates online status

## Panel Settings (via admin)

| Key | Description |
|-----|-------------|
| `panelName` | Panel title shown in UI |
| `faviconUrl` | Favicon URL |
| `logoUrl` | Logo URL |
| `backgroundType` | `video` or `image` |
| `backgroundValue` | URL of video/image |
| `primaryColor` | Primary accent color |
| `accentColor` | Secondary accent color |
| `registrationEnabled` | Allow new user registrations |
| `freeHostingEnabled` | Allow free bot hosting |
| `freeBotsPerUser` | Max bots per free user |
| `freeRamMb` | Default RAM for new servers |
| `freeCpu` | Default CPU for new servers |
| `freeDiskGb` | Default disk for new servers |
| `autoSuspendEnabled` | Enable auto-suspend |
| `autoSuspendIdleMinutes` | Idle time before auto-suspend |
| `maintenanceMode` | Put panel in maintenance mode |

## Architecture decisions

- Server files live on the API server's local disk under `data/bots/<serverId>/files/`. No external object storage needed for first build.
- All settings are stored as key-value rows in the `settings` table — no config files needed.
- JWT is used for auth (Bearer header or cookie). No sessions/Redis needed.
- Nodes table tracks remote machines but SSH execution is not wired — nodes are registry entries for now.
- `proot` processes are killed via `pkill` / `pgrep` directly on the host — works for Replit-based deployments.
- `install-deps` fires `npm install` or `pip install` in the server's file directory and streams output to server logs.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/db run push` after schema changes before restarting the server.
- `archiver` package required for zip download/compress features.
- The `data/bots/` directory is created at runtime by the server — not committed to git.
