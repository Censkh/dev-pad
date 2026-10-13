---
"dev-pad": minor
---

**Breaking:** every service must now declare `ports`, the TCP ports it listens on, such as `ports: [6110, 6120]` for a service that starts two servers. Use `ports: false` for a service that listens on nothing, such as a file watcher. dev-pad refuses to start a config with a service that leaves `ports` out or gives an empty list, and names the service. `port` still works if it's also listed in `ports`, so one config can run with 0.4 and 0.5. Every declared port is now checked for a conflicting process at startup, not just the first.

Select a service and press `k` to free its ports when something is still holding them, such as an orphaned dev server from an earlier session. dev-pad stops the service if it's running, then kills every process listening on its ports. If the listener's parent is a `wrangler` or `vite` dev process, that parent is stopped too, so it can't respawn the listener. Processes that are only connected to a port, dev-pad itself, Docker and other container runtimes, and SSH tunnels are left alone. The service's log shows each process killed, or that nothing was listening.

Services that aren't running now show **busy** when another process holds one of their ports, with the port and the holder's PID and command (for example `busy · :6110 held by PID 123 (workerd)`). dev-pad checks every few seconds while the dashboard is open, so an orphan shows up before you press start, and the status clears once the port is free. A start refused because of a held port now shows **busy** instead of **failed**, and `k` leads the action bar. Once `k` frees the port, a service set to start automatically starts; otherwise press `r`.

The `dev-pad/expo` helper always includes Metro's port in `ports`.

`dev-pad --version` now prints the installed version instead of always printing 0.1.0.
