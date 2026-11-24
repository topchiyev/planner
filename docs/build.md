# Build Planner

The workspace uses Node.js 24 and npm 11. CI uses Node.js 24.22.3 with npm 11.19.1. From the repository root, run the same check as CI.

```sh
npm run verify:clean
```

This reinstalls dependencies from the root `package-lock.json`, checks the complete dependency tree and its peers, typechecks all four workspaces and the test harness, runs the unit suite, builds the application, and checks the health endpoints. Use `npm run verify` to repeat the checks with dependencies already installed. Contracts produce declarations before the dependent workspaces check their sources, so `npm run typecheck` also works from a fresh dependency install.

| Build output | Path |
| --- | --- |
| Shared contracts and TypeScript declarations | `packages/contracts/dist/index.js` and `index.d.ts` |
| Node backend entry | `apps/backend/dist/main.js` |
| Node `plannerctl` entry | `tools/cli/dist/main.js` |
| Vite frontend entry and bundled assets | `apps/frontend/dist/index.html` and `assets/` |

Check the compiled CLI entry with `node tools/cli/dist/main.js --version`.

When updating dependencies, change their exact pins in the owning workspace manifest and regenerate the root lockfile with `npm install --package-lock-only --strict-peer-deps`. Commit the updated manifests and lockfile together after `npm run verify:clean` succeeds. The backend and frontend builds require no running services.

## Check the health endpoints

After `npm run build`, run `npm run test:health`. The checks start the compiled backend on a temporary loopback port and exercise the injected readiness states in Fastify. They also build the browser health decoder with Vite and parse the real backend responses through it. `npm run verify` includes these checks.

The compiled backend binds to `127.0.0.1:27430` by default. For an isolated process check, run `PLANNER_HTTP_PORT=0 node apps/backend/dist/main.js` and use the loopback address printed on startup. `/health/live` responds with HTTP 200. `/health/ready` returns HTTP 503 until a storage and recovery readiness probe is wired into the main process. Both responses contain `status`, `version`, and a server-generated `requestId`. Send SIGINT or SIGTERM to stop the process.

## Run the workspace shell

For the built shell, run `npm run build`, then start `node apps/backend/dist/main.js`. The compiled backend resolves its browser assets from the built application layout, so the launch command can also use an absolute entry path from another working directory. Browse to the loopback address printed on startup.

For development, start the compiled backend and run `npm run dev` in a separate terminal. Vite serves the frontend and proxies the `/api` and `/health` path segments to `127.0.0.1:27430`. If the owned backend uses a different port, set `PLANNER_PROXY_PORT` to its bound port before starting Vite.

After building, run `npm run test:shell` to check compiled deep links, asset headers, keyboard focus, loading and retry, and the same-origin Vite proxy. The tests use Chromium and temporary loopback ports. Install the matching Playwright browser and system dependencies with `npx playwright install --with-deps chromium` when needed.

## Run the test suites

| Command | What it runs |
| --- | --- |
| `npm test` | Node and `tsx` unit tests for the shared contracts, synthetic workspace and database preflight. |
| `npm run test:integration` | Builds the application, runs the compiled health tests, and discovers `.test.ts` and `.test.mjs` files under `tests/integration/`. |
| `npm run test:e2e` | Builds the application and runs the pinned Playwright Chromium shell suite at 1440×900 and 390×844, with separate production and Vite development listeners. |
| `npm run verify` | Runs typechecking, the unit suite, the build and the health tests. |
| `npm run verify:clean` | Performs a strict lockfile install and peer check before `npm run verify`. |

On Linux, integration checks use MongoDB 8 on `PATH`. They reject supplied MongoDB URIs, host, port, socket and configuration settings before building or starting services. Run the integration command without arguments. The runner creates a new private directory and Unix socket for each database. MongoDB starts with authentication enabled. A temporary user administrator is created through MongoDB’s localhost exception on the private Unix socket, provisions a generated `readWrite` account for the fixture database, and is then removed. The fixture uses the scoped account. Test data and credentials are temporary. Tests check that anonymous and cross-database reads fail and that both the process and data directory are removed after failures.

Test suites share the independently authored `tests/fixtures/planner-workspace.ts` factory. Every call returns fresh records with identical UUIDs and UTC timestamps. The fixture has no external identities or credentials. The removed prior list, the assignee present only on the source board, and the linked target unreadable by the source-board viewer are intentional cases. Browser tests use the same project, board and card IDs in deep links.
