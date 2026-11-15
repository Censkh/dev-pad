# Changelog

## 0.5.0

### Minor Changes

- c48719e: **Breaking:** every service must now declare `ports`, the TCP ports it listens on, such as `ports: [6110, 6120]` for a service that starts two servers. Use `ports: false` for a service that listens on nothing, such as a file watcher. dev-pad refuses to start a config with a service that leaves `ports` out or gives an empty list, and names the service. `port` still works if it's also listed in `ports`, so one config can run with 0.4 and 0.5. Every declared port is now checked for a conflicting process at startup, not just the first.
  
  Select a service and press `k` to free its ports when something is still holding them, such as an orphaned dev server from an earlier session. dev-pad stops the service if it's running, then kills every process listening on its ports. If the listener's parent is a `wrangler` or `vite` dev process, that parent is stopped too, so it can't respawn the listener. Processes that are only connected to a port, dev-pad itself, Docker and other container runtimes, and SSH tunnels are left alone. The service's log shows each process killed, or that nothing was listening.
  
  Services that aren't running now show **busy** when another process holds one of their ports, with the port and the holder's PID and command (for example `busy · :6110 held by PID 123 (workerd)`). dev-pad checks every few seconds while the dashboard is open, so an orphan shows up before you press start, and the status clears once the port is free. A start refused because of a held port now shows **busy** instead of **failed**, and `k` leads the action bar. Once `k` frees the port, a service set to start automatically starts; otherwise press `r`.
  
  The `dev-pad/expo` helper always includes Metro's port in `ports`.
  
  `dev-pad --version` now prints the installed version instead of always printing 0.1.0.

## 0.4.0

### Minor Changes

- 07ab69b: Logs are kept per service instead of in one shared 500-line buffer, so selecting a quiet service still shows its history after a noisy one has printed a lot. Each source keeps its last 5,000 lines by default; set `logLimit` in the config to change it. Long histories stay responsive: the dashboard renders only the lines near the visible area and loads older ones as you scroll up, and `PgUp`/`PgDn`/`Home`/`End` now scroll the log panel in every runtime.

## 0.3.0

### Minor Changes

- 0559227: Add `dev-pad/expo`, an Expo service helper with iOS/Android launch actions and Android `adb reverse` port forwarding.
- 0559227: Selecting a service now filters the log panel to that service's output. Press the service's number again or `Esc` to return to all logs.
- 0559227: Add a per-service `tick(ctx)` hook for periodic work.

### Patch Changes

- 0559227: Build `dist` in `prepare`, so Git and workspace installs work without a separate build.

## 0.2.1

- Press a selected service’s number again to deselect it and return to the dashboard’s global actions.
- Resolve React from the host project so the dashboard and OpenTUI share one React instance.

## 0.2.0

- Show `Cmd+C` instead of `Ctrl+C` in macOS dashboard and CLI help labels.
- Set the process and terminal titles from the dashboard configuration.
- Fix repeated ANSI spinner frames being concatenated in logs, with regression coverage for split chunks and interleaved streams.

## 0.1.0

Initital release
