# Changelog

## Unreleased

- Add `dev-pad/expo`, an Expo service helper with iOS/Android launch actions and Android `adb reverse` port forwarding.
- Add a per-service `tick(ctx)` hook for periodic work.
- Build `dist` in `prepare`, so Git and workspace installs work without a separate build.

## 0.2.1

- Press a selected service’s number again to deselect it and return to the dashboard’s global actions.
- Resolve React from the host project so the dashboard and OpenTUI share one React instance.

## 0.2.0

- Show `Cmd+C` instead of `Ctrl+C` in macOS dashboard and CLI help labels.
- Set the process and terminal titles from the dashboard configuration.
- Fix repeated ANSI spinner frames being concatenated in logs, with regression coverage for split chunks and interleaved streams.

## 0.1.0

Initital release
