# runui example

A self-contained project with a website, an API, and an optional worker. It uses
local HTTP servers; no database, Docker, credentials, or external services are needed.

From the runui repository root:

```sh
bun run example:start
```

Or set it up explicitly:

```sh
# From the repository root:
bun install --frozen-lockfile
bun run build
cd example
bun run dev
```

Use `bun run dev:node` for Node or `bun run dev:deno` for Deno. Each service runs
with the same runtime as its dashboard. All service code and config are TypeScript.

Try these controls:

1. Press `1`, then `o` to open the website at `http://127.0.0.1:4600`.
2. Press `s` to switch between Ocean and City. Refresh the browser to see the change.
3. Press `2` to select the API. The website's `s` action is now hidden and disabled.
4. Press `3`, then `r` to start the worker. Press `q` to stop it.
5. Press `Esc` to return to the top level; `s` is available there too.
6. Press `Ctrl+C` to quit and stop all running services.

The API responds at `http://127.0.0.1:4601/health`. Set `RUNUI_EXAMPLE_PORT` to change
the website port; the API uses that port plus one. For example:

```sh
RUNUI_EXAMPLE_PORT=4700 bun run dev
```

The config imports the parent checkout’s built package from `../dist/index.js`.
Rebuild runui after changing the library. In your own project, import from `runui`.

From the repository root, `bun run check:example` checks the example’s types and
`npm run test:example` verifies its HTTP responses, site switching, worker, and cleanup.
