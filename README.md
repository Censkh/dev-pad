# dev-pad

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dev-pad.svg)](https://www.npmjs.com/package/dev-pad)
[![CI](https://img.shields.io/github/actions/workflow/status/Censkh/dev-pad/ci.yml?branch=master)](https://github.com/Censkh/dev-pad/actions/workflows/ci.yml)

One terminal for your local services. Start, restart, and stop processes; follow their
logs; and add project-specific actions using a small TypeScript config.

Works with **Node, Bun, and Deno**. The commands `dev-pad`, `devpad`, and `dpad` are aliases.

## Install and try it

Install in your project:

```sh
npm install --save-dev dev-pad
```

Yarn 1 does not install peer dependencies, so add React too
(`yarn add --dev dev-pad react`) and install with `--ignore-engines`.

Add a `dev-pad.config.ts` using the configuration below, then run `npx dev-pad`.
To try the standalone example first:

```sh
git clone https://github.com/Censkh/dev-pad.git
cd dev-pad
bun install --frozen-lockfile
bun run example:start
```

The [example project](example/README.md) starts a local website and API, with an
optional background worker. No external services are needed. Press `1` then `s`
to switch sites, or `3` then `r` to start the worker. `Ctrl+C` quits.

![dev-pad overview showing numbered services, live status, shared logs, and top-level actions](docs/overview.png)

*Overview with an illustrative Expo configuration and a custom navy theme: running and optional services,
shared logs, and top-level actions.*

## Use in your project

After stopping the example, link the built package into your project:

```sh
# From the dev-pad repository:
bun link
cd ../your-project
bun link dev-pad
```

In your project, create `dev-pad.config.ts`. Replace the commands and ports below
with your project's existing dev commands:

```ts
import { defineConfig } from "dev-pad";

export default defineConfig({
  title: "My project",
  services: [
    {
      id: "web",
      name: "Web",
      command: ["bun", "run", "dev:web"],
      ports: [3000],
      url: "http://localhost:3000",
    },
    {
      id: "api",
      name: "API",
      // Every port the service listens on, including secondary servers it starts.
      ports: [3001, 3002],
      url: "http://localhost:3001/health",
      probe: "http",
    },
    {
      id: "assets",
      name: "Asset watcher",
      command: ["bun", "run", "watch:assets"],
      // Required: say explicitly that this service listens on nothing.
      ports: false,
    },
  ],
});
```

Every service must declare `ports`: a list of the TCP ports it listens on, or `false` for
one that listens on none, such as a file watcher. dev-pad refuses to start a config that
leaves it out.

Run `dev-pad`, or add `"dev": "dev-pad"` to your project's package scripts.
Use `dev-pad --check` to validate the config without starting services.

The aliases use Node. To choose a runtime explicitly from your project directory:

```sh
node ../dev-pad/dist/cli.js
bun ../dev-pad/dist/cli.js
deno run -A ../dev-pad/dist/cli.js
```

Service commands are independent of the dashboard runtime: a Node dashboard can
launch Bun, Deno, Docker, or any other executable.

## Keyboard controls

Press a service's number to select it. **Selection does not start or restart it.**
The highlighted row and action bar show which service you are controlling.

![Expo selected, with start, stop, open, iOS, Android, Escape, and number controls](docs/dashboard.png)

*Selecting Expo shows its actions. Escape clears the selection; numbers switch services.*

| Key | No service selected | Service selected |
| --- | --- | --- |
| `1`–`9` | Select a service | Select another service |
| `r` | Restart active services | Start or restart this service |
| `q` | No action | Stop this service |
| `k` | No action | Stop this service and kill whatever is listening on its ports; highlighted when it is busy |
| `o` | No action | Open this service's URL, if configured |
| `Esc` | No action | Return to the top level |
| `Ctrl+C` | Quit and stop services | Quit and stop services |
| `c` | Clear logs | Clear logs |
| `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | Scroll logs | Scroll logs |

While a service is selected, the log panel shows only that service's output and
the action bar shows **its actions**, **Esc** to clear the selection, and **1–9**
to select another service. Global log and quit shortcuts
still work, but their hints are hidden. Selection
remains after an action. Windows also supports the Ctrl+Break signal for quitting.
With Bun, drag to select and copy log text.

Press `k` to free a selected service's ports when something is still holding them,
such as an orphaned server from an earlier session. dev-pad stops the service if it is
running, then terminates every process with a listening socket on its `ports`
(SIGTERM, then SIGKILL after two seconds). If a listener's parent is a `wrangler`
or `vite` dev process, or a runtime started with that port, the parent is stopped too
so it cannot respawn the listener. Processes that are only connected to the port,
dev-pad itself and its parent processes, container runtimes such as Docker, and SSH
tunnels are never killed. The service's log shows each PID and command killed, or
that nothing was listening. Listeners are found with `lsof` on macOS and Linux and
`netstat` on Windows.

A service that has never started displays **not started**. After it has run and
stopped, it displays **stopped**. Health checks update running services' status:
**starting**, **ready**, **stopping**, or **failed** when its process exits with an error
or its health check fails.

A service that is not running displays **busy** when another process listens on one of
its ports, with the port and the holder's PID and command, for example
`busy · :6110 held by PID 123 (workerd)`. dev-pad checks the ports of every service that
isn't running every few seconds, using one `lsof` (or `netstat`) call for all of them, so
an orphan shows up before you press start, and the status clears once the port is free.
A start refused because a port is held leaves the service **busy** rather than
**failed**. Select it and press `k`, which leads the action bar while the service is busy,
to free the port. dev-pad then starts the service if it is set to start automatically;
otherwise press `r`. Services with `allowOccupiedPort` are never shown as busy.

## Custom actions and live status

Put service-specific actions on that service. Set `global: true` to also expose
an action at the top level. It remains hidden and disabled when a different
service is selected. For example, these Expo actions appear at the top level
and when Expo is selected:

```ts
import { defineConfig, type ServiceContext } from "dev-pad";

async function launch(ctx: ServiceContext, platform: "ios" | "android") {
  ctx.service("mobile").command = ["bun", "run", "expo", `run:${platform}`];
  await ctx.restart("mobile");
}

export default defineConfig({
  title: "My mobile project",
  status: () => [{ label: "Environment", value: "local", tone: "info" }],
  services: [
    {
      id: "mobile",
      name: "Expo",
      cwd: "packages/app",
      command: ["bun", "run", "expo", "start"],
      ports: [8081],
      url: "http://localhost:8081",
      autostart: false,
      terminal: true,
      actions: [
        { key: "i", label: "iOS", global: true, run: ctx => launch(ctx, "ios") },
        { key: "a", label: "Android", global: true, run: ctx => launch(ctx, "android") },
      ],
    },
  ],
});
```

Use `config.actions` for dashboard-wide actions, such as regenerating shared files.
These appear only at the top level. Keys must be unique within each scope;
global action keys must also be unique together. `q` and `c` are reserved.
Custom actions may override the default `r`, `o` or `k` behavior in their scope.

Both `config.status()` and `service.status()` return live items with `label`,
`value`, and an optional `tone`: `muted`, `info`, `success`, `warning`, or `danger`.
Use `config.tick(ctx)` for periodic asynchronous work rather than doing I/O in
`status()`. For site switching, an action can update shared state, while `url`,
`env`, and `status` functions read it on demand.

## Expo

`dev-pad/expo` builds an Expo service with global `i` (iOS) and `a` (Android) actions.
When Metro is running under Bun's PTY, the actions send Metro's own `i`/`a` shortcut.
Otherwise they build and launch the native app with `bun run expo run:ios` or
`bun run expo run:android`, passing the configured Metro port. Set `launch` to
override the build command.

```ts
import { defineConfig } from "dev-pad";
import { expo } from "dev-pad/expo";

export default defineConfig({
  title: "My mobile project",
  services: [
    expo({
      cwd: "packages/app",
      // Also expose the API to Android devices.
      androidPorts: [5101],
      autostart: false,
    }),
  ],
});
```

Defaults: `id` is `mobile`, `name` is `Expo`, `command` is `bun run dev`, Metro's `port` is
8081 (or the first of `ports`) and is always included in `ports`, `url` is Metro's address, and `terminal` is enabled. Other service options pass
through, and your `actions`, `status`, and `tick` are kept alongside the Expo ones.

After the first Android launch, each health check runs `adb reverse` for Metro's port
and `androidPorts` on every connected device, so devices that reconnect keep working.
adb is found through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default SDK location, then
the PATH; set `adb` to override it.

## Configuration reference

Each service needs a unique `id`, a `name`, `ports`, and a `command` or `start` hook.
Commands are argument arrays and do not run through a shell automatically.

| Option | Behavior |
| --- | --- |
| `command` | Executable and arguments for the long-running process |
| `cwd` | Working directory, relative to the project directory |
| `env` | Extra environment variables, or a function returning them; inherits the current environment |
| `url` | URL string or function; enables the selected service's open action |
| `ports` | Required. Every TCP port the service listens on, or `false` for none. Each is checked for an occupying process before startup, and `k` kills their listeners. The first supplies the default TCP health check |
| `port` | Deprecated. Accepted only if it is also listed in `ports`, so one config can run with dev-pad 0.4 and 0.5 |
| `probe` | `"http"` checks the URL, or supply an async function returning a boolean |
| `autostart` | Defaults to enabled; set `false` to start manually |
| `dependsOn` | Service IDs to start first and stop last |
| `terminal` | Enable a Bun PTY for interactive subprocess input on supported platforms |
| `start(ctx)` | Async setup before launching `command`, or a custom lifecycle without a command |
| `stop(ctx)` | Async cleanup after terminating the process |
| `actions` / `status()` | Custom keyboard actions and live status items |
| `tick(ctx)` | Periodic asynchronous work, run on each health check whether or not the service is running |
| `allowOccupiedPort` | Skip the startup port conflict check for all of the service's ports |

Each log source (a service, `supervisor`, or a utility command's source) keeps its
own last 5,000 lines, so a noisy service never pushes out a quiet one's history. Set
`logLimit` on the top-level config to change it. The dashboard renders only the
lines near the visible area and loads older ones as you scroll up.

The CLI defaults the project directory to the config's directory; `config.cwd`
overrides it. Direct calls to `runDashboard(config)` or `createDashboard(config)`
default to the current working directory.

Dependencies finish their start hooks before dependents launch; this does **not**
wait for their health probes to become ready. A dependency starts even if it has
`autostart: false`. Put required readiness waits in its start hook. HTTP health
checks accept responses below 500 and time out after 900 ms.

For Docker or other external resources, use `start` and `stop` hooks with
`ctx.run(...)`. Define cleanup explicitly: stopping a Docker CLI process alone
does not stop its containers. Shutdown stops dependents before dependencies.
On POSIX, dev-pad terminates managed process groups and escalates to SIGKILL after
2.5 seconds. Windows currently terminates direct children only.

If one of a service's ports is occupied on POSIX, dev-pad uses `lsof` to reclaim a listener
only when its working directory belongs to this project. Other occupied ports fail startup;
select the service and press `k` to free them.

### Upgrading from 0.4

Replace each service's `port: 3000` with `ports: [3000]`, add any other ports the service
opens (a second dev server, a fixed inspector port), and set `ports: false` on services
that listen on nothing. To keep one config working with both versions while you upgrade,
keep `port` and add `...{ ports: [3000] }`: the spread passes dev-pad 0.4's types, which do
not know `ports`.

### Action context

| Method | Purpose |
| --- | --- |
| `ctx.start(id)` / `ctx.stop(id)` / `ctx.restart(id)` | Control a service |
| `ctx.restartAll()` | Restart active services, preserving dependency order |
| `ctx.service(id)` | Read or change a service's config before restarting it |
| `ctx.open(url)` | Open an HTTP(S) URL in the default browser |
| `ctx.run(command, options?)` | Run a utility, wait for completion, and return captured output; nonzero exits reject |
| `ctx.log(source, message)` | Append a message to shared logs |
| `ctx.write(id, input)` | Send input to a running service; returns false if it is not running |

`ctx.run` options are `source`, `cwd`, `env`, and `quiet`. Set `quiet: true` to
capture utility output without adding it to the dashboard's logs.

## Runtime and CLI options

| Runtime | Interactive renderer | Subprocess input |
| --- | --- | --- |
| Node 22+ | Portable terminal UI | Pipes |
| Bun 1.3+ | OpenTUI | Pipes, or PTY when `terminal: true` is supported |
| Deno 2.1.5+ | Portable terminal UI | Pipes |

Node loads TypeScript configs through `tsx`; Bun and Deno load them natively.
Use explicit `.ts` extensions for local config imports when running with Deno.
The Deno command uses `-A` for subprocess, environment, file, and network access.

| Flag | Behavior |
| --- | --- |
| `--config path` | Load a specific config |
| `--check` | Load and validate the config without starting services |
| `--plain` | Print prefixed logs without the interactive UI |
| `--help` / `--version` | Print usage or version |

The CLI searches for `dev-pad.config.ts`, `.mts`, `.js`, then `.mjs` in the current
directory. Configs execute code when imported, including with `--check`.
Redirected input or output automatically selects plain logging. In plain mode, busy
ports are reported in the logs, and dev-pad exits once no service is running (each is
failed, stopped, not started or busy). Logs retain the
latest 500 entries and collapse repeated carriage-return spinner frames.

## Contributing

```sh
bun install --frozen-lockfile
bun run check:fix
bun run build
bun run check:example
npm test
npm run test:example
```

`check` and `check:fix` typecheck first, then run Biome. Rebuild after source edits
to update linked projects. For the other runtimes and real terminal tests:

```sh
bun test/smoke.mjs && bun test/lifecycle.mjs
deno task test
python3 test/ui.py
```

The terminal tests require Python 3 on POSIX, plus the runtimes under test. Run
`python3 test/ui.py bun` (or `node` / `deno`) to test one renderer.
GitHub CI checks and builds once, then tests Node 22/24/26, Bun 1.3/latest, and
Deno 2.1.5/latest, including keyboard input, rendering, and process cleanup.

Releases are automated with [Changesets](https://github.com/changesets/changesets).
Add one with `bunx changeset add` when a change should be a minor or major
release; otherwise every push to `master` publishes a patch. Branch pushes publish
prerelease builds under a branch dist-tag (`npm install dev-pad@<branch>`). See
[.changeset/README.md](.changeset/README.md).

[Changelog](CHANGELOG.md) · [MIT license](LICENSE).
