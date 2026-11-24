# Build Planner

The workspace uses Node.js 24 and npm 11. CI uses Node.js 24.22.3 with npm 11.19.1. From the repository root, run the same check as CI.

```sh
npm run verify:clean
```

This reinstalls dependencies from the root `package-lock.json`, checks the complete dependency tree and its peers, typechecks all four workspaces, and builds them. Use `npm run verify` to repeat typechecking and builds with dependencies already installed. Contracts produce declarations before the dependent workspaces check their sources, so `npm run typecheck` also works from a fresh dependency install.

| Build output | Path |
| --- | --- |
| Shared contracts and TypeScript declarations | `packages/contracts/dist/index.js` and `index.d.ts` |
| Node server entry | `apps/server/dist/main.js` |
| Node `plannerctl` entry | `tools/cli/dist/main.js` |
| Vite browser entry and bundled assets | `apps/web/dist/index.html` and `assets/` |

Check the compiled CLI entry with `node tools/cli/dist/main.js --version`.

When updating dependencies, change their exact pins in the owning workspace manifest and regenerate the root lockfile with `npm install --package-lock-only --strict-peer-deps`. Commit the updated manifests and lockfile together after `npm run verify:clean` succeeds. The Node and browser builds require no running services.
