# Changelog

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
