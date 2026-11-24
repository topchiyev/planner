# Build Planner

The workspace uses Node.js 24 and npm 11. CI uses Node.js 24.22.3 with npm 11.19.1. From the repository root, run the same check as CI.

```sh
npm run verify:clean
```

This reinstalls dependencies from the root `package-lock.json`, checks the complete dependency tree and its peers, typechecks and builds all four workspaces, and checks the health endpoints. Use `npm run verify` to repeat the checks with dependencies already installed. Contracts produce declarations before the dependent workspaces check their sources, so `npm run typecheck` also works from a fresh dependency install.

| Build output | Path |
| --- | --- |
| Shared contracts and TypeScript declarations | `packages/contracts/dist/index.js` and `index.d.ts` |
| Node server entry | `apps/server/dist/main.js` |
| Node `plannerctl` entry | `tools/cli/dist/main.js` |
| Vite browser entry and bundled assets | `apps/web/dist/index.html` and `assets/` |

Check the compiled CLI entry with `node tools/cli/dist/main.js --version`.

When updating dependencies, change their exact pins in the owning workspace manifest and regenerate the root lockfile with `npm install --package-lock-only --strict-peer-deps`. Commit the updated manifests and lockfile together after `npm run verify:clean` succeeds. The Node and browser builds require no running services.

## Check the health endpoints

After `npm run build`, run `npm run test:health`. The checks start the compiled server on a temporary loopback port and exercise the injected readiness states in Fastify. They also build the browser health decoder with Vite and parse the real server responses through it. `npm run verify` includes these checks.

The compiled server binds to `127.0.0.1:27430` by default. For an isolated process check, run `PLANNER_HTTP_PORT=0 node apps/server/dist/main.js` and use the loopback address printed on startup. `/health/live` responds with HTTP 200. `/health/ready` returns HTTP 503 until a storage and recovery readiness probe is wired into the main process. Both responses contain `status`, `version`, and a server-generated `requestId`. Send SIGINT or SIGTERM to stop the process.
